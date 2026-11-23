import type { CostBreakdown } from '../types/response.js';
import type { ModelPricing } from '../types/provider.js';

export interface CostableUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number;
  /** Of cacheCreationTokens, those written with the provider's longer TTL: Anthropic's 1 hour, OpenAI's 12 hours (see CallUsage). */
  cacheCreation1hTokens?: number;
  cacheReadTokens?: number;
}

const warnedUnpricedModels = new Set<string>();

export function warnUnpricedModel(modelId: string): void {
  if (warnedUnpricedModels.has(modelId)) return;
  warnedUnpricedModels.add(modelId);
  console.warn(
    `[membrane:cost] no pricing for model "${modelId}" — neither the configured`
    + ' ModelRegistry nor the built-in table has rates for it, so estimatedCost will be'
    + ' omitted (this is NOT a cost of zero). Add it to your registry to get cost estimates.'
  );
}

const warnedUnpricedWrites = new Set<string>();

/** A row without `cacheWritePerMillion` prices no cache write (by design, no input-rate fallback); said once per model, so the silence isn't silent. */
export function warnUnpricedCacheWrite(modelId: string): void {
  if (warnedUnpricedWrites.has(modelId)) return;
  warnedUnpricedWrites.add(modelId);
  console.warn(
    `[membrane:cost] model "${modelId}" wrote to the prompt cache, but its pricing row has no`
    + ' cacheWritePerMillion, so estimatedCost leaves the written tokens out (this is NOT a cost of'
    + ' zero). Add a write rate to the row: the input rate where the provider charges nothing extra.'
  );
}

export function resetUnpricedModelWarnings(): void {
  warnedUnpricedModels.clear();
  warnedUnpricedWrites.clear();
}

export function addCostBreakdowns(
  a: CostBreakdown,
  b: CostBreakdown,
): CostBreakdown | undefined {
  if (a.currency !== b.currency) return undefined;

  const cacheWrite = a.cacheWrite != null || b.cacheWrite != null
    ? (a.cacheWrite ?? 0) + (b.cacheWrite ?? 0)
    : undefined;
  const cacheRead = a.cacheRead != null || b.cacheRead != null
    ? (a.cacheRead ?? 0) + (b.cacheRead ?? 0)
    : undefined;
  const oldestAsOf = a.pricingAsOf && b.pricingAsOf
    ? (a.pricingAsOf < b.pricingAsOf ? a.pricingAsOf : b.pricingAsOf)
    : undefined;

  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheWrite,
    cacheRead,
    total: a.total + b.total,
    currency: a.currency,
    ...(oldestAsOf ? { pricingAsOf: oldestAsOf } : {}),
  };
}

/**
 * Cache writes at two rates: the long-TTL tokens the provider reported
 * (Anthropic's 1-hour, OpenAI's 12-hour) at the long-TTL rate, the rest at
 * the short-TTL rate. A pricing row without a long-TTL rate prices every
 * write at the short rate, as before. A long-TTL count
 * larger than the total (a provider report that contradicts itself) is clamped
 * to the total rather than billing tokens that were not written.
 */
function cacheWriteCost(usage: CostableUsage, shortRate: number, oneHourRate: number | undefined): number {
  const total = usage.cacheCreationTokens ?? 0;
  const oneHour = Math.min(Math.max(usage.cacheCreation1hTokens ?? 0, 0), total);
  const short = total - oneHour;
  return (short * shortRate + oneHour * (oneHourRate ?? shortRate)) / 1_000_000;
}

export function calculateCost(usage: CostableUsage, pricing: ModelPricing): CostBreakdown {
  const input = usage.inputTokens * pricing.inputPerMillion / 1_000_000;
  const output = usage.outputTokens * pricing.outputPerMillion / 1_000_000;
  const cacheWrite = pricing.cacheWritePerMillion != null
    ? cacheWriteCost(usage, pricing.cacheWritePerMillion, pricing.cacheWrite1hPerMillion)
    : undefined;
  const cacheRead = pricing.cacheReadPerMillion != null
    ? (usage.cacheReadTokens ?? 0) * pricing.cacheReadPerMillion / 1_000_000
    : undefined;

  return {
    input,
    output,
    cacheWrite,
    cacheRead,
    total: input + output + (cacheWrite ?? 0) + (cacheRead ?? 0),
    currency: pricing.currency,
    ...(pricing.asOf ? { pricingAsOf: pricing.asOf } : {}),
  };
}
