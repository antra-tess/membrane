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
