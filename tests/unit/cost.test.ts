/**
 * Unit tests for calculateCost and getDefaultPricing.
 * Converted from the legacy tsx script test/cost.test.ts (pre-vitest layout),
 * which sat outside the vitest include globs and never ran in CI.
 */

import { describe, it, expect } from 'vitest';
import { calculateCost, type CostableUsage } from '../../src/utils/cost.js';
import { getDefaultPricing } from '../../src/registry/default-pricing.js';
import type { ModelPricing } from '../../src/types/provider.js';

const PRICING: ModelPricing = {
  inputPerMillion: 3,
  outputPerMillion: 15,
  cacheWritePerMillion: 3.75,
  cacheReadPerMillion: 0.3,
  currency: 'USD',
};

describe('calculateCost', () => {
  it('computes input/output costs at per-million rates', () => {
    const usage: CostableUsage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    const cost = calculateCost(usage, PRICING);
    expect(cost.input).toBeCloseTo(3, 10);
    expect(cost.output).toBeCloseTo(15, 10);
    expect(cost.cacheWrite ?? 0).toBeCloseTo(0, 10);
    expect(cost.cacheRead ?? 0).toBeCloseTo(0, 10);
    expect(cost.total).toBeCloseTo(18, 10);
    expect(cost.currency).toBe('USD');
  });

  it('includes cache write/read components when cache tokens are present', () => {
    const usage: CostableUsage = {
      inputTokens: 100_000,
      outputTokens: 50_000,
      cacheCreationTokens: 200_000,
      cacheReadTokens: 500_000,
    };
    const cost = calculateCost(usage, PRICING);
    expect(cost.input).toBeCloseTo(0.3, 10);
    expect(cost.output).toBeCloseTo(0.75, 10);
    expect(cost.cacheWrite).toBeCloseTo(0.75, 10);
    expect(cost.cacheRead).toBeCloseTo(0.15, 10);
    expect(cost.total).toBeCloseTo(0.3 + 0.75 + 0.75 + 0.15, 10);
  });

  it('returns zero cost for zero tokens', () => {
    expect(calculateCost({ inputTokens: 0, outputTokens: 0 }, PRICING).total).toBeCloseTo(0, 10);
  });

  it('leaves cache costs undefined (not input-rate fallback) when cache rates are missing', () => {
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
    expect(cost.cacheWrite).toBeUndefined();
    expect(cost.cacheRead).toBeUndefined();
    expect(cost.total).toBeCloseTo(0.125 + 0.1, 10);
  });
});

describe('getDefaultPricing', () => {
  it('matches known model ids', () => {
    expect(getDefaultPricing('claude-sonnet-4-6-20250725')).toBeDefined();
    expect(getDefaultPricing('claude-opus-4-20250514')).toBeDefined();
    expect(getDefaultPricing('claude-haiku-4-5-20251001')).toBeDefined();
    expect(getDefaultPricing('gpt-4o-2024-08-06')).toBeDefined();
    expect(getDefaultPricing('gpt-4o-mini-2024-07-18')).toBeDefined();
  });

  it('matches unversioned aliases', () => {
    expect(getDefaultPricing('gpt-4o')).toBeDefined();
  });

  it('returns undefined for unknown models', () => {
    expect(getDefaultPricing('llama-3-70b')).toBeUndefined();
    expect(getDefaultPricing('')).toBeUndefined();
  });

  it('longest-prefix-matches versioned families (opus 4.6 vs opus 4)', () => {
    const opus46 = getDefaultPricing('claude-opus-4-6-20250725');
    const opus4 = getDefaultPricing('claude-opus-4-20250514');
    expect(opus46).toBeDefined();
    expect(opus4).toBeDefined();
    expect(opus46!.inputPerMillion).toBe(15);
    expect(opus4!.inputPerMillion).toBe(15);
  });

  it('carries the expected rate card for sonnet 4.6', () => {
    const sonnet = getDefaultPricing('claude-sonnet-4-6-20250725')!;
    expect(sonnet.inputPerMillion).toBe(3);
    expect(sonnet.outputPerMillion).toBe(15);
    expect(sonnet.cacheWritePerMillion).toBe(3.75);
    expect(sonnet.cacheReadPerMillion).toBe(0.3);
  });
});
