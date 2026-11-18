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

  describe('a long-prompt tier', () => {
    const tiered: ModelPricing = {
      ...PRICING,
      cacheWrite1hPerMillion: 6,
      longPrompt: { overTokens: 100_000, inputPerMillion: 15, outputPerMillion: 75, cacheReadPerMillion: 1.5 },
    };

    it('does not apply at or below the threshold', () => {
      const at = calculateCost({ inputTokens: 100_000, outputTokens: 1_000 }, tiered);
      expect(at.input).toBeCloseTo(0.3, 10);
      expect(at.output).toBeCloseTo(0.015, 10);
    });

    it('applies to the whole request once the prompt is longer than the threshold', () => {
      const over = calculateCost({ inputTokens: 100_001, outputTokens: 1_000 }, tiered);
      expect(over.input).toBeCloseTo(100_001 * 15 / 1_000_000, 10);
      expect(over.output).toBeCloseTo(0.075, 10);
    });

    it('counts cache reads and writes toward the prompt length', () => {
      const usage: CostableUsage = { inputTokens: 1_000, outputTokens: 0, cacheReadTokens: 90_000, cacheCreationTokens: 9_001 };
      const cost = calculateCost(usage, tiered);
      expect(cost.input).toBeCloseTo(1_000 * 15 / 1_000_000, 10);
      expect(cost.cacheRead).toBeCloseTo(90_000 * 1.5 / 1_000_000, 10);
    });

    it('keeps the base rate for anything the tier leaves unset', () => {
      const usage: CostableUsage = { inputTokens: 200_000, outputTokens: 0, cacheCreationTokens: 1_000, cacheCreation1hTokens: 1_000 };
      const cost = calculateCost(usage, tiered);
      // No tier cache-write rates: the 1h write stays at the base $6.
      expect(cost.cacheWrite).toBeCloseTo(0.006, 10);
    });

    it('is ignored by a row without one', () => {
      const cost = calculateCost({ inputTokens: 5_000_000, outputTokens: 0 }, PRICING);
      expect(cost.input).toBeCloseTo(15, 10);
    });
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

  it('prices the four prompt-length-tiered rows from their published tiers', () => {
    const over = (id: string, promptTokens: number) =>
      calculateCost({ inputTokens: promptTokens, outputTokens: 1_000_000 }, getDefaultPricing(id)!);
    // Haiku 5.5: $0.10/$0.50 up to 100k, $0.50/$2.50 over.
    expect(over('claude-haiku-5-5', 100_000).output).toBeCloseTo(0.50, 10);
    expect(over('claude-haiku-5-5', 100_001).output).toBeCloseTo(2.50, 10);
    expect(over('claude-haiku-5-5', 100_001).input).toBeCloseTo(100_001 * 0.50 / 1_000_000, 10);
    // gpt-5.5: 2x input, 1.5x output over 272k; cached input unchanged.
    expect(over('gpt-5.5', 272_000).output).toBeCloseTo(30, 10);
    expect(over('gpt-5.5', 272_001).output).toBeCloseTo(45, 10);
    expect(over('gpt-5.5', 272_001).input).toBeCloseTo(272_001 * 10 / 1_000_000, 10);
    expect(calculateCost({ inputTokens: 272_001, outputTokens: 0, cacheReadTokens: 1_000_000 }, getDefaultPricing('gpt-5.5')!).cacheRead).toBeCloseTo(0.50, 10);
    // Gemini Pro: >200k.
    expect(over('gemini-3.1-pro-preview', 200_001).output).toBeCloseTo(18, 10);
    expect(over('gemini-3.1-pro-preview-customtools', 200_001).output).toBeCloseTo(18, 10);
    expect(over('gemini-2.5-pro', 200_000).output).toBeCloseTo(10, 10);
    expect(over('gemini-2.5-pro', 200_001).output).toBeCloseTo(15, 10);
    expect(over('gemini-2.5-pro', 200_001).input).toBeCloseTo(200_001 * 2.50 / 1_000_000, 10);
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
