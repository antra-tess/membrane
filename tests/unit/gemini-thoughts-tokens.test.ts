/**
 * Gemini reports reasoning tokens in `usageMetadata.thoughtsTokenCount`, a
 * field disjoint from `candidatesTokenCount`.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { GeminiAdapter } from '../../src/providers/gemini.js';
import { Membrane } from '../../src/membrane.js';
import type { NormalizedRequest, NormalizedResponse } from '../../src/types/index.js';

const LIVE_RECEIPT_USAGE = {
  promptTokenCount: 35,
  candidatesTokenCount: 2,
  thoughtsTokenCount: 228,
  totalTokenCount: 265,
};

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function stubCompleteResponse(usageMetadata: unknown): void {
  globalThis.fetch = (async () => new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: '35' }] }, finishReason: 'STOP' }],
      usageMetadata,
      modelVersion: 'gemini-3.5-flash-lite',
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )) as typeof globalThis.fetch;
}

function stubStreamResponse(usageMetadata: unknown): void {
  const frames = [
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: '35' }] } }] })}\n\n`,
    `data: ${JSON.stringify({ candidates: [{ finishReason: 'STOP' }], usageMetadata, modelVersion: 'gemini-3.5-flash-lite' })}\n\n`,
  ];
  globalThis.fetch = (async () => new Response(
    new ReadableStream({
      start(controller) {
        for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )) as typeof globalThis.fetch;
}

const REQUEST = { model: 'gemini-3.5-flash-lite', maxTokens: 64, messages: [{ role: 'user', content: 'zz-prompt' }] } as any;

describe('GeminiAdapter thoughtsTokenCount accounting', () => {
  it('folds thoughts into outputTokens on complete()', async () => {
    stubCompleteResponse(LIVE_RECEIPT_USAGE);
    const adapter = new GeminiAdapter({ apiKey: 'zz-key-not-used' });
    const response = await adapter.complete(REQUEST);

    expect(response.usage.inputTokens).toBe(35);
    expect(response.usage.outputTokens).toBe(230);
    expect(response.usage.thinkingTokens).toBe(228);
  });

  it('folds thoughts into outputTokens on stream()', async () => {
    stubStreamResponse(LIVE_RECEIPT_USAGE);
    const adapter = new GeminiAdapter({ apiKey: 'zz-key-not-used' });
    const response = await adapter.stream(REQUEST, { onChunk: () => { } });

    expect(response.usage.inputTokens).toBe(35);
    expect(response.usage.outputTokens).toBe(230);
    expect(response.usage.thinkingTokens).toBe(228);
  });

  it('leaves thinkingTokens unset when the provider reports no thoughts', async () => {
    stubCompleteResponse({ promptTokenCount: 10893, candidatesTokenCount: 1, totalTokenCount: 10894 });
    const adapter = new GeminiAdapter({ apiKey: 'zz-key-not-used' });
    const response = await adapter.complete(REQUEST);

    expect(response.usage.outputTokens).toBe(1);
    expect(response.usage.thinkingTokens).toBeUndefined();
  });

  it('warns when prompt + candidates + thoughts does not reconcile with total', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { });
    stubCompleteResponse({ ...LIVE_RECEIPT_USAGE, totalTokenCount: 999 });
    const adapter = new GeminiAdapter({ apiKey: 'zz-key-not-used' });
    await adapter.complete(REQUEST);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('999'));
  });

  it('does not warn when the counts reconcile', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { });
    stubCompleteResponse(LIVE_RECEIPT_USAGE);
    const adapter = new GeminiAdapter({ apiKey: 'zz-key-not-used' });
    await adapter.complete(REQUEST);

    expect(warn).not.toHaveBeenCalled();
  });
});

const MEMBRANE_REQUEST = {
  config: { model: 'gemini-3.5-flash-lite', maxTokens: 64 },
  messages: [{ role: 'user', content: [{ type: 'text', text: 'zz-prompt' }] }],
} as unknown as NormalizedRequest;

describe('thinking tokens through Membrane', () => {
  it('carries thinkingTokens out of complete()', async () => {
    stubCompleteResponse(LIVE_RECEIPT_USAGE);
    const membrane = new Membrane(new GeminiAdapter({ apiKey: 'zz-key-not-used' }));
    const response = await membrane.complete(MEMBRANE_REQUEST);

    expect(response.usage.outputTokens).toBe(230);
    expect(response.usage.thinkingTokens).toBe(228);
    expect(response.details.usage.thinkingTokens).toBe(228);
  });

  it('carries thinkingTokens through the streaming accumulator', async () => {
    stubStreamResponse(LIVE_RECEIPT_USAGE);
    const membrane = new Membrane(new GeminiAdapter({ apiKey: 'zz-key-not-used' }));
    const response = await membrane.stream(MEMBRANE_REQUEST) as NormalizedResponse;

    expect(response.usage.outputTokens).toBe(230);
    expect(response.usage.thinkingTokens).toBe(228);
    expect(response.details.usage.thinkingTokens).toBe(228);
    expect(response.details.model.perRound?.[0]?.usage.thinkingTokens).toBe(228);
  });

  it('leaves thinkingTokens unset on a turn with no thinking', async () => {
    stubStreamResponse({ promptTokenCount: 10893, candidatesTokenCount: 1, totalTokenCount: 10894 });
    const membrane = new Membrane(new GeminiAdapter({ apiKey: 'zz-key-not-used' }));
    const response = await membrane.stream(MEMBRANE_REQUEST) as NormalizedResponse;

    expect(response.usage.outputTokens).toBe(1);
    expect(response.usage.thinkingTokens).toBeUndefined();
  });
});
