/**
 * A stream that ends without a terminal event must fail, not be reported as a
 * clean completion.
 *
 * The terminal signal has to be an OBSERVATION, not a default: `finish_reason`
 * / `[DONE]` / Gemini's `finishReason` / Anthropic's `message_delta` only ever
 * overwrite an initialised `'stop'` / `'end_turn'`. A graceful upstream close
 * with no terminal frame — proxy or LB idle timeout, an early FIN, a gateway
 * truncating the body — therefore yielded partial content wearing
 * `stopReason: 'end_turn'` plus (OpenAI family) a `raw.finish_reason: 'stop'`
 * that never came off the wire. Abrupt TCP resets already reject the read;
 * graceful closes did not.
 *
 * `openai-responses-api` is the one adapter that already refused this. Bedrock
 * guarded only the fully-empty case (0 blocks AND 0 in AND 0 out), so a stream
 * truncated after any content passed.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { OpenAIAdapter } from '../../src/providers/openai.js';
import { OpenAICompatibleAdapter } from '../../src/providers/openai-compatible.js';
import { OpenAICompletionsAdapter } from '../../src/providers/openai-completions.js';
import { OpenRouterAdapter } from '../../src/providers/openrouter.js';
import { GeminiAdapter } from '../../src/providers/gemini.js';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { BedrockAdapter } from '../../src/providers/bedrock.js';
import { MembraneError } from '../../src/types/errors.js';
import { stubFetchWithSseLines } from '../helpers/sse-fixtures.js';
import { chunkFrame, streamBody } from '../helpers/bedrock-event-stream.js';

afterEach(() => vi.unstubAllGlobals());

const chatRequest = { model: 'zz-model-1', maxTokens: 64, messages: [{ role: 'user', content: 'zz prompt' }] };

/** The failure must be retryable: the request was never answered in full. */
async function expectRetryableTerminalFailure(streaming: Promise<unknown>): Promise<void> {
  const error = await streaming.then(
    (value) => { throw new Error(`expected a terminal-event failure, resolved with ${JSON.stringify(value)}`); },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(MembraneError);
  expect((error as MembraneError).message).toMatch(/stream ended before a terminal event/);
  expect((error as MembraneError).retryable).toBe(true);
}

describe('OpenAIAdapter terminal-event observation', () => {
  it('throws when the stream ends with no finish_reason and no [DONE]', async () => {
    stubFetchWithSseLines(['{"choices":[{"delta":{"content":"half a senten"}}]}']);
    const adapter = new OpenAIAdapter({ apiKey: 'zz-key' });
    await expectRetryableTerminalFailure(adapter.stream(chatRequest as any, { onChunk: () => {} } as any));
  });

  it('accepts a stream terminated by finish_reason alone', async () => {
    stubFetchWithSseLines(['{"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}']);
    const adapter = new OpenAIAdapter({ apiKey: 'zz-key' });
    const res: any = await adapter.stream(chatRequest as any, { onChunk: () => {} } as any);
    expect(res.stopReason).toBe('end_turn');
  });

  it('accepts a stream terminated by [DONE] alone', async () => {
    stubFetchWithSseLines(['{"choices":[{"delta":{"content":"hi"}}]}', '[DONE]']);
    const adapter = new OpenAIAdapter({ apiKey: 'zz-key' });
    const res: any = await adapter.stream(chatRequest as any, { onChunk: () => {} } as any);
    expect(res.content[0].text).toBe('hi');
  });
});

describe('OpenAICompatibleAdapter terminal-event observation', () => {
  const adapter = () => new OpenAICompatibleAdapter({ baseURL: 'http://localhost:9/v1', apiKey: 'zz-key' });

  it('throws when the stream ends with no terminal frame', async () => {
    stubFetchWithSseLines(['{"choices":[{"delta":{"content":"half a senten"}}]}']);
    await expectRetryableTerminalFailure(adapter().stream(chatRequest as any, { onChunk: () => {} } as any));
  });

  it('accepts a terminated stream', async () => {
    stubFetchWithSseLines(['{"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}', '[DONE]']);
    const res: any = await adapter().stream(chatRequest as any, { onChunk: () => {} } as any);
    expect(res.content[0].text).toBe('hi');
  });
});

describe('OpenAICompletionsAdapter terminal-event observation', () => {
  const adapter = () =>
    new OpenAICompletionsAdapter({ baseURL: 'http://localhost:9/v1', eotToken: null, warnOnImageStrip: false });

  it('throws when the stream ends with no terminal frame', async () => {
    stubFetchWithSseLines(['{"choices":[{"text":"half a senten"}]}']);
    await expectRetryableTerminalFailure(adapter().stream(chatRequest as any, { onChunk: () => {} } as any));
  });

  it('accepts a terminated stream', async () => {
    stubFetchWithSseLines(['{"choices":[{"text":"hi","finish_reason":"stop"}]}', '[DONE]']);
    const res: any = await adapter().stream(chatRequest as any, { onChunk: () => {} } as any);
    expect(res.content[0].text).toBe('hi');
  });

  it('treats its own eotToken truncation as terminal', async () => {
    stubFetchWithSseLines(['{"choices":[{"text":"hi<|eot|> and then some"}]}']);
    const withEot = new OpenAICompletionsAdapter({ baseURL: 'http://localhost:9/v1', warnOnImageStrip: false });
    const res: any = await withEot.stream(chatRequest as any, { onChunk: () => {} } as any);
    expect(res.content[0].text).toBe('hi');
  });
});

describe('OpenRouterAdapter terminal-event observation', () => {
  it('throws when the stream ends with no terminal frame', async () => {
    stubFetchWithSseLines(['{"choices":[{"delta":{"content":"half a senten"}}]}']);
    const adapter = new OpenRouterAdapter({ apiKey: 'zz-key' });
    await expectRetryableTerminalFailure(adapter.stream(chatRequest as any, { onChunk: () => {} } as any));
  });

  it('accepts a terminated stream', async () => {
    stubFetchWithSseLines(['{"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}', '[DONE]']);
    const adapter = new OpenRouterAdapter({ apiKey: 'zz-key' });
    const res: any = await adapter.stream(chatRequest as any, { onChunk: () => {} } as any);
    expect(res.content[0].text).toBe('hi');
  });
});

describe('GeminiAdapter terminal-event observation', () => {
  const geminiRequest = { model: 'gemini-zz-1', maxTokens: 64, messages: [{ role: 'user', content: 'zz prompt' }] };

  it('throws when the stream ends with no finishReason', async () => {
    stubFetchWithSseLines(['{"candidates":[{"content":{"parts":[{"text":"half a senten"}]}}]}']);
    const adapter = new GeminiAdapter({ apiKey: 'zz-key' });
    await expectRetryableTerminalFailure(adapter.stream(geminiRequest as any, { onChunk: () => {} } as any));
  });

  it('accepts a stream carrying finishReason', async () => {
    stubFetchWithSseLines([
      '{"candidates":[{"content":{"parts":[{"text":"hi"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":1}}',
    ]);
    const adapter = new GeminiAdapter({ apiKey: 'zz-key' });
    const res: any = await adapter.stream(geminiRequest as any, { onChunk: () => {} } as any);
    expect(res.stopReason).toBe('end_turn');
  });
});

function fakeAnthropicStream(events: unknown[]) {
  return {
    controller: { abort() { /* noop */ } },
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i < events.length) return { value: events[i++], done: false };
          return { value: undefined, done: true };
        },
      };
    },
  };
}

function anthropicAdapterWithEvents(events: unknown[]): AnthropicAdapter {
  const adapter = new AnthropicAdapter({ apiKey: 'zz-key' });
  (adapter as any).client = { messages: { stream: async () => fakeAnthropicStream(events) } };
  return adapter;
}

const anthropicRequest = {
  model: 'claude-zz-1',
  maxTokens: 64,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'zz prompt' }] }],
};

describe('AnthropicAdapter terminal-event observation', () => {
  it('throws when the SSE stream ends with no message_delta', async () => {
    const adapter = anthropicAdapterWithEvents([
      { type: 'message_start', message: { model: 'claude-zz-1', usage: { input_tokens: 10 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'half a senten' } },
      { type: 'content_block_stop', index: 0 },
    ]);
    await expectRetryableTerminalFailure(adapter.stream(anthropicRequest as any, { onChunk: () => {} } as any));
  });

  it('accepts a stream carrying message_delta', async () => {
    const adapter = anthropicAdapterWithEvents([
      { type: 'message_start', message: { model: 'claude-zz-1', usage: { input_tokens: 10 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
    ]);
    const res: any = await adapter.stream(anthropicRequest as any, { onChunk: () => {} } as any);
    expect(res.stopReason).toBe('end_turn');
    expect(res.usage.outputTokens).toBe(4);
  });
});

function bedrockAdapter(): BedrockAdapter {
  return new BedrockAdapter({ accessKeyId: 'zz-key', secretAccessKey: 'zz-secret', region: 'ap-southeast-1' });
}

const bedrockRequest = {
  model: 'apac.anthropic.claude-3-5-sonnet-20241022-v2:0',
  messages: [{ role: 'user', content: 'zz prompt' }],
  maxTokens: 64,
};

describe('BedrockAdapter terminal-event observation', () => {
  it('throws on a stream truncated after content (the empty-response guard misses it)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      body: streamBody([
        chunkFrame({ type: 'message_start', message: { usage: { input_tokens: 100 } } }),
        chunkFrame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
        chunkFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'half a senten' } }),
        chunkFrame({ type: 'content_block_stop', index: 0 }),
      ]),
    })));
    await expectRetryableTerminalFailure(bedrockAdapter().stream(bedrockRequest as any, { onChunk: () => {} } as any));
  });

  it('accepts a stream carrying message_delta', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      body: streamBody([
        chunkFrame({ type: 'message_start', message: { usage: { input_tokens: 100 } } }),
        chunkFrame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
        chunkFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }),
        chunkFrame({ type: 'content_block_stop', index: 0 }),
        chunkFrame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }),
        chunkFrame({ type: 'message_stop' }),
      ]),
    })));
    const res: any = await bedrockAdapter().stream(bedrockRequest as any, { onChunk: () => {} } as any);
    expect(res.stopReason).toBe('end_turn');
  });
});
