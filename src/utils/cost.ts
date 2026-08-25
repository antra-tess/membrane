import type { CostBreakdown } from '../types/response.js';
import type { ModelPricing } from '../types/provider.js';

export interface CostableUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
}

/** Unpriced models warn once each, not once per call. */
const warnedUnpricedModels = new Set<string>();

/**
 * Say once, per model, that membrane has no rates for it — so an omitted
 * `estimatedCost` reads as "unknown" rather than "free" to a caller who only
 * ever sees the absence.
 */
export function warnUnpricedModel(modelId: string): void {
  if (warnedUnpricedModels.has(modelId)) return;
  warnedUnpricedModels.add(modelId);
  console.warn(
    `[membrane:cost] no pricing for model "${modelId}" — neither the configured`
    + ' ModelRegistry nor the built-in table has rates for it, so estimatedCost will be'
    + ' omitted (this is NOT a cost of zero). Add it to your registry to get cost estimates.'
  );
}

/** Test seam: the once-per-model warn latch is process-wide otherwise. */
export function resetUnpricedModelWarnings(): void {
  warnedUnpricedModels.clear();
}

/**
 * Add two breakdowns that may have been priced at DIFFERENT rates — the
 * multi-round case, where each round is priced under the model that served it
 * and the turn total is their sum.
 *
 * `pricingAsOf` takes the OLDER of the two: a total is only as fresh as its
 * stalest input, and a round whose source vouches for NO date is stalest of
 * all — one unstamped round leaves the sum unstamped. A currency mismatch is
 * not summable at all (the caller's
 * registry priced two rounds in different currencies and membrane has no rate
 * to convert with), so it returns undefined rather than adding dollars to
 * euros — an absent cost says "membrane does not know", which is true.
 */
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

export function calculateCost(usage: CostableUsage, pricing: ModelPricing): CostBreakdown {
  const input = usage.inputTokens * pricing.inputPerMillion / 1_000_000;
  const output = usage.outputTokens * pricing.outputPerMillion / 1_000_000;
  const cacheWrite = pricing.cacheWritePerMillion != null
    ? (usage.cacheCreationTokens ?? 0) * pricing.cacheWritePerMillion / 1_000_000
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
