import type { ModelPricing, ProviderResponse, UsageCacheConvention } from '../types/provider.js';
import type { CostBreakdown, DetailedUsage, TurnRoundUsage } from '../types/response.js';
import { addCostBreakdowns, calculateCost, warnUnpricedModel } from './cost.js';

/** Adapters whose convention is undeclared warn once each, not once per call. */
const warnedUndeclaredAdapters = new Set<string>();

/**
 * Restate a provider's usage in membrane's single convention: `inputTokens`,
 * `cacheReadTokens` and `cacheCreationTokens` DISJOINT, each priced at its own
 * rate. Adapters reporting `cache-inclusive` counts have the cached span
 * subtracted out of `inputTokens`; the total prompt size stays recoverable as
 * `inputTokens + cacheReadTokens`.
 *
 * Without this, one field name carried two incomparable meanings — the cache
 * hit ratio was unbounded on cache-excluded adapters and cost double-charged
 * the cached span on cache-inclusive ones.
 */
export function normalizeUsageToCacheExcluded(
  usage: ProviderResponse['usage'],
  adapterName: string,
  adapterConvention: UsageCacheConvention | undefined,
): ProviderResponse['usage'] {
  // An adapter that declares nothing is in exactly the state `unknown` names,
  // which is why the interface field is optional and lands here.
  const convention = usage.cacheConvention ?? adapterConvention ?? 'unknown';
  const cacheReadTokens = usage.cacheReadTokens ?? 0;

  if (convention === 'unknown' && cacheReadTokens > 0 && !warnedUndeclaredAdapters.has(adapterName)) {
    warnedUndeclaredAdapters.add(adapterName);
    console.warn(
      `[membrane:usage] adapter "${adapterName}" reported ${cacheReadTokens} cache-read tokens but`
      + ' declares usageCacheConvention "unknown", so membrane cannot tell whether inputTokens'
      + ` (${usage.inputTokens}) already includes them. Counts are passed through unchanged;`
      + ' cost and cache hit ratio may be off by the cached span until the adapter declares'
      + ' "cache-excluded" or "cache-inclusive".'
    );
  }

  if (convention !== 'cache-inclusive' || cacheReadTokens === 0) return usage;

  return { ...usage, inputTokens: Math.max(0, usage.inputTokens - cacheReadTokens) };
}

/**
 * Share of the prompt that was served from cache. Both terms are in the
 * cache-excluded convention, so this is a true ratio in [0, 1] regardless of
 * which provider produced the counts.
 */
export function calculateCacheHitRatio(
  usage: { inputTokens: number; cacheReadTokens?: number },
): number {
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const promptTokens = (usage.inputTokens ?? 0) + cacheReadTokens;
  if (promptTokens === 0) return 0;
  return cacheReadTokens / promptTokens;
}

/** Test seam: the once-per-adapter warn latch is process-wide otherwise. */
export function resetUndeclaredConventionWarnings(): void {
  warnedUndeclaredAdapters.clear();
}

/** Unconvertible provider item types warn once each, not once per response. */
const warnedUnconvertibleProviderItems = new Set<string>();

/**
 * A provider content item membrane cannot normalize is preserved verbatim on a
 * zero-width carrier rather than dropped, but the caller should know its
 * content is invisible to normalized consumers. Once per type, not per item.
 */
export function warnUnconvertibleProviderItem(itemType: string): void {
  if (warnedUnconvertibleProviderItems.has(itemType)) return;
  warnedUnconvertibleProviderItems.add(itemType);
  console.warn(
    `[membrane:content] no normalized ContentBlock for provider item type "${itemType}"`
    + ' — preserving it verbatim as a rawItem carrier so it can be replayed, but its'
    + ' content is not visible to normalized consumers.'
  );
}

/** Test seam: the once-per-type warn latch is process-wide otherwise. */
export function resetUnconvertibleProviderItemWarnings(): void {
  warnedUnconvertibleProviderItems.clear();
}

/**
 * Accumulates one turn's usage ACROSS ROUNDS, pricing each round under the
 * model that actually served it.
 *
 * A routed turn is not billed at one rate: OpenRouter re-picks a provider per
 * call and an alias can resolve to a new snapshot mid-turn. Every streaming
 * loop used to re-resolve pricing when the served model changed and then
 * recompute the WHOLE accumulated usage at that latest rate, retroactively
 * re-billing every earlier round — two 1M-token rounds at 1,000/M then
 * 10,000/M reported 20,000 against a real 11,000.
 *
 * The four tool loops (callback/yielding × XML/native) each carried their own
 * copy of the accumulate-and-price block; this is the single one they share.
 */
export class TurnUsageAccumulator {
  private readonly rounds: TurnRoundUsage[] = [];
  private readonly tokens: DetailedUsage = { inputTokens: 0, outputTokens: 0 };
  private summedCost: CostBreakdown | undefined;
  /** False once any round could not be priced, or two rounds disagreed on currency. */
  private costCoversEveryRound = true;
  private lastServed: string | undefined;

  constructor(
    private readonly requestedModel: string,
    private readonly resolveRoundPricing: (servedModel?: string) => ModelPricing | undefined,
  ) {}

  /**
   * Fold one provider round in, priced at its own served model, and return the
   * turn total as it now stands (a fresh snapshot — callers hand this to
   * `onUsage` and to stream events, and must not see it mutate underneath).
   */
  addRound(servedModel: string | undefined, usage: ProviderResponse['usage']): DetailedUsage {
    if (servedModel) this.lastServed = servedModel;

    this.tokens.inputTokens += usage.inputTokens;
    this.tokens.outputTokens += usage.outputTokens;
    if (usage.cacheCreationTokens) {
      this.tokens.cacheCreationTokens = (this.tokens.cacheCreationTokens ?? 0) + usage.cacheCreationTokens;
    }
    if (usage.cacheReadTokens) {
      this.tokens.cacheReadTokens = (this.tokens.cacheReadTokens ?? 0) + usage.cacheReadTokens;
    }
    // Already inside outputTokens (billed at the output rate) — summed for
    // attribution, never added to the output total.
    if (usage.thinkingTokens) {
      this.tokens.thinkingTokens = (this.tokens.thinkingTokens ?? 0) + usage.thinkingTokens;
    }

    const roundModel = servedModel || this.requestedModel;
    const roundPricing = this.resolveRoundPricing(servedModel);
    const roundCost = roundPricing ? calculateCost(usage, roundPricing) : undefined;
    if (!roundPricing) warnUnpricedModel(roundModel);

    this.rounds.push({
      model: roundModel,
      usage: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        ...(usage.cacheCreationTokens != null ? { cacheCreationTokens: usage.cacheCreationTokens } : {}),
        ...(usage.cacheReadTokens != null ? { cacheReadTokens: usage.cacheReadTokens } : {}),
        ...(usage.thinkingTokens != null ? { thinkingTokens: usage.thinkingTokens } : {}),
        ...(roundCost ? { estimatedCost: roundCost } : {}),
      },
    });

    // A partial sum presented as the turn total is a false number, and an
    // absent cost already means "membrane does not know". So one unpriced (or
    // unsummable) round drops the total rather than under-reporting it; the
    // rounds that WERE priced stay readable in the roster.
    if (!roundCost) {
      this.costCoversEveryRound = false;
    } else if (this.costCoversEveryRound) {
      this.summedCost = this.summedCost ? addCostBreakdowns(this.summedCost, roundCost) : roundCost;
      if (!this.summedCost) this.costCoversEveryRound = false;
    }

    return this.total;
  }

  /** Turn totals: summed tokens, plus the summed per-round cost when every round had rates. */
  get total(): DetailedUsage {
    return {
      ...this.tokens,
      ...(this.costCoversEveryRound && this.summedCost ? { estimatedCost: this.summedCost } : {}),
    };
  }

  /** The model that served the LAST round, or undefined if no round named one. */
  get lastServedModel(): string | undefined {
    return this.lastServed;
  }

  /** One entry per provider round, in order — the audit trail behind the summed total. */
  get perRound(): TurnRoundUsage[] {
    return this.rounds.map((round) => ({ model: round.model, usage: { ...round.usage } }));
  }
}
