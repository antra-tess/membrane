/**
 * The default pricing table is a fallback that callers bill against, so a
 * stale row is a wrong number rather than a missing one. Its header claimed
 * "Last updated: 2025-07" while carrying rows for models that did not exist
 * then, there was no machine-readable freshness signal, and an unpriced model
 * was indistinguishable from a free one — `getDefaultPricing` returned
 * undefined and `estimateCost` quietly omitted the cost.
 *
 * The expectations below were read off the providers' public price pages on
 * 2026-08-25; each is a row the table got wrong or was missing.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { calculateCost } from '../../src/utils/cost.js';
import {
  getDefaultPricing,
  DEFAULT_PRICING_LAST_VERIFIED,
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

describe('pricing freshness is machine-readable', () => {
  it('exports a table-level verification date', () => {
    expect(DEFAULT_PRICING_LAST_VERIFIED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('stamps every default row with that date', () => {
    expect(getDefaultPricing('claude-sonnet-4-6')?.asOf).toBe(DEFAULT_PRICING_LAST_VERIFIED);
  });

  it('surfaces the date on the cost breakdown as pricingAsOf', () => {
    const breakdown = calculateCost(
      { inputTokens: 1_000_000, outputTokens: 0 },
      getDefaultPricing('claude-sonnet-4-6')!,
    );
    expect(breakdown.pricingAsOf).toBe(DEFAULT_PRICING_LAST_VERIFIED);
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
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* silence */ });
    const membrane = new Membrane(zzAdapter());

    const response = await membrane.complete(zzRequestFor('zz-unpriced-model-1'));
    await membrane.complete(zzRequestFor('zz-unpriced-model-1'));

    expect(response.details.usage.estimatedCost).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('zz-unpriced-model-1');
  });

  it('stays silent for a model the table prices', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* silence */ });
    const membrane = new Membrane(zzAdapter());

    const response = await membrane.complete(zzRequestFor('claude-sonnet-4-6'));

    expect(response.details.usage.estimatedCost?.total).toBeGreaterThan(0);
    expect(warn).not.toHaveBeenCalled();
  });
});
