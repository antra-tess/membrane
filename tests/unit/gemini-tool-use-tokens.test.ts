/**
 * Gemini reports the prompt tokens its built-in tools add in
 * `usageMetadata.toolUsePromptTokenCount`, a field disjoint from
 * `promptTokenCount`: Google defines `totalTokenCount` as "prompt + tool-use
 * prompt + thoughts + response candidates", and bills code execution's, URL
 * context's and file search's tool-use tokens as input.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { GeminiAdapter, resetPromptExcludesCacheWarning } from '../../src/providers/gemini.js';
import { Membrane } from '../../src/membrane.js';
import type { NormalizedRequest, NormalizedResponse } from '../../src/types/index.js';

/** The issue's reproduction. */
const TOOL_USE_USAGE = {
  promptTokenCount: 1000,
  toolUsePromptTokenCount: 300,
  candidatesTokenCount: 50,
  totalTokenCount: 1350,
};

/**
 * The usage in Google's URL context guide (read 2026-10-14), an Interactions
 * API example, translated here into generateContent's field names: input 27,
 * thoughts 31, tool use 10,309, output 45, total 10,412.
 */
const URL_CONTEXT_USAGE = {
  promptTokenCount: 27,
  toolUsePromptTokenCount: 10309,
  candidatesTokenCount: 45,
  thoughtsTokenCount: 31,
  totalTokenCount: 10412,
};

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function stubCompleteResponse(usageMetadata: unknown): void {
  globalThis.fetch = (async () => new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'zz-answer' }] }, finishReason: 'STOP' }],
      usageMetadata,
      modelVersion: 'gemini-3.5-flash-lite',
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )) as typeof globalThis.fetch;
}

function stubStreamResponse(usageMetadata: unknown): void {
  const frames = [
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'zz-answer' }] } }] })}\n\n`,
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

describe('GeminiAdapter toolUsePromptTokenCount accounting', () => {
  it('reads tool-use prompt tokens into inputTokens on complete(), and the counts reconcile', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* silence */ });
    stubCompleteResponse(TOOL_USE_USAGE);
    const adapter = new GeminiAdapter({ apiKey: 'zz-key-not-used' });
    const response = await adapter.complete(REQUEST);

    expect(response.usage.inputTokens).toBe(1300);
    expect(response.usage.outputTokens).toBe(50);
    expect(warn).not.toHaveBeenCalled();
  });

  it('reads tool-use prompt tokens into inputTokens on stream(), and the counts reconcile', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* silence */ });
    stubStreamResponse(TOOL_USE_USAGE);
    const adapter = new GeminiAdapter({ apiKey: 'zz-key-not-used' });
    const response = await adapter.stream(REQUEST, { onChunk: () => { /* noop */ } });

    expect(response.usage.inputTokens).toBe(1300);
    expect(response.usage.outputTokens).toBe(50);
    expect(warn).not.toHaveBeenCalled();
  });

  it('reconciles tool-use prompt tokens beside thoughts', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* silence */ });
    stubCompleteResponse(URL_CONTEXT_USAGE);
    const adapter = new GeminiAdapter({ apiKey: 'zz-key-not-used' });
    const response = await adapter.complete(REQUEST);

    expect(response.usage.inputTokens).toBe(10336);
    expect(response.usage.outputTokens).toBe(76);
    expect(response.usage.thinkingTokens).toBe(31);
    expect(warn).not.toHaveBeenCalled();
  });

  it('still warns when the four counts do not reconcile, and the warning names toolUsePromptTokenCount', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* silence */ });
    stubCompleteResponse({ ...TOOL_USE_USAGE, totalTokenCount: 1400 });
    const adapter = new GeminiAdapter({ apiKey: 'zz-key-not-used' });
    await adapter.complete(REQUEST);

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain('usageMetadata does not reconcile');
    expect(message).toContain('toolUsePromptTokenCount(300)');
    expect(message).toContain('= 1350, but totalTokenCount = 1400');
  });
});

const MEMBRANE_REQUEST = {
  config: { model: 'gemini-3.5-flash-lite', maxTokens: 64 },
  messages: [{ role: 'user', content: [{ type: 'text', text: 'zz-prompt' }] }],
} as unknown as NormalizedRequest;

describe('tool-use prompt tokens through Membrane', () => {
  it('prices them at the input rate', async () => {
    stubCompleteResponse(TOOL_USE_USAGE);
    const withToolUse = await new Membrane(new GeminiAdapter({ apiKey: 'zz-key-not-used' })).complete(MEMBRANE_REQUEST);
    stubCompleteResponse({ promptTokenCount: 1300, candidatesTokenCount: 50, totalTokenCount: 1350 });
    const promptOnly = await new Membrane(new GeminiAdapter({ apiKey: 'zz-key-not-used' })).complete(MEMBRANE_REQUEST);

    expect(withToolUse.usage.inputTokens).toBe(1300);
    expect(withToolUse.usage.estimatedCost?.input).toBeGreaterThan(0);
    expect(withToolUse.usage.estimatedCost?.input).toBe(promptOnly.usage.estimatedCost?.input);
    expect(withToolUse.usage.estimatedCost?.total).toBe(promptOnly.usage.estimatedCost?.total);
  });

  it('carries them through the streaming accumulator, priced at the input rate', async () => {
    stubStreamResponse(TOOL_USE_USAGE);
    const response = await new Membrane(new GeminiAdapter({ apiKey: 'zz-key-not-used' })).stream(MEMBRANE_REQUEST) as NormalizedResponse;
    stubStreamResponse({ promptTokenCount: 1300, candidatesTokenCount: 50, totalTokenCount: 1350 });
    const promptOnly = await new Membrane(new GeminiAdapter({ apiKey: 'zz-key-not-used' })).stream(MEMBRANE_REQUEST) as NormalizedResponse;

    expect(response.usage.inputTokens).toBe(1300);
    expect(response.details.model.perRound?.[0]?.usage.inputTokens).toBe(1300);
    expect(response.usage.estimatedCost?.input).toBeGreaterThan(0);
    expect(response.usage.estimatedCost?.input).toBe(promptOnly.usage.estimatedCost?.input);
    expect(response.details.model.perRound?.[0]?.usage.estimatedCost?.input).toBe(promptOnly.usage.estimatedCost?.input);
  });
});

/**
 * Beside the cache-inclusive reading: the cached span is inside
 * `promptTokenCount` and the tool-use prompt is beside it, so a hit's fresh
 * input is the prompt less the cached span, plus the tool-use prompt, and the
 * cached span is compared with the prompt count alone.
 */
describe('tool-use prompt tokens beside a cache hit', () => {
  it('a hit subtracts the cached span from the prompt and keeps the tool-use prompt', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* silence */ });
    stubCompleteResponse({ promptTokenCount: 10_000, cachedContentTokenCount: 8_000, toolUsePromptTokenCount: 300, candidatesTokenCount: 50, totalTokenCount: 10_350 });
    const response = await new Membrane(new GeminiAdapter({ apiKey: 'zz-key-not-used' })).complete(MEMBRANE_REQUEST);

    expect(response.usage.inputTokens).toBe(2_300);
    expect(response.details.usage.cacheReadTokens).toBe(8_000);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a cached span above the prompt count is read as cache-excluded, though prompt plus tool-use prompt would hold it', async () => {
    resetPromptExcludesCacheWarning();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* silence */ });
    stubCompleteResponse({ promptTokenCount: 1_000, cachedContentTokenCount: 1_200, toolUsePromptTokenCount: 500, candidatesTokenCount: 50, totalTokenCount: 1_550 });
    const response = await new Membrane(new GeminiAdapter({ apiKey: 'zz-key-not-used' })).complete(MEMBRANE_REQUEST);

    expect(response.usage.inputTokens).toBe(1_500);
    expect(response.details.usage.cacheReadTokens).toBe(1_200);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('cachedContentTokenCount(1200) exceeds promptTokenCount(1000)');
  });
});
