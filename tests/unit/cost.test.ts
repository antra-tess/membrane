import { describe, it, expect } from 'vitest';
import { calculateCost, type CostableUsage } from '../../src/utils/cost.js';
import { getDefaultPricing, PRICING_TABLE } from '../../src/registry/default-pricing.js';
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

  it('prices 1-hour cache writes at the 1-hour rate and the rest at the 5-minute rate', () => {
    const pricing: ModelPricing = { ...PRICING, cacheWrite1hPerMillion: 6 };
    const usage: CostableUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 300_000,
      cacheCreation1hTokens: 200_000,
    };
    const cost = calculateCost(usage, pricing);
    // 100k × $3.75 + 200k × $6
    expect(cost.cacheWrite).toBeCloseTo(0.375 + 1.2, 10);
    expect(cost.total).toBeCloseTo(0.375 + 1.2, 10);
  });

  it('prices every write at the 5-minute rate when the usage has no TTL split', () => {
    const pricing: ModelPricing = { ...PRICING, cacheWrite1hPerMillion: 6 };
    const cost = calculateCost({ inputTokens: 0, outputTokens: 0, cacheCreationTokens: 300_000 }, pricing);
    expect(cost.cacheWrite).toBeCloseTo(1.125, 10);
  });

  it('falls back to the 5-minute rate for 1-hour writes when the row has no 1-hour rate', () => {
    const usage: CostableUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 300_000,
      cacheCreation1hTokens: 300_000,
    };
    expect(calculateCost(usage, PRICING).cacheWrite).toBeCloseTo(1.125, 10);
  });

  it('never bills more 1-hour writes than were written', () => {
    const pricing: ModelPricing = { ...PRICING, cacheWrite1hPerMillion: 6 };
    const usage: CostableUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 100_000,
      cacheCreation1hTokens: 250_000,
    };
    // Clamped to the 100k total, all at the 1-hour rate.
    expect(calculateCost(usage, pricing).cacheWrite).toBeCloseTo(0.6, 10);
    const negative: CostableUsage = { ...usage, cacheCreation1hTokens: -5 };
    expect(calculateCost(negative, pricing).cacheWrite).toBeCloseTo(0.375, 10);
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
    // Anthropic's price page lists Opus 4.6 at 5/25 and the retired Opus 4 at 15/75.
    const opus46 = getDefaultPricing('claude-opus-4-6-20250725');
    const opus4 = getDefaultPricing('claude-opus-4-20250514');
    expect(opus46).toBeDefined();
    expect(opus4).toBeDefined();
    expect(opus46!.inputPerMillion).toBe(5);
    expect(opus4!.inputPerMillion).toBe(15);
  });

  it('carries the expected rate card for sonnet 4.6', () => {
    const sonnet = getDefaultPricing('claude-sonnet-4-6-20250725')!;
    expect(sonnet.inputPerMillion).toBe(3);
    expect(sonnet.outputPerMillion).toBe(15);
    expect(sonnet.cacheWritePerMillion).toBe(3.75);
    expect(sonnet.cacheWrite1hPerMillion).toBe(6);
    expect(sonnet.cacheReadPerMillion).toBe(0.3);
  });

  it('gives every Anthropic row a 1-hour write rate of twice its input rate', () => {
    // The one row the page never listed with a 1-hour column.
    const noPageFigure = new Set(['claude-3-5-sonnet']);
    const claudeRows = PRICING_TABLE.filter((row) => row.prefix.startsWith('claude-') && row.pricing !== null);
    expect(claudeRows.length).toBeGreaterThan(20);
    for (const row of claudeRows) {
      const pricing = row.pricing!;
      expect(pricing.cacheWritePerMillion, row.prefix).toBeCloseTo(pricing.inputPerMillion * 1.25, 10);
      if (noPageFigure.has(row.prefix)) {
        expect(pricing.cacheWrite1hPerMillion, row.prefix).toBeUndefined();
      } else {
        expect(pricing.cacheWrite1hPerMillion, row.prefix).toBeCloseTo(pricing.inputPerMillion * 2, 10);
      }
    }
  });
});
