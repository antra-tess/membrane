/** Bedrock streams binary AWS event-stream frames, not SSE lines, and the Anthropic adapter reads its stream through the vendor SDK, so neither is here. */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { OpenAIAdapter } from '../../src/providers/openai.js';
import { OpenAICompatibleAdapter } from '../../src/providers/openai-compatible.js';
import { OpenAICompletionsAdapter } from '../../src/providers/openai-completions.js';
import { OpenRouterAdapter } from '../../src/providers/openrouter.js';
import { GeminiAdapter } from '../../src/providers/gemini.js';
import { MembraneError } from '../../src/types/errors.js';
import { stubFetchWithRawSse, sseBodyWithUnterminatedTail } from '../helpers/sse-fixtures.js';

afterEach(() => vi.unstubAllGlobals());

const chatRequest = { model: 'zz-model-1', maxTokens: 64, messages: [{ role: 'user', content: 'zz prompt' }] };

function stubUnterminatedTail(dataLines: string[]): ReturnType<typeof stubFetchWithRawSse> {
  return stubFetchWithRawSse([sseBodyWithUnterminatedTail(dataLines)]);
}

const chatDelta = '{"choices":[{"delta":{"content":"hi"}}]}';
const chatFinishWithUsage =
  '{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1234,"completion_tokens":21,"total_tokens":1255}}';

describe('OpenAIAdapter unterminated final SSE event', () => {
  const adapter = () => new OpenAIAdapter({ apiKey: 'zz-key' });

  it('completes on a [DONE] with no trailing newline', async () => {
    stubUnterminatedTail([chatDelta, '[DONE]']);
    const res: any = await adapter().stream(chatRequest as any, { onChunk: () => {} } as any);
    expect(res.content[0].text).toBe('hi');
  });

  it('reads finish_reason and usage off an unterminated final frame', async () => {
    stubUnterminatedTail([chatDelta, chatFinishWithUsage]);
    const res: any = await adapter().stream(chatRequest as any, { onChunk: () => {} } as any);
    expect(res.stopReason).toBe('end_turn');
    expect(res.usage.inputTokens).toBe(1234);
    expect(res.usage.outputTokens).toBe(21);
  });
});

describe('OpenAICompatibleAdapter unterminated final SSE event', () => {
  const adapter = () => new OpenAICompatibleAdapter({ baseURL: 'http://localhost:9/v1', apiKey: 'zz-key' });

  it('completes on a [DONE] with no trailing newline', async () => {
    stubUnterminatedTail([chatDelta, '[DONE]']);
    const res: any = await adapter().stream(chatRequest as any, { onChunk: () => {} } as any);
    expect(res.content[0].text).toBe('hi');
  });

  it('reads finish_reason and usage off an unterminated final frame', async () => {
    stubUnterminatedTail([chatDelta, chatFinishWithUsage]);
    const res: any = await adapter().stream(chatRequest as any, { onChunk: () => {} } as any);
    expect(res.stopReason).toBe('end_turn');
    expect(res.usage.inputTokens).toBe(1234);
  });

  it('surfaces an error frame that arrived in the unterminated tail', async () => {
    stubUnterminatedTail([chatDelta, '{"error":{"message":"zz upstream stalled","type":"server_error"}}']);
    const failure = await adapter()
      .stream(chatRequest as any, { onChunk: () => {} } as any)
      .then((value) => { throw new Error(`expected a stream error, resolved with ${JSON.stringify(value)}`); },
        (error: unknown) => error);
    expect(failure).toBeInstanceOf(MembraneError);
    expect((failure as MembraneError).message).toMatch(/zz upstream stalled/);
  });
});

describe('OpenAICompletionsAdapter unterminated final SSE event', () => {
  const adapter = () =>
    new OpenAICompletionsAdapter({ baseURL: 'http://localhost:9/v1', eotToken: null, warnOnImageStrip: false });

  it('completes on a [DONE] with no trailing newline', async () => {
    stubUnterminatedTail(['{"choices":[{"text":"hi"}]}', '[DONE]']);
    const res: any = await adapter().stream(chatRequest as any, { onChunk: () => {} } as any);
    expect(res.content[0].text).toBe('hi');
  });

  it('reads finish_reason and usage off an unterminated final frame', async () => {
    stubUnterminatedTail([
      '{"choices":[{"text":"hi"}]}',
      '{"choices":[{"text":"","finish_reason":"stop"}],"usage":{"prompt_tokens":4321,"completion_tokens":12,"total_tokens":4333}}',
    ]);
    const res: any = await adapter().stream(chatRequest as any, { onChunk: () => {} } as any);
    expect(res.stopReason).toBe('end_turn');
    expect(res.usage.inputTokens).toBe(4321);
  });

  it('truncates at its own eotToken when that token rides the unterminated tail', async () => {
    stubUnterminatedTail(['{"choices":[{"text":"hi"}]}', '{"choices":[{"text":"<|eot|> and then some"}]}']);
    const withEot = new OpenAICompletionsAdapter({ baseURL: 'http://localhost:9/v1', warnOnImageStrip: false });
    const res: any = await withEot.stream(chatRequest as any, { onChunk: () => {} } as any);
    expect(res.content[0].text).toBe('hi');
  });
});

describe('OpenRouterAdapter unterminated final SSE event', () => {
  const adapter = () => new OpenRouterAdapter({ apiKey: 'zz-key' });

  it('completes on a [DONE] with no trailing newline', async () => {
    stubUnterminatedTail([chatDelta, '[DONE]']);
    const res: any = await adapter().stream(chatRequest as any, { onChunk: () => {} } as any);
    expect(res.content[0].text).toBe('hi');
  });

  it('reads finish_reason and usage off an unterminated final frame', async () => {
    stubUnterminatedTail([chatDelta, chatFinishWithUsage]);
    const res: any = await adapter().stream(chatRequest as any, { onChunk: () => {} } as any);
    expect(res.stopReason).toBe('end_turn');
    expect(res.usage.inputTokens).toBe(1234);
  });
});

describe('GeminiAdapter unterminated final SSE event', () => {
  it('already drains its trailing buffer, so the terminal finishReason lands', async () => {
    stubUnterminatedTail([
      '{"candidates":[{"content":{"parts":[{"text":"hi"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":2}}',
    ]);
    const adapter = new GeminiAdapter({ apiKey: 'zz-key' });
    const geminiRequest = { model: 'gemini-zz-1', maxTokens: 64, messages: [{ role: 'user', content: 'zz prompt' }] };
    const res: any = await adapter.stream(geminiRequest as any, { onChunk: () => {} } as any);
    expect(res.stopReason).toBe('end_turn');
    expect(res.content[0].text).toBe('hi');
  });
});
