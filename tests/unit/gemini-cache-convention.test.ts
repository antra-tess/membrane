/**
 * Membrane reads Gemini's `promptTokenCount` as counting the cached span that
 * `cachedContentTokenCount` reports, and subtracts it, so every consumer that
 * sums fresh input, cache reads and cache writes as one convention counts a
 * hit once. The basis is Google's UsageMetadata definition ("this is still
 * the total effective prompt size meaning this includes the number of tokens
 * in the cached content"), which it states for explicit cached content, and
 * one published chat fits it for implicit hits too (see
 * GeminiAdapter.usageCacheConvention). A response the inclusive reading
 * can't explain, with more cached tokens than prompt tokens, is read as
 * cache-excluded. The usage below is constructed, not a captured hit.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { GeminiAdapter, resetPromptExcludesCacheWarning } from '../../src/providers/gemini.js';
import { Membrane } from '../../src/membrane.js';
import type { NormalizedRequest, NormalizedResponse, ProviderRequest } from '../../src/types/index.js';

const HIT = { promptTokenCount: 10_000, cachedContentTokenCount: 8_000, candidatesTokenCount: 5, totalTokenCount: 10_005 };

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function stubComplete(usageMetadata: unknown): void {
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }], usageMetadata, modelVersion: 'gemini-3.5-flash-lite' }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )) as typeof globalThis.fetch;
}

function stubStream(usageMetadata: unknown): void {
  const frames = [
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] })}\n\n`,
    `data: ${JSON.stringify({ candidates: [{ finishReason: 'STOP' }], usageMetadata, modelVersion: 'gemini-3.5-flash-lite' })}\n\n`,
  ];
  globalThis.fetch = (async () => new Response(
    new ReadableStream({ start(controller) { for (const f of frames) controller.enqueue(new TextEncoder().encode(f)); controller.close(); } }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )) as typeof globalThis.fetch;
}

const REQUEST = {
  config: { model: 'gemini-3.5-flash-lite', maxTokens: 64 },
  messages: [{ role: 'user', content: [{ type: 'text', text: 'zz-prompt' }] }],
} as unknown as NormalizedRequest;

describe('Gemini usage is cache-inclusive', () => {
  it('declares it', () => {
    expect(new GeminiAdapter({ apiKey: 'zz-key-not-used' }).usageCacheConvention).toBe('cache-inclusive');
  });

  it('reads a hit as fresh input plus cache reads, on complete()', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubComplete(HIT);
    const response = await new Membrane(new GeminiAdapter({ apiKey: 'zz-key-not-used' })).complete(REQUEST);
    expect(response.usage.inputTokens).toBe(2_000);
    expect(response.details.usage.cacheReadTokens).toBe(8_000);
    expect(response.details.cache.hitRatio).toBeCloseTo(0.8);
    expect(warn).not.toHaveBeenCalled();
  });

  it('and on stream()', async () => {
    stubStream(HIT);
    const response = await new Membrane(new GeminiAdapter({ apiKey: 'zz-key-not-used' })).stream(REQUEST) as NormalizedResponse;
    expect(response.usage.inputTokens).toBe(2_000);
    expect(response.details.usage.cacheReadTokens).toBe(8_000);
  });

  it('leaves a response without a cache read as it was, its cache read a reported 0, on complete() and stream()', async () => {
    // proto3 omits a zero count, so an omitted cachedContentTokenCount and an explicit 0 both report 0.
    for (const usage of [
      { promptTokenCount: 10_000, candidatesTokenCount: 5, totalTokenCount: 10_005 },
      { promptTokenCount: 10_000, cachedContentTokenCount: 0, candidatesTokenCount: 5, totalTokenCount: 10_005 },
    ]) {
      stubComplete(usage);
      const completed = await new Membrane(new GeminiAdapter({ apiKey: 'zz-key-not-used' })).complete(REQUEST);
      expect(completed.usage.inputTokens).toBe(10_000);
      expect(completed.details.usage.cacheReadTokens).toBe(0);
      stubStream(usage);
      const streamed = await new Membrane(new GeminiAdapter({ apiKey: 'zz-key-not-used' })).stream(REQUEST) as NormalizedResponse;
      expect(streamed.usage.inputTokens).toBe(10_000);
      expect(streamed.details.usage.cacheReadTokens).toBe(0);
    }
  });

  it('prices a hit once: the fresh span at the input rate, the cached span at the cache-read rate', async () => {
    // gemini-3.5-flash-lite in the default table: $0.30 input, $0.03 cache read, $2.50 output per million.
    const expected = { input: 2_000 * 0.30 / 1e6, cacheRead: 8_000 * 0.03 / 1e6, output: 5 * 2.50 / 1e6 };
    for (const run of ['complete', 'stream'] as const) {
      if (run === 'complete') stubComplete(HIT); else stubStream(HIT);
      const membrane = new Membrane(new GeminiAdapter({ apiKey: 'zz-key-not-used' }));
      const response = run === 'complete' ? await membrane.complete(REQUEST) : await membrane.stream(REQUEST) as NormalizedResponse;
      const cost = response.usage.estimatedCost!;
      expect(cost.input, run).toBeCloseTo(expected.input, 12);
      expect(cost.cacheRead, run).toBeCloseTo(expected.cacheRead, 12);
      expect(cost.total, run).toBeCloseTo(expected.input + expected.cacheRead + expected.output, 12);
    }
  });
});

describe('a pricing row without a cache-read rate', () => {
  it('leaves the cached span unpriced, as for every provider, where it used to ride in inputTokens', async () => {
    const row = { inputPerMillion: 1000, outputPerMillion: 1000, currency: 'USD' };
    const registry = {
      getPricing: () => row,
      getCapabilities: () => undefined,
      getQuirks: () => undefined,
      getModel: () => undefined,
      resolveAlias: (id: string) => id,
      listModels: () => [],
    } as any;
    stubComplete(HIT);
    const response = await new Membrane(new GeminiAdapter({ apiKey: 'zz-key-not-used' }), { registry }).complete(REQUEST);
    const cost = response.usage.estimatedCost!;
    expect(cost.input).toBeCloseTo(2_000 * 1000 / 1e6, 12);
    expect(cost.cacheRead).toBeUndefined();
    expect(cost.total).toBeCloseTo((2_000 + 5) * 1000 / 1e6, 12);
  });
});

describe('a response the inclusive reading cannot explain', () => {
  it('a cached span equal to the whole prompt is still inside it: no fresh input, on complete() and stream()', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const usage = { promptTokenCount: 8_000, cachedContentTokenCount: 8_000, candidatesTokenCount: 5, totalTokenCount: 8_005 };
    stubComplete(usage);
    const completed = await new Membrane(new GeminiAdapter({ apiKey: 'zz-key-not-used' })).complete(REQUEST);
    expect(completed.usage.inputTokens).toBe(0);
    expect(completed.details.usage.cacheReadTokens).toBe(8_000);
    stubStream(usage);
    const streamed = await new Membrane(new GeminiAdapter({ apiKey: 'zz-key-not-used' })).stream(REQUEST) as NormalizedResponse;
    expect(streamed.usage.inputTokens).toBe(0);
    expect(streamed.details.usage.cacheReadTokens).toBe(8_000);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a cached span above the prompt count is read as cache-excluded, with one warning', async () => {
    resetPromptExcludesCacheWarning(); // the latch is process-wide: this test doesn't depend on order
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const usage = { promptTokenCount: 2_000, cachedContentTokenCount: 8_000, candidatesTokenCount: 5, totalTokenCount: 2_005 };
    const warning = '[membrane:gemini] cachedContentTokenCount(8000) exceeds promptTokenCount(2000),'
      + ' so this prompt count cannot include the cached span. The response is read as cache-excluded'
      + ' (promptTokenCount, with any tool-use prompt, is the fresh input); the adapter declares'
      + ' cache-inclusive from Google\'s'
      + ' definition of the field.';
    stubComplete(usage);
    const completed = await new Membrane(new GeminiAdapter({ apiKey: 'zz-key-not-used' })).complete(REQUEST);
    expect(completed.usage.inputTokens).toBe(2_000);
    expect(completed.details.usage.cacheReadTokens).toBe(8_000);
    // This warning and no other: the counts reconcile, and the convention is declared.
    expect(warn.mock.calls).toEqual([[warning]]);
    stubStream(usage);
    const streamed = await new Membrane(new GeminiAdapter({ apiKey: 'zz-key-not-used' })).stream(REQUEST) as NormalizedResponse;
    expect(streamed.usage.inputTokens).toBe(2_000);
    expect(streamed.details.usage.cacheReadTokens).toBe(8_000);
    // Once per process, though two responses exceeded.
    expect(warn.mock.calls).toEqual([[warning]]);
  });

  it('a total that includes the cached span, the total membrane counts, reconciles too, so three such responses warn only once', async () => {
    resetPromptExcludesCacheWarning();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // prompt + cached + candidates = 2,000 + 8,000 + 5 = 10,005.
    stubComplete({ promptTokenCount: 2_000, cachedContentTokenCount: 8_000, candidatesTokenCount: 5, totalTokenCount: 10_005 });
    const membrane = new Membrane(new GeminiAdapter({ apiKey: 'zz-key-not-used' }));
    for (let call = 0; call < 3; call++) {
      const response = await membrane.complete(REQUEST);
      expect(response.usage.inputTokens).toBe(2_000);
      expect(response.details.usage.cacheReadTokens).toBe(8_000);
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('exceeds promptTokenCount(2000)');
  });

  it('that total reconciles with a tool-use prompt and thoughts in it too: every term of the sum membrane counts', async () => {
    resetPromptExcludesCacheWarning();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // prompt + tool-use prompt + cached + candidates + thoughts = 2,000 + 500 + 8,000 + 5 + 1,000 = 11,505.
    stubComplete({
      promptTokenCount: 2_000, toolUsePromptTokenCount: 500, cachedContentTokenCount: 8_000,
      candidatesTokenCount: 5, thoughtsTokenCount: 1_000, totalTokenCount: 11_505,
    });
    const response = await new Membrane(new GeminiAdapter({ apiKey: 'zz-key-not-used' })).complete(REQUEST);
    expect(response.usage.inputTokens).toBe(2_500);
    expect(response.details.usage.cacheReadTokens).toBe(8_000);
    expect(response.usage.outputTokens).toBe(1_005);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('exceeds promptTokenCount(2000)');
  });

  it('a total that matches neither sum still says so, naming both, and where the rest is only when it exceeds both', async () => {
    resetPromptExcludesCacheWarning();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const membrane = new Membrane(new GeminiAdapter({ apiKey: 'zz-key-not-used' }));
    const sums = '[membrane:gemini] usageMetadata does not reconcile: promptTokenCount(2000)'
      + ' + toolUsePromptTokenCount(0) + candidatesTokenCount(5) + thoughtsTokenCount(0)'
      + ' = 2005 (10005 with cachedContentTokenCount(8000))';
    // Between the two sums: above one, below the other, so no field is named.
    stubComplete({ promptTokenCount: 2_000, cachedContentTokenCount: 8_000, candidatesTokenCount: 5, totalTokenCount: 9_000 });
    await membrane.complete(REQUEST);
    expect(warn.mock.calls[0]).toEqual([`${sums}, but totalTokenCount = 9000.`]);
    expect(warn).toHaveBeenCalledTimes(2); // and the cache-excluded warning
    // Above both.
    stubComplete({ promptTokenCount: 2_000, cachedContentTokenCount: 8_000, candidatesTokenCount: 5, totalTokenCount: 12_000 });
    await membrane.complete(REQUEST);
    expect(warn.mock.calls[2]).toEqual([
      `${sums}, but totalTokenCount = 12000.`
      + ' Some billed tokens are in a usageMetadata field outside prompt, tool-use prompt, cached, candidates and thoughts.',
    ]);
  });

  it('a response the inclusive reading explains gets no such allowance: a total that adds the cached span again warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 10,000 prompt tokens already hold the 8,000 cached; 18,005 counts them twice.
    stubComplete({ promptTokenCount: 10_000, cachedContentTokenCount: 8_000, candidatesTokenCount: 5, totalTokenCount: 18_005 });
    await new Membrane(new GeminiAdapter({ apiKey: 'zz-key-not-used' })).complete(REQUEST);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/= 10005, but totalTokenCount = 18005\. Some billed tokens are in a usageMetadata field outside prompt, tool-use prompt, candidates and thoughts\.$/);
  });

  it('a total below the sum names no field the rest could be in', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubComplete({ promptTokenCount: 10_000, cachedContentTokenCount: 8_000, candidatesTokenCount: 5, totalTokenCount: 9_000 });
    await new Membrane(new GeminiAdapter({ apiKey: 'zz-key-not-used' })).complete(REQUEST);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/= 10005, but totalTokenCount = 9000\.$/);
  });

  it('one cached token above the prompt count is enough', async () => {
    resetPromptExcludesCacheWarning();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubComplete({ promptTokenCount: 10_000, cachedContentTokenCount: 10_001, candidatesTokenCount: 5, totalTokenCount: 10_005 });
    const response = await new Membrane(new GeminiAdapter({ apiKey: 'zz-key-not-used' })).complete(REQUEST);
    expect(response.usage.inputTokens).toBe(10_000);
    expect(response.details.usage.cacheReadTokens).toBe(10_001);
  });
});

/**
 * What a direct GeminiAdapter caller gets, which the changelog says is
 * unchanged. Membrane's restated usage can't hold this: it reads the same
 * whether the adapter or membrane subtracts the cached span.
 */
describe('a direct GeminiAdapter caller', () => {
  const DIRECT = {
    messages: [{ role: 'user', parts: [{ text: 'zz-prompt' }] }],
    model: 'gemini-3.5-flash-lite',
    maxTokens: 64,
  } as unknown as ProviderRequest;
  const call = async (run: 'complete' | 'stream', usageMetadata: unknown) => {
    if (run === 'complete') stubComplete(usageMetadata); else stubStream(usageMetadata);
    const adapter = new GeminiAdapter({ apiKey: 'zz-key-not-used' });
    return run === 'complete' ? adapter.complete(DIRECT) : adapter.stream(DIRECT, { onChunk: () => {} });
  };

  for (const run of ['complete', 'stream'] as const) {
    it(`gets promptTokenCount as inputTokens and the cached span as cacheReadTokens, on ${run}()`, async () => {
      const hit = await call(run, HIT);
      expect(hit.usage.inputTokens).toBe(10_000);
      expect(hit.usage.cacheReadTokens).toBe(8_000);
      expect(hit.usage.cacheConvention).toBeUndefined();
      const equal = await call(run, { promptTokenCount: 10_000, cachedContentTokenCount: 10_000, candidatesTokenCount: 5, totalTokenCount: 10_005 });
      expect(equal.usage.cacheConvention).toBeUndefined();
    });

    it(`marks a response with more cached tokens than prompt tokens cache-excluded, on ${run}()`, async () => {
      resetPromptExcludesCacheWarning();
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const above = await call(run, { promptTokenCount: 10_000, cachedContentTokenCount: 10_001, candidatesTokenCount: 5, totalTokenCount: 10_005 });
      expect(above.usage.inputTokens).toBe(10_000);
      expect(above.usage.cacheReadTokens).toBe(10_001);
      expect(above.usage.cacheConvention).toBe('cache-excluded');
    });

    it(`leaves the counts unreported when the response has no usageMetadata, on ${run}()`, async () => {
      const none = await call(run, undefined);
      expect(none.usage.cacheReadTokens).toBeUndefined();
      expect(none.unreportedUsage).toEqual(['inputTokens', 'outputTokens']);
    });
  }
});
