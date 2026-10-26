/** An OpenAI-compatible server sends token usage on a streamed call when it is asked for with `stream_options.include_usage`. */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { OpenAICompatibleAdapter } from '../../src/providers/openai-compatible.js';
import { OpenAICompletionsAdapter } from '../../src/providers/openai-completions.js';
import { stubFetchWithSseLines, capturedRequestBody } from '../helpers/sse-fixtures.js';

afterEach(() => vi.unstubAllGlobals());

const chatRequest = { model: 'zz-model-1', maxTokens: 64, messages: [{ role: 'user', content: 'zz prompt' }] };

describe('OpenAICompatibleAdapter streamed usage', () => {
  const adapter = () => new OpenAICompatibleAdapter({ baseURL: 'http://localhost:9/v1', apiKey: 'zz-key' });

  it('requests usage and reports what the final frame carried', async () => {
    const fetchMock = stubFetchWithSseLines([
      '{"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}',
      '{"choices":[],"usage":{"prompt_tokens":4321,"completion_tokens":57,"total_tokens":4378}}',
      '[DONE]',
    ]);
    const res: any = await adapter().stream(chatRequest as any, { onChunk: () => {} } as any);

    expect(capturedRequestBody(fetchMock).stream_options).toEqual({ include_usage: true });
    expect(res.usage.inputTokens).toBe(4321);
    expect(res.usage.outputTokens).toBe(57);
  });

  it('falls back to zeros only when the server sent no usage', async () => {
    stubFetchWithSseLines(['{"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}', '[DONE]']);
    const res: any = await adapter().stream(chatRequest as any, { onChunk: () => {} } as any);
    expect(res.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

describe('OpenAICompletionsAdapter streamed usage', () => {
  const adapter = () =>
    new OpenAICompletionsAdapter({ baseURL: 'http://localhost:9/v1', eotToken: null, warnOnImageStrip: false });

  it('requests usage and reports what the final frame carried', async () => {
    const fetchMock = stubFetchWithSseLines([
      '{"choices":[{"text":"hi","finish_reason":"stop"}]}',
      '{"choices":[],"usage":{"prompt_tokens":8765,"completion_tokens":43,"total_tokens":8808}}',
      '[DONE]',
    ]);
    const res: any = await adapter().stream(chatRequest as any, { onChunk: () => {} } as any);

    expect(capturedRequestBody(fetchMock).stream_options).toEqual({ include_usage: true });
    expect(res.usage.inputTokens).toBe(8765);
    expect(res.usage.outputTokens).toBe(43);
  });

  it('falls back to zeros only when the server sent no usage', async () => {
    stubFetchWithSseLines(['{"choices":[{"text":"hi","finish_reason":"stop"}]}', '[DONE]']);
    const res: any = await adapter().stream(chatRequest as any, { onChunk: () => {} } as any);
    expect(res.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});
