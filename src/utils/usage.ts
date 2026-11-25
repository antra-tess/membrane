import type { ModelPricing, ProviderResponse, UsageCacheConvention } from '../types/provider.js';
import type { CostBreakdown, DetailedUsage, TurnRoundUsage } from '../types/response.js';
import { addCostBreakdowns, calculateCost, warnUnpricedCacheWrite, warnUnpricedModel } from './cost.js';

const warnedUndeclaredAdapters = new Set<string>();

export function normalizeUsageToCacheExcluded(
  usage: ProviderResponse['usage'],
  adapterName: string,
  adapterConvention: UsageCacheConvention | undefined,
): ProviderResponse['usage'] {
  const convention = usage.cacheConvention ?? adapterConvention ?? 'unknown';
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const cacheCreationTokens = usage.cacheCreationTokens ?? 0;

  if (
    convention === 'unknown'
    && (cacheReadTokens > 0 || cacheCreationTokens > 0)
    && !warnedUndeclaredAdapters.has(adapterName)
  ) {
    warnedUndeclaredAdapters.add(adapterName);
    console.warn(
      `[membrane:usage] adapter "${adapterName}" reported ${cacheReadTokens} cache-read and`
      + ` ${cacheCreationTokens} cache-write tokens but`
      + ' declares usageCacheConvention "unknown", so membrane cannot tell whether inputTokens'
      + ` (${usage.inputTokens}) already includes them. Counts are passed through unchanged;`
      + ' cost and cache hit ratio may be off by the cached span until the adapter declares'
      + ' "cache-excluded" or "cache-inclusive".'
    );
  }

  if (convention !== 'cache-inclusive' || (cacheReadTokens === 0 && cacheCreationTokens === 0)) return usage;

  return { ...usage, inputTokens: Math.max(0, usage.inputTokens - cacheReadTokens - cacheCreationTokens) };
}

/**
 * The long-TTL share (Anthropic's 1-hour, OpenAI's 12-hour writes) of two
 * cache-write totals summed. A part's share is known
 * when it reports one, or when it wrote nothing; the sum's share is known only
 * when both parts' are, so a round that wrote with no TTL split makes the
 * aggregate's split unknown (absent) rather than counting its writes as short.
 * Absent when neither part reported a share.
 */
export function sumCacheCreation1h(
  a: { cacheCreationTokens?: number; cacheCreation1hTokens?: number },
  b: { cacheCreationTokens?: number; cacheCreation1hTokens?: number },
): { cacheCreation1hTokens?: number } {
  if (a.cacheCreation1hTokens == null && b.cacheCreation1hTokens == null) return {};
  const known = (p: { cacheCreationTokens?: number; cacheCreation1hTokens?: number }) =>
    p.cacheCreation1hTokens != null || !((p.cacheCreationTokens ?? 0) > 0);
  if (!known(a) || !known(b)) return {};
  return { cacheCreation1hTokens: (a.cacheCreation1hTokens ?? 0) + (b.cacheCreation1hTokens ?? 0) };
}

/**
 * The 1-hour share of a response's cache writes, from the
 * `usage.cache_creation` breakdown Anthropic reports beside the total — and
 * that an Anthropic-shaped usage from a router may carry. No breakdown, or a
 * breakdown without the 1-hour member → no field: the share is unknown, not
 * zero.
 */
export function cacheCreation1h(cacheCreation: unknown): { cacheCreation1hTokens?: number } {
  if (!cacheCreation || typeof cacheCreation !== 'object') return {};
  const oneHour = (cacheCreation as Record<string, unknown>).ephemeral_1h_input_tokens;
  return typeof oneHour === 'number' ? { cacheCreation1hTokens: oneHour } : {};
}

export function calculateCacheHitRatio(
  usage: { inputTokens: number; cacheCreationTokens?: number; cacheReadTokens?: number },
): number {
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const promptTokens = (usage.inputTokens ?? 0) + (usage.cacheCreationTokens ?? 0) + cacheReadTokens;
  if (promptTokens === 0) return 0;
  return cacheReadTokens / promptTokens;
}

export function resetUndeclaredConventionWarnings(): void {
  warnedUndeclaredAdapters.clear();
}

const warnedUnconvertibleProviderItems = new Set<string>();

export function warnUnconvertibleProviderItem(itemType: string): void {
  if (warnedUnconvertibleProviderItems.has(itemType)) return;
  warnedUnconvertibleProviderItems.add(itemType);
  console.warn(
    `[membrane:content] no normalized ContentBlock for provider item type "${itemType}"`
    + ' — preserving it verbatim as a rawItem carrier so it can be replayed, but its'
    + ' content is not visible to normalized consumers.'
  );
}

export function resetUnconvertibleProviderItemWarnings(): void {
  warnedUnconvertibleProviderItems.clear();
}

export function unreportedUsage(input: unknown, output: unknown): { unreportedUsage?: Array<'inputTokens' | 'outputTokens'> } {
  const missing: Array<'inputTokens' | 'outputTokens'> = [];
  if (typeof input !== 'number') missing.push('inputTokens');
  if (typeof output !== 'number') missing.push('outputTokens');
  return missing.length > 0 ? { unreportedUsage: missing } : {};
}

/**
 * OpenRouter re-picks a provider per call, and an alias can resolve to a new
 * snapshot mid-turn, so a turn's rounds can be priced at different rates.
 */
export class TurnUsageAccumulator {
  private readonly rounds: TurnRoundUsage[] = [];
  private readonly tokens: DetailedUsage = { inputTokens: 0, outputTokens: 0 };
  private summedCost: CostBreakdown | undefined;
  private costCoversEveryRound = true;
  private lastServed: string | undefined;

  constructor(
    private readonly requestedModel: string,
    private readonly resolveRoundPricing: (servedModel?: string) => ModelPricing | undefined,
  ) {}

  addRound(servedModel: string | undefined, usage: ProviderResponse['usage']): DetailedUsage {
    if (servedModel) this.lastServed = servedModel;

    this.tokens.inputTokens += usage.inputTokens;
    this.tokens.outputTokens += usage.outputTokens;
    const split = sumCacheCreation1h(this.tokens, usage);
    if (usage.cacheCreationTokens != null) {
      this.tokens.cacheCreationTokens = (this.tokens.cacheCreationTokens ?? 0) + usage.cacheCreationTokens;
    }
    delete this.tokens.cacheCreation1hTokens;
    if (split.cacheCreation1hTokens != null) this.tokens.cacheCreation1hTokens = split.cacheCreation1hTokens;
    if (usage.cacheReadTokens != null) {
      this.tokens.cacheReadTokens = (this.tokens.cacheReadTokens ?? 0) + usage.cacheReadTokens;
    }
    if (usage.thinkingTokens != null) {
      this.tokens.thinkingTokens = (this.tokens.thinkingTokens ?? 0) + usage.thinkingTokens;
    }

    const roundModel = servedModel || this.requestedModel;
    const roundPricing = this.resolveRoundPricing(servedModel);
    const roundCost = roundPricing ? calculateCost(usage, roundPricing) : undefined;
    if (!roundPricing) warnUnpricedModel(roundModel);
    else if ((usage.cacheCreationTokens ?? 0) > 0 && roundPricing.cacheWritePerMillion == null) warnUnpricedCacheWrite(roundModel);

    this.rounds.push({
      model: roundModel,
      usage: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        ...(usage.cacheCreationTokens != null ? { cacheCreationTokens: usage.cacheCreationTokens } : {}),
        ...(usage.cacheCreation1hTokens != null ? { cacheCreation1hTokens: usage.cacheCreation1hTokens } : {}),
        ...(usage.cacheReadTokens != null ? { cacheReadTokens: usage.cacheReadTokens } : {}),
        ...(usage.thinkingTokens != null ? { thinkingTokens: usage.thinkingTokens } : {}),
        ...(roundCost ? { estimatedCost: roundCost } : {}),
      },
    });

    if (!roundCost) {
      this.costCoversEveryRound = false;
    } else if (this.costCoversEveryRound) {
      this.summedCost = this.summedCost ? addCostBreakdowns(this.summedCost, roundCost) : roundCost;
      if (!this.summedCost) this.costCoversEveryRound = false;
    }

    return this.total;
  }

  get total(): DetailedUsage {
    return {
      ...this.tokens,
      ...(this.costCoversEveryRound && this.summedCost ? { estimatedCost: this.summedCost } : {}),
    };
  }

  get lastServedModel(): string | undefined {
    return this.lastServed;
  }

  get lastRound(): TurnRoundUsage | undefined {
    const round = this.rounds[this.rounds.length - 1];
    return round ? { model: round.model, usage: { ...round.usage } } : undefined;
  }

  get perRound(): TurnRoundUsage[] {
    return this.rounds.map((round) => ({ model: round.model, usage: { ...round.usage } }));
  }
}
