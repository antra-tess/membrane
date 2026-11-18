import type { CostBreakdown } from '../types/response.js';
import type { ModelPricing } from '../types/provider.js';

export interface CostableUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number;
  /** Of cacheCreationTokens, those written with a 1-hour TTL (see CallUsage). */
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

export function resetUnpricedModelWarnings(): void {
  warnedUnpricedModels.clear();
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
 * Cache writes at two rates: the 1-hour-TTL tokens the provider reported at
 * the 1-hour rate, the rest at the short-TTL rate. A pricing row without a
 * 1-hour rate prices every write at the short rate, as before. A 1-hour count
 * larger than the total (a provider report that contradicts itself) is clamped
 * to the total rather than billing tokens that were not written.
 */
function cacheWriteCost(usage: CostableUsage, shortRate: number, oneHourRate: number | undefined): number {
  const total = usage.cacheCreationTokens ?? 0;
  const oneHour = Math.min(Math.max(usage.cacheCreation1hTokens ?? 0, 0), total);
  const short = total - oneHour;
  return (short * shortRate + oneHour * (oneHourRate ?? shortRate)) / 1_000_000;
}

/** Every input token the request was billed for: fresh, cache-written and cache-read. */
export function promptTokens(usage: CostableUsage): number {
  return usage.inputTokens + (usage.cacheCreationTokens ?? 0) + (usage.cacheReadTokens ?? 0);
}

/**
 * The rate card this request is billed at: the row's base rates, or, where
 * the row has a long-prompt tier and the prompt is longer than its threshold,
 * the tier's rates with any it leaves unset taken from the base.
 */
export function ratesFor(usage: CostableUsage, pricing: ModelPricing): ModelPricing {
  const tier = pricing.longPrompt;
  if (!tier || !(promptTokens(usage) > tier.overTokens)) return pricing;
  return {
    ...pricing,
    inputPerMillion: tier.inputPerMillion ?? pricing.inputPerMillion,
    outputPerMillion: tier.outputPerMillion ?? pricing.outputPerMillion,
    ...(tier.cacheWritePerMillion != null ? { cacheWritePerMillion: tier.cacheWritePerMillion } : {}),
    ...(tier.cacheWrite1hPerMillion != null ? { cacheWrite1hPerMillion: tier.cacheWrite1hPerMillion } : {}),
    ...(tier.cacheReadPerMillion != null ? { cacheReadPerMillion: tier.cacheReadPerMillion } : {}),
  };
}

export function calculateCost(usage: CostableUsage, basePricing: ModelPricing): CostBreakdown {
  const pricing = ratesFor(usage, basePricing);
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
