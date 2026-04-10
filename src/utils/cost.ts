import type { CostBreakdown } from '../types/response.js';
import type { ModelPricing } from '../types/provider.js';

export interface CostableUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
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
  };
}
