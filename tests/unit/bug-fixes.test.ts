import { describe, it, expect, vi } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { MockAdapter } from '../../src/providers/mock.js';
import type { NormalizedRequest, NormalizedMessage } from '../../src/types/index.js';

function createMessage(participant: string, text: string): NormalizedMessage {
  return { participant, content: [{ type: 'text', text }] };
}

function makeRequest(overrides: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    messages: [createMessage('User', 'Hello')],
    config: {
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 100,
      ...overrides.config,
    },
    ...overrides,
  };
}

describe('Temperature enforcement for thinking', () => {
  it('forces temperature=1 in complete() when thinking is enabled', async () => {
    let capturedRequest: any;
    const adapter = new MockAdapter({
      defaultResponse: 'Hello',
      completeDelayMs: 0, streamChunkDelayMs: 0,
    });
    const membrane = new Membrane(adapter);

    const request = makeRequest({
      config: {
        model: 'claude-haiku-4-5-20251001',
        maxTokens: 4096,
        temperature: 0.5,
        thinking: { enabled: true, budgetTokens: 2048 },
      },
    });

    await membrane.complete(request, {
      onRequest: (req) => { capturedRequest = req; },
    });

    expect(capturedRequest.temperature).toBe(1);
  });

  it('preserves temperature when thinking is not enabled', async () => {
    let capturedRequest: any;
    const adapter = new MockAdapter({
      defaultResponse: 'Hello',
      completeDelayMs: 0, streamChunkDelayMs: 0,
    });
    const membrane = new Membrane(adapter);

    const request = makeRequest({
      config: {
        model: 'claude-haiku-4-5-20251001',
        maxTokens: 1000,
        temperature: 0.7,
      },
    });

    await membrane.complete(request, {
      onRequest: (req) => { capturedRequest = req; },
    });

    expect(capturedRequest.temperature).toBe(0.7);
  });

  it('forces temperature=1 in stream() XML mode when thinking is enabled', async () => {
    let capturedRequest: any;
    const adapter = new MockAdapter({
      defaultResponse: 'Hello',
      completeDelayMs: 0, streamChunkDelayMs: 0,
    });
    const membrane = new Membrane(adapter);

    const request = makeRequest({
      config: {
        model: 'claude-haiku-4-5-20251001',
        maxTokens: 4096,
        temperature: 0.3,
        thinking: { enabled: true, budgetTokens: 2048 },
      },
    });

    await membrane.stream(request, {
      onChunk: () => {},
      onRequest: (req) => { capturedRequest = req; },
    });

    expect(capturedRequest.temperature).toBe(1);
  });

  it('clamps thinking budget_tokens below max_tokens', async () => {
    let capturedRequest: any;
    const adapter = new MockAdapter({ defaultResponse: 'Hello', completeDelayMs: 0, streamChunkDelayMs: 0 });
    const membrane = new Membrane(adapter, { formatter: new NativeFormatter() });

    const request = makeRequest({
      config: {
        model: 'claude-sonnet-4-5-20250929',
        maxTokens: 4096,
        thinking: { enabled: true, budgetTokens: 10000 },
      },
    });

    await membrane.complete(request, {
      onRequest: (req) => { capturedRequest = req; },
    });

    expect(capturedRequest.thinking).toEqual({ type: 'enabled', budget_tokens: 4096 - 1024 });
  });

  it('drops thinking entirely when no valid budget fits under max_tokens', async () => {
    let capturedRequest: any;
    const adapter = new MockAdapter({ defaultResponse: 'Hello', completeDelayMs: 0, streamChunkDelayMs: 0 });
    const membrane = new Membrane(adapter);

    const request = makeRequest({
      config: {
        model: 'claude-sonnet-4-5-20250929',
        maxTokens: 1000,  // below Anthropic's minimum thinking budget of 1024
        temperature: 0.5,
        thinking: { enabled: true, budgetTokens: 5000 },
      },
    });

    await membrane.complete(request, {
      onRequest: (req) => { capturedRequest = req; },
    });

    expect(capturedRequest.thinking).toBeUndefined();
    expect(capturedRequest.temperature).toBe(0.5);
  });

  it('does not clamp adaptive thinking (no budget)', async () => {
    let capturedRequest: any;
    const adapter = new MockAdapter({ defaultResponse: 'Hello', completeDelayMs: 0, streamChunkDelayMs: 0 });
    const membrane = new Membrane(adapter, { formatter: new NativeFormatter() });

    const request = makeRequest({
      config: {
        model: 'claude-sonnet-4-5-20250929',
        maxTokens: 1000,
        thinking: { enabled: true, type: 'adaptive' as const, display: 'summarized' as const },
      },
    });

    await membrane.complete(request, {
      onRequest: (req) => { capturedRequest = req; },
    });

    expect(capturedRequest.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
  });

  it('drops API thinking param for prefill-style builds (XML formatter)', async () => {
    let capturedRequest: any;
    const adapter = new MockAdapter({ defaultResponse: 'Hello', completeDelayMs: 0, streamChunkDelayMs: 0 });
    const membrane = new Membrane(adapter);

    const request = makeRequest({
      toolMode: 'xml',
      config: {
        model: 'claude-sonnet-4-5-20250929',
        maxTokens: 4096,
        thinking: { enabled: true, budgetTokens: 2048 },
      },
    });

    await membrane.complete(request, {
      onRequest: (req) => { capturedRequest = req; },
    });

    expect(capturedRequest.thinking).toBeUndefined();
    const lastMsg = capturedRequest.messages[capturedRequest.messages.length - 1];
    expect(lastMsg.role).toBe('assistant');
    expect(String(lastMsg.content)).toContain('<thinking>');
  });
});

describe('Abort signal during retry', () => {
  it('aborts promptly during retry delay instead of waiting', async () => {
    const adapter = new MockAdapter({
      defaultResponse: 'Hello',
    });

    const originalComplete = adapter.complete.bind(adapter);
    let callCount = 0;
    adapter.complete = async (request: any, options: any) => {
      callCount++;
      const error = new Error('429 Too Many Requests');
      (error as any).status = 429;
      throw error;
    };

    const membrane = new Membrane(adapter, {
      retry: {
        maxRetries: 5,
        retryDelayMs: 5000,
        backoffMultiplier: 1,
        maxRetryDelayMs: 10000,
      },
    });

    const controller = new AbortController();

    setTimeout(() => controller.abort(), 100);

    const startTime = Date.now();

    await expect(
      membrane.complete(makeRequest(), { signal: controller.signal })
    ).rejects.toThrow();

    const elapsed = Date.now() - startTime;

    expect(elapsed).toBeLessThan(1000);
    expect(callCount).toBeGreaterThanOrEqual(1);
  });
});
