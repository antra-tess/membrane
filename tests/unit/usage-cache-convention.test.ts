/**
 * Providers disagree about whether the prompt-token count INCLUDES the span
 * served from cache. Both conventions were measured live on 2026-08-25:
 *
 *   Anthropic (cache-excluded): a 4,650-token cached system prompt returned
 *     input_tokens 8 / cache_creation 4650 on the first call and
 *     input_tokens 8 / cache_read 4650 on the second — `input_tokens` never
 *     counts the cached span.
 *   OpenAI (cache-inclusive): the same shape on gpt-4o-mini returned
 *     prompt_tokens 1732 / cached 0, then prompt_tokens 1732 / cached 1664 —
 *     `prompt_tokens` is CONSTANT across a cache hit, so cached ⊆ prompt.
 *
 * `inputTokens` therefore carried two incomparable meanings, which broke two
 * things: the cache "hit ratio" was unbounded under the Anthropic convention
 * (cacheRead/inputTokens = 400, not a ratio), and cost arithmetic priced the
 * cached span twice under the OpenAI convention (full rate on the whole
 * prompt PLUS the discounted rate on the cached subset).
 *
 * Membrane now normalizes every adapter onto ONE convention — cache-excluded,
 * where inputTokens/cacheReadTokens/cacheCreationTokens are disjoint and each
 * is priced at its own rate.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import type {
  ProviderAdapter,
  ProviderRequest,
  ProviderResponse,
  StreamCallbacks,
  UsageCacheConvention,
  NormalizedRequest,
} from '../../src/types/index.js';

const ZZ_PRICING = {
  inputPerMillion: 1000,
  outputPerMillion: 1000,
  cacheWritePerMillion: 1000,
  cacheReadPerMillion: 100,
  currency: 'USD',
};

/** A registry stub so the cost assertions do not depend on the default table. */
const zzRegistry = {
  getPricing: () => ZZ_PRICING,
  getCapabilities: () => undefined,
  getQuirks: () => undefined,
  getModel: () => undefined,
  resolveAlias: (id: string) => id,
  listModels: () => [],
} as any;

function adapterReporting(
  usage: ProviderResponse['usage'],
  usageCacheConvention: UsageCacheConvention,
): ProviderAdapter {
  return {
    name: 'zz-adapter',
    usageCacheConvention,
    supportsModel: () => true,
    async complete(request: ProviderRequest): Promise<ProviderResponse> {
      return {
        content: [{ type: 'text', text: 'zz-reply' }],
        stopReason: 'end_turn',
        usage,
        model: 'zz-model-1',
        rawRequest: request,
        raw: {},
      } as ProviderResponse;
    },
    async stream(request: ProviderRequest, callbacks: StreamCallbacks): Promise<ProviderResponse> {
      callbacks.onChunk('zz-reply');
      return {
        content: [{ type: 'text', text: 'zz-reply' }],
        stopReason: 'end_turn',
        usage,
        model: 'zz-model-1',
        rawRequest: request,
        raw: {},
      } as ProviderResponse;
    },
  };
}

const ZZ_REQUEST = {
  config: { model: 'zz-model-1', maxTokens: 64 },
  messages: [{ role: 'user', content: [{ type: 'text', text: 'zz-prompt' }] }],
} as unknown as NormalizedRequest;

afterEach(() => { vi.restoreAllMocks(); });

describe('cache-excluded adapters (Anthropic convention)', () => {
  it('reports a hit ratio bounded by 1', async () => {
    const membrane = new Membrane(
      adapterReporting({ inputTokens: 120, outputTokens: 40, cacheReadTokens: 48_000 }, 'cache-excluded'),
      { registry: zzRegistry },
    );
    const response = await membrane.complete(ZZ_REQUEST);

    // 48000 / (48000 + 120) — was 48000/120 = 400 before normalization.
    expect(response.details.cache.hitRatio).toBeCloseTo(48_000 / 48_120, 10);
    expect(response.details.cache.hitRatio).toBeLessThanOrEqual(1);
  });

  it('leaves the disjoint token counts untouched', async () => {
    const membrane = new Membrane(
      adapterReporting({ inputTokens: 120, outputTokens: 40, cacheReadTokens: 48_000 }, 'cache-excluded'),
      { registry: zzRegistry },
    );
    const response = await membrane.complete(ZZ_REQUEST);

    expect(response.usage.inputTokens).toBe(120);
    expect(response.usage.cacheReadTokens).toBe(48_000);
    // 120 fresh at 1000/M + 48000 cached at 100/M.
    expect(response.details.usage.estimatedCost?.input).toBeCloseTo(120 * 1000 / 1e6, 12);
    expect(response.details.usage.estimatedCost?.cacheRead).toBeCloseTo(48_000 * 100 / 1e6, 12);
  });
});

describe('cache-inclusive adapters (OpenAI convention)', () => {
  it('subtracts the cached span from inputTokens so downstream sees one convention', async () => {
    const membrane = new Membrane(
      adapterReporting({ inputTokens: 1732, outputTokens: 2, cacheReadTokens: 1664 }, 'cache-inclusive'),
      { registry: zzRegistry },
    );
    const response = await membrane.complete(ZZ_REQUEST);

    expect(response.usage.inputTokens).toBe(68);
    expect(response.usage.cacheReadTokens).toBe(1664);
  });

  it('stops double-counting the cached span in cost', async () => {
    const membrane = new Membrane(
      adapterReporting({ inputTokens: 1732, outputTokens: 2, cacheReadTokens: 1664 }, 'cache-inclusive'),
      { registry: zzRegistry },
    );
    const response = await membrane.complete(ZZ_REQUEST);

    // Fresh input is prompt - cached = 68, not the full 1732.
    expect(response.details.usage.estimatedCost?.input).toBeCloseTo(68 * 1000 / 1e6, 12);
    expect(response.details.usage.estimatedCost?.cacheRead).toBeCloseTo(1664 * 100 / 1e6, 12);
  });

  it('normalizes the streaming path too', async () => {
    const membrane = new Membrane(
      adapterReporting({ inputTokens: 1732, outputTokens: 2, cacheReadTokens: 1664 }, 'cache-inclusive'),
      { registry: zzRegistry },
    );
    const response = await membrane.stream(ZZ_REQUEST);

    expect(response.usage.inputTokens).toBe(68);
    expect(response.details.cache.hitRatio).toBeCloseTo(1664 / 1732, 10);
  });
});

describe('per-response convention override', () => {
  it('wins over the adapter default (OpenRouter routes to both conventions)', async () => {
    const membrane = new Membrane(
      adapterReporting(
        { inputTokens: 120, outputTokens: 40, cacheReadTokens: 48_000, cacheConvention: 'cache-excluded' },
        'cache-inclusive',
      ),
      { registry: zzRegistry },
    );
    const response = await membrane.complete(ZZ_REQUEST);

    expect(response.usage.inputTokens).toBe(120);
  });
});

describe('undeclared conventions', () => {
  it('passes the counts through and warns once when a cache read is present', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* silence */ });
    const membrane = new Membrane(
      adapterReporting({ inputTokens: 1732, outputTokens: 2, cacheReadTokens: 1664 }, 'unknown'),
      { registry: zzRegistry },
    );

    const first = await membrane.complete(ZZ_REQUEST);
    await membrane.complete(ZZ_REQUEST);

    expect(first.usage.inputTokens).toBe(1732);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('usageCacheConvention');
  });

  it('stays silent when no cache read is reported', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* silence */ });
    const membrane = new Membrane(
      adapterReporting({ inputTokens: 1732, outputTokens: 2 }, 'unknown'),
      { registry: zzRegistry },
    );
    await membrane.complete(ZZ_REQUEST);

    expect(warn).not.toHaveBeenCalled();
  });
});
