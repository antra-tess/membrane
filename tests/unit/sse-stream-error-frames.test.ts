/**
 * Mid-stream SSE error frames must surface as errors, not truncate silently.
 *
 * Providers deliver upstream failures (provider 429s, capacity drops) as a
 * data line carrying an `error` payload INSIDE an HTTP-200 SSE stream.
 * Ignoring it produced a fake-successful completion — partial content with
 * finish_reason 'stop' and zero usage — which downstream consumers cannot
 * distinguish from the model choosing to stop there, and which anima then
 * persists as a silently truncated turn.
 *
 * The house already ruled this a bug twice: tests/unit/openrouter-stream-error.test.ts
 * (openrouter.ts) and the comment at openai-responses-api.ts (`Fabricating a
 * 'completed' response here would persist a silently truncated turn`). This
 * file covers the four adapters the fix never reached.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { OpenAIAdapter } from '../../src/providers/openai.js';
import { OpenAICompatibleAdapter } from '../../src/providers/openai-compatible.js';
import { OpenAICompletionsAdapter } from '../../src/providers/openai-completions.js';
import { GeminiAdapter } from '../../src/providers/gemini.js';
import { stubFetchWithSseLines } from '../helpers/sse-fixtures.js';

afterEach(() => vi.unstubAllGlobals());

const chatRequest = { model: 'zz-model-1', maxTokens: 64, messages: [{ role: 'user', content: 'zz prompt' }] };

describe('OpenAIAdapter mid-stream error frame', () => {
  it('throws after content already arrived', async () => {
    stubFetchWithSseLines([
      '{"choices":[{"delta":{"content":"partial "}}]}',
      '{"error":{"message":"zz upstream capacity gone","code":429}}',
    ]);
    const adapter = new OpenAIAdapter({ apiKey: 'zz-key' });
    const chunks: string[] = [];
    await expect(
      adapter.stream(chatRequest as any, { onChunk: (c: string) => chunks.push(c) } as any),
    ).rejects.toThrow(/OpenAI stream error \(429\).*zz upstream capacity gone/);
    expect(chunks).toEqual(['partial ']);
  });

  it('still completes a normal stream (regression)', async () => {
    stubFetchWithSseLines([
      '{"choices":[{"delta":{"content":"hello"}}]}',
      '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
      '[DONE]',
    ]);
    const adapter = new OpenAIAdapter({ apiKey: 'zz-key' });
    const res: any = await adapter.stream(chatRequest as any, { onChunk: () => {} } as any);
    expect(res.stopReason).toBe('end_turn');
    expect(res.content[0].text).toBe('hello');
  });
});

describe('OpenAICompatibleAdapter mid-stream error frame', () => {
  it('throws after content already arrived', async () => {
    stubFetchWithSseLines([
      '{"choices":[{"delta":{"content":"partial "}}]}',
      '{"error":{"message":"zz backend fell over","code":502}}',
    ]);
    const adapter = new OpenAICompatibleAdapter({ baseURL: 'http://localhost:9/v1', apiKey: 'zz-key' });
    const chunks: string[] = [];
    await expect(
      adapter.stream(chatRequest as any, { onChunk: (c: string) => chunks.push(c) } as any),
    ).rejects.toThrow(/stream error \(502\).*zz backend fell over/);
    expect(chunks).toEqual(['partial ']);
  });

  it('still completes a normal stream (regression)', async () => {
    stubFetchWithSseLines([
      '{"choices":[{"delta":{"content":"hello"}}]}',
      '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
      '[DONE]',
    ]);
    const adapter = new OpenAICompatibleAdapter({ baseURL: 'http://localhost:9/v1', apiKey: 'zz-key' });
    const res: any = await adapter.stream(chatRequest as any, { onChunk: () => {} } as any);
    expect(res.content[0].text).toBe('hello');
  });
});

describe('OpenAICompletionsAdapter mid-stream error frame', () => {
  const adapter = () =>
    new OpenAICompletionsAdapter({ baseURL: 'http://localhost:9/v1', eotToken: null, warnOnImageStrip: false });

  it('throws after text already arrived', async () => {
    stubFetchWithSseLines([
      '{"choices":[{"text":"partial "}]}',
      '{"error":{"message":"zz backend fell over","code":503}}',
    ]);
    const chunks: string[] = [];
    await expect(
      adapter().stream(chatRequest as any, { onChunk: (c: string) => chunks.push(c) } as any),
    ).rejects.toThrow(/stream error \(503\).*zz backend fell over/);
    expect(chunks).toEqual(['partial ']);
  });

  it('still completes a normal stream (regression)', async () => {
    stubFetchWithSseLines([
      '{"choices":[{"text":"hello"}]}',
      '{"choices":[{"text":"","finish_reason":"stop"}]}',
      '[DONE]',
    ]);
    const res: any = await adapter().stream(chatRequest as any, { onChunk: () => {} } as any);
    expect(res.content[0].text).toBe('hello');
  });
});

describe('GeminiAdapter mid-stream error frame', () => {
  const geminiRequest = { model: 'gemini-zz-1', maxTokens: 64, messages: [{ role: 'user', content: 'zz prompt' }] };

  it('throws on a candidates-less error frame after content arrived', async () => {
    stubFetchWithSseLines([
      '{"candidates":[{"content":{"parts":[{"text":"partial "}]}}]}',
      '{"error":{"code":429,"message":"zz quota exhausted","status":"RESOURCE_EXHAUSTED"}}',
    ]);
    const adapter = new GeminiAdapter({ apiKey: 'zz-key' });
    const chunks: string[] = [];
    await expect(
      adapter.stream(geminiRequest as any, { onChunk: (c: string) => chunks.push(c) } as any),
    ).rejects.toThrow(/Gemini stream error \(429\).*zz quota exhausted/);
    expect(chunks).toEqual(['partial ']);
  });

  it('still completes a normal stream (regression)', async () => {
    stubFetchWithSseLines([
      '{"candidates":[{"content":{"parts":[{"text":"hello"}]}}]}',
      '{"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2}}',
    ]);
    const adapter = new GeminiAdapter({ apiKey: 'zz-key' });
    const res: any = await adapter.stream(geminiRequest as any, { onChunk: () => {} } as any);
    expect(res.stopReason).toBe('end_turn');
    expect(res.usage.inputTokens).toBe(5);
  });
});
