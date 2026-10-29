/** The expected prices below are the providers' published list prices. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { calculateCost } from '../../src/utils/cost.js';
import {
  getDefaultPricing,
  PRICING_TABLE,
  DEFAULT_PRICING_LAST_VERIFIED,
  ANTHROPIC_PRICING_LAST_VERIFIED,
  GOOGLE_PRICING_LAST_VERIFIED,
} from '../../src/registry/default-pricing.js';
import type {
  ProviderAdapter,
  ProviderRequest,
  ProviderResponse,
  StreamCallbacks,
  NormalizedRequest,
} from '../../src/types/index.js';

afterEach(() => { vi.restoreAllMocks(); });

describe('default pricing rows match the published price pages (2026-08-25)', () => {
  it('prices claude-opus-4-6 at the current rate, not the retired-Opus-4 rate', () => {
    const pricing = getDefaultPricing('claude-opus-4-6-20260115');
    expect(pricing?.inputPerMillion).toBe(5);
    expect(pricing?.outputPerMillion).toBe(25);
    expect(pricing?.cacheReadPerMillion).toBe(0.50);
  });

  it('still prices the retired claude-opus-4 at its own higher rate', () => {
    const pricing = getDefaultPricing('claude-opus-4-20250514');
    expect(pricing?.inputPerMillion).toBe(15);
    expect(pricing?.outputPerMillion).toBe(75);
  });

  it('prices claude-haiku-4-5 at the current rate', () => {
    const pricing = getDefaultPricing('claude-haiku-4-5-20251001');
    expect(pricing?.inputPerMillion).toBe(1);
    expect(pricing?.outputPerMillion).toBe(5);
  });

  it('prices gemini-2.5-flash at its real rate', () => {
    const pricing = getDefaultPricing('gemini-2.5-flash');
    expect(pricing?.inputPerMillion).toBe(0.30);
    expect(pricing?.outputPerMillion).toBe(2.50);
  });

  it('does not let the gemini-2.5-flash row swallow gemini-2.5-flash-lite', () => {
    const pricing = getDefaultPricing('gemini-2.5-flash-lite');
    expect(pricing?.inputPerMillion).toBe(0.10);
    expect(pricing?.outputPerMillion).toBe(0.40);
  });

  it('prices the gpt-4o snapshot that genuinely costs more', () => {
    expect(getDefaultPricing('gpt-4o-2024-05-13')?.inputPerMillion).toBe(5);
    expect(getDefaultPricing('gpt-4o-2024-05-13')?.outputPerMillion).toBe(15);
    // The later 4o snapshots are priced as plain gpt-4o.
    expect(getDefaultPricing('gpt-4o-2024-08-06')?.inputPerMillion).toBe(2.50);
  });

  it('keeps gpt-4o-mini reachable past the gpt-4o prefix', () => {
    expect(getDefaultPricing('gpt-4o-mini-2024-07-18')?.inputPerMillion).toBe(0.15);
  });
});

describe('Anthropic 5.x rows match the published price page (2026-10-19)', () => {
  const usd = (input: number, output: number, cacheWrite: number, cacheRead: number) => ({
    inputPerMillion: input, outputPerMillion: output, cacheWritePerMillion: cacheWrite,
    cacheReadPerMillion: cacheRead, currency: 'USD', asOf: ANTHROPIC_PRICING_LAST_VERIFIED,
  });
  const rows: Array<[string, ReturnType<typeof usd>]> = [
    ['claude-opus-5-5', usd(4, 20, 5, 0.20)],
    ['claude-sonnet-5-5', usd(2, 10, 2.50, 0.10)],
    ['claude-fable-5-1', usd(10, 50, 12.50, 0.25)],
    ['claude-mythos-5-1', usd(10, 50, 12.50, 0.25)],
    ['claude-mythos-5', usd(10, 50, 12.50, 1)],
    // Its price-page rate for prompts up to 100,000 tokens; the table has no field for the higher rate above that.
    ['claude-haiku-5-5', usd(0.10, 0.50, 0.125, 0.01)],
    ['claude-opus-5', usd(5, 25, 6.25, 0.50)],
    ['claude-sonnet-5', usd(2, 10, 2.50, 0.20)],
    ['claude-fable-5', usd(10, 50, 12.50, 1)],
  ];
  for (const [id, pricing] of rows) {
    it(`prices ${id} at the page's rate`, () => {
      expect(getDefaultPricing(id)).toEqual(pricing);
    });
  }
});

describe('pricing freshness is machine-readable', () => {
  it('exports each section\'s verification date', () => {
    for (const date of [DEFAULT_PRICING_LAST_VERIFIED, ANTHROPIC_PRICING_LAST_VERIFIED, GOOGLE_PRICING_LAST_VERIFIED]) {
      expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('stamps currently-published rows with their section\'s date', () => {
    expect(getDefaultPricing('claude-sonnet-4-6')?.asOf).toBe(ANTHROPIC_PRICING_LAST_VERIFIED);
    expect(getDefaultPricing('gpt-4o-mini')?.asOf).toBe(DEFAULT_PRICING_LAST_VERIFIED);
  });

  it('dates every Anthropic row the page lists to the Anthropic reading, and the retired one to its last publication', () => {
    const anthropic = PRICING_TABLE.filter((row) => row.prefix.startsWith('claude-') && row.pricing !== null);
    for (const row of anthropic) {
      const expected = row.prefix === 'claude-3-5-sonnet' ? '2025-07-01' : ANTHROPIC_PRICING_LAST_VERIFIED;
      expect(`${row.prefix}: ${row.pricing?.asOf}`).toBe(`${row.prefix}: ${expected}`);
    }
    expect(anthropic).not.toEqual([]);
  });

  it('dates a retired row to when its rate was last published, not to today', () => {
    // Claude 3.5 Sonnet is off the price page; $3/$15 per million is the last rate it was published at.
    const retired = getDefaultPricing('claude-3-5-sonnet');

    expect(retired?.asOf).toBe('2025-07-01');
    expect(retired?.asOf).not.toBe(ANTHROPIC_PRICING_LAST_VERIFIED);
  });

  it('surfaces the date on the cost breakdown as pricingAsOf', () => {
    const breakdown = calculateCost(
      { inputTokens: 1_000_000, outputTokens: 0 },
      getDefaultPricing('claude-sonnet-4-6')!,
    );
    expect(breakdown.pricingAsOf).toBe(ANTHROPIC_PRICING_LAST_VERIFIED);
  });

  it('leaves pricingAsOf unset for registry pricing that carries no date', () => {
    const breakdown = calculateCost(
      { inputTokens: 1_000, outputTokens: 0 },
      { inputPerMillion: 1, outputPerMillion: 1, currency: 'USD' },
    );
    expect(breakdown.pricingAsOf).toBeUndefined();
  });
});

function zzAdapter(): ProviderAdapter {
  return {
    name: 'zz-adapter',
    usageCacheConvention: 'cache-excluded',
    supportsModel: () => true,
    async complete(request: ProviderRequest): Promise<ProviderResponse> {
      return {
        content: [{ type: 'text', text: 'zz-reply' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 100, outputTokens: 10 },
        model: request.model,
        rawRequest: request,
        raw: {},
      } as ProviderResponse;
    },
    async stream(request: ProviderRequest, callbacks: StreamCallbacks): Promise<ProviderResponse> {
      callbacks.onChunk('zz-reply');
      return this.complete(request) as Promise<ProviderResponse>;
    },
  };
}

const zzRequestFor = (model: string) => ({
  config: { model, maxTokens: 64 },
  messages: [{ role: 'user', content: [{ type: 'text', text: 'zz-prompt' }] }],
} as unknown as NormalizedRequest);

describe('an unpriced model is distinguishable from a free one', () => {
  it('omits the cost and warns once naming the model', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { });
    const membrane = new Membrane(zzAdapter());

    const response = await membrane.complete(zzRequestFor('zz-unpriced-model-1'));
    await membrane.complete(zzRequestFor('zz-unpriced-model-1'));

    expect(response.details.usage.estimatedCost).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('zz-unpriced-model-1');
  });

  it('stays silent for a model the table prices', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { });
    const membrane = new Membrane(zzAdapter());

    const response = await membrane.complete(zzRequestFor('claude-sonnet-4-6'));

    expect(response.details.usage.estimatedCost?.total).toBeGreaterThan(0);
    expect(warn).not.toHaveBeenCalled();
  });
});
