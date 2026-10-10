/**
 * Gemini's `promptTokenCount` counts the cached span that
 * `cachedContentTokenCount` reports (Google's UsageMetadata reference: "this
 * is still the total effective prompt size meaning this includes the number
 * of tokens in the cached content"; see GeminiAdapter.usageCacheConvention for
 * what that sentence covers). So membrane reads Gemini as cache-inclusive and
 * subtracts the cached span: every consumer that sums fresh input, cache
 * reads and cache writes as one convention counts a hit once.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { GeminiAdapter } from '../../src/providers/gemini.js';
import { Membrane } from '../../src/membrane.js';
import type { NormalizedRequest, NormalizedResponse } from '../../src/types/index.js';

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

  it('leaves a response without a cache read as it was', async () => {
    stubComplete({ promptTokenCount: 10_000, candidatesTokenCount: 5, totalTokenCount: 10_005 });
    const response = await new Membrane(new GeminiAdapter({ apiKey: 'zz-key-not-used' })).complete(REQUEST);
    expect(response.usage.inputTokens).toBe(10_000);
  });
});
