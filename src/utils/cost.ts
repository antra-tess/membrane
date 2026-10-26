import type { CostBreakdown } from '../types/response.js';
import type { ModelPricing } from '../types/provider.js';

export interface CostableUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number;
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
