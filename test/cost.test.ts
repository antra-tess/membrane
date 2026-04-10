/**
 * Tests for calculateCost and getDefaultPricing
 * Run with: npx tsx test/cost.test.ts
 */

import { calculateCost, type CostableUsage } from '../src/utils/cost.js';
import { getDefaultPricing } from '../src/registry/default-pricing.js';
import type { ModelPricing } from '../src/types/provider.js';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`  FAIL: ${message}`);
    failed++;
  } else {
    passed++;
  }
}

function approxEqual(a: number, b: number, epsilon = 1e-10): boolean {
  return Math.abs(a - b) < epsilon;
}

// ============================================================================
// calculateCost
// ============================================================================

console.log('calculateCost:');

{
  const pricing: ModelPricing = {
    inputPerMillion: 3,
    outputPerMillion: 15,
    cacheWritePerMillion: 3.75,
    cacheReadPerMillion: 0.30,
    currency: 'USD',
  };

  // Basic calculation
  const usage: CostableUsage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
  const cost = calculateCost(usage, pricing);
  assert(approxEqual(cost.input, 3), 'input cost: 1M tokens @ $3/MTok = $3');
  assert(approxEqual(cost.output, 15), 'output cost: 1M tokens @ $15/MTok = $15');
  assert(cost.cacheWrite === undefined || approxEqual(cost.cacheWrite, 0), 'cache write 0 when no cache tokens');
  assert(cost.cacheRead === undefined || approxEqual(cost.cacheRead, 0), 'cache read 0 when no cache tokens');
  assert(approxEqual(cost.total, 18), 'total = input + output');
  assert(cost.currency === 'USD', 'currency preserved');

  // With cache tokens
  const usageWithCache: CostableUsage = {
    inputTokens: 100_000,
    outputTokens: 50_000,
    cacheCreationTokens: 200_000,
    cacheReadTokens: 500_000,
  };
  const costWithCache = calculateCost(usageWithCache, pricing);
  assert(approxEqual(costWithCache.input, 0.3), 'input: 100k @ $3/MTok');
  assert(approxEqual(costWithCache.output, 0.75), 'output: 50k @ $15/MTok');
  assert(approxEqual(costWithCache.cacheWrite!, 0.75), 'cache write: 200k @ $3.75/MTok');
  assert(approxEqual(costWithCache.cacheRead!, 0.15), 'cache read: 500k @ $0.30/MTok');
  assert(approxEqual(costWithCache.total, 0.3 + 0.75 + 0.75 + 0.15), 'total sums all components');

  // Zero tokens
  const zero: CostableUsage = { inputTokens: 0, outputTokens: 0 };
  const zeroCost = calculateCost(zero, pricing);
  assert(approxEqual(zeroCost.total, 0), 'zero tokens = zero cost');
}

// Missing cache pricing fields — should return undefined, not fall back to input rate
{
  const pricingNoCacheRates: ModelPricing = {
    inputPerMillion: 1.25,
    outputPerMillion: 10,
    currency: 'USD',
  };
  const usage: CostableUsage = {
    inputTokens: 100_000,
    outputTokens: 10_000,
    cacheCreationTokens: 50_000,
    cacheReadTokens: 200_000,
  };
  const cost = calculateCost(usage, pricingNoCacheRates);
  assert(cost.cacheWrite === undefined, 'cache write undefined when no cacheWritePerMillion');
  assert(cost.cacheRead === undefined, 'cache read undefined when no cacheReadPerMillion');
  assert(approxEqual(cost.total, 0.125 + 0.1), 'total excludes unknown cache costs');
}

// ============================================================================
// getDefaultPricing
// ============================================================================

console.log('getDefaultPricing:');

// Known models
assert(getDefaultPricing('claude-sonnet-4-6-20250725') !== undefined, 'claude-sonnet-4-6 matched');
assert(getDefaultPricing('claude-opus-4-20250514') !== undefined, 'claude-opus-4 matched');
assert(getDefaultPricing('claude-haiku-4-5-20251001') !== undefined, 'claude-haiku-4-5 matched');
assert(getDefaultPricing('gpt-4o-2024-08-06') !== undefined, 'gpt-4o matched');
assert(getDefaultPricing('gpt-4o-mini-2024-07-18') !== undefined, 'gpt-4o-mini matched');

// Unknown models
assert(getDefaultPricing('llama-3-70b') === undefined, 'unknown model returns undefined');
assert(getDefaultPricing('') === undefined, 'empty string returns undefined');

// Longest prefix match — claude-opus-4-6 should match over claude-opus-4
{
  const opus46 = getDefaultPricing('claude-opus-4-6-20250725');
  const opus4 = getDefaultPricing('claude-opus-4-20250514');
  assert(opus46 !== undefined && opus4 !== undefined, 'both opus variants matched');
  // Both have same pricing currently, but the point is they match different entries
  assert(opus46!.inputPerMillion === 15, 'opus 4.6 pricing correct');
  assert(opus4!.inputPerMillion === 15, 'opus 4 pricing correct');
}

// Verify specific pricing values
{
  const sonnet = getDefaultPricing('claude-sonnet-4-6-20250725')!;
  assert(sonnet.inputPerMillion === 3, 'sonnet input: $3/MTok');
  assert(sonnet.outputPerMillion === 15, 'sonnet output: $15/MTok');
  assert(sonnet.cacheWritePerMillion === 3.75, 'sonnet cache write: $3.75/MTok');
  assert(sonnet.cacheReadPerMillion === 0.30, 'sonnet cache read: $0.30/MTok');
}

// ============================================================================
// Summary
// ============================================================================

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
