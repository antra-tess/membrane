import type { ModelPricing, ProviderResponse, UsageCacheConvention } from '../types/provider.js';
import type { CostBreakdown, DetailedUsage, TurnRoundUsage } from '../types/response.js';
import { addCostBreakdowns, calculateCost, warnUnpricedModel } from './cost.js';

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
    if (usage.cacheCreationTokens != null) {
      this.tokens.cacheCreationTokens = (this.tokens.cacheCreationTokens ?? 0) + usage.cacheCreationTokens;
    }
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
