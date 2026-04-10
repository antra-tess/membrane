import type { DetailedUsage, CostBreakdown } from '../types/response.js';
import type { ModelPricing } from '../types/provider.js';

export function calculateCost(usage: DetailedUsage, pricing: ModelPricing): CostBreakdown {
  const input = usage.inputTokens * pricing.inputPerMillion / 1_000_000;
  const output = usage.outputTokens * pricing.outputPerMillion / 1_000_000;
  const cacheWrite = (usage.cacheCreationTokens ?? 0) * (pricing.cacheWritePerMillion ?? pricing.inputPerMillion) / 1_000_000;
  const cacheRead = (usage.cacheReadTokens ?? 0) * (pricing.cacheReadPerMillion ?? pricing.inputPerMillion) / 1_000_000;

  return {
    input,
    output,
    cacheWrite,
    cacheRead,
    total: input + output + cacheWrite + cacheRead,
    currency: pricing.currency,
  };
}
