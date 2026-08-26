/**
 * A structured SSE error frame must keep its classification.
 *
 * `throwOnStreamErrorFrame` used to throw `new Error(string)`: the frame's
 * `code`/`type`/`status` survived only as prose inside the message, and every
 * adapter's `handleError` then re-derived a category by substring-matching
 * that prose. A mid-stream 429 whose frame carried `status: 429` rather than a
 * literal "429"-in-message therefore normalized to `unknown, retryable: false`
 * — the caller's retry policy never saw a rate limit it could wait out.
 *
 * The helper now classifies before throwing, using the same error
 * constructors the HTTP paths use, so the category and the retryable flag are
 * facts carried by the error rather than an accident of message wording.
 * Adapter `handleError` implementations already pass a MembraneError through
 * untouched, which is what lets the classification reach the caller.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { throwOnStreamErrorFrame } from '../../src/providers/utils.js';
import { MembraneError, classifyError, isOverloadedError } from '../../src/types/errors.js';
import { OpenRouterAdapter } from '../../src/providers/openrouter.js';
import { OpenAIAdapter } from '../../src/providers/openai.js';
import { OpenAIResponsesAPIAdapter } from '../../src/providers/openai-responses-api.js';
import { stubFetchWithSseLines } from '../helpers/sse-fixtures.js';

afterEach(() => vi.unstubAllGlobals());

const zzRequest = { model: 'zz-model-1', maxTokens: 64, messages: [{ role: 'user', content: 'zz prompt' }] };

function throwsFromFrame(errorPayload: unknown, rawRequest?: unknown): unknown {
  try {
    throwOnStreamErrorFrame({ error: errorPayload }, 'zz-provider-1', rawRequest);
  } catch (thrown) {
    return thrown;
  }
  throw new Error('expected throwOnStreamErrorFrame to throw for this frame');
}

async function rejectionFrom(streaming: Promise<unknown>): Promise<unknown> {
  try {
    await streaming;
  } catch (thrown) {
    return thrown;
  }
  throw new Error('expected the stream to reject');
}

describe('throwOnStreamErrorFrame rate-limit frames', () => {
  it('classifies a numeric 429 code as a retryable rate limit and keeps the provider message', () => {
    const thrown = throwsFromFrame({ code: 429, message: 'zz quota gone for this key' });

    expect(thrown).toBeInstanceOf(MembraneError);
    const membraneError = thrown as MembraneError;
    expect(membraneError.type).toBe('rate_limit');
    expect(membraneError.retryable).toBe(true);
    expect(membraneError.httpStatus).toBe(429);
    expect(membraneError.message).toContain('zz quota gone for this key');
    expect(membraneError.message).toContain('zz-provider-1 stream error (429)');
  });

  it('classifies a 429 carried as a string code', () => {
    const thrown = throwsFromFrame({ code: '429', message: 'zz quota gone' }) as MembraneError;

    expect(thrown.type).toBe('rate_limit');
    expect(thrown.retryable).toBe(true);
  });

  it('classifies a 429 carried on status rather than code', () => {
    const thrown = throwsFromFrame({ status: 429, message: 'zz quota gone' }) as MembraneError;

    expect(thrown.type).toBe('rate_limit');
    expect(thrown.retryable).toBe(true);
  });

  it('classifies a rate-limit-shaped type with no numeric code at all', () => {
    const thrown = throwsFromFrame({ type: 'rate_limit_error', message: 'zz slow down' }) as MembraneError;

    expect(thrown.type).toBe('rate_limit');
    expect(thrown.retryable).toBe(true);
    expect(thrown.message).toContain('rate_limit_error');
  });

  it('classifies a Gemini-shaped RESOURCE_EXHAUSTED status', () => {
    const thrown = throwsFromFrame({ status: 'RESOURCE_EXHAUSTED', message: 'zz quota gone' }) as MembraneError;

    expect(thrown.type).toBe('rate_limit');
    expect(thrown.retryable).toBe(true);
  });

  it('preserves retry metadata carried in seconds, milliseconds, or a duration string', () => {
    const seconds = throwsFromFrame({ code: 429, message: 'zz slow down', retry_after: 30 }) as MembraneError;
    const milliseconds = throwsFromFrame({ code: 429, message: 'zz slow down', retryAfterMs: 1500 }) as MembraneError;
    const duration = throwsFromFrame({ code: 429, message: 'zz slow down', retryDelay: '45s' }) as MembraneError;

    expect(seconds.retryAfterMs).toBe(30_000);
    expect(milliseconds.retryAfterMs).toBe(1_500);
    expect(duration.retryAfterMs).toBe(45_000);
  });

  it('leaves retryAfterMs unset when the frame carries no retry metadata', () => {
    const thrown = throwsFromFrame({ code: 429, message: 'zz slow down' }) as MembraneError;

    expect(thrown.retryAfterMs).toBeUndefined();
  });
});

describe('throwOnStreamErrorFrame server-class frames', () => {
  it('classifies a 5xx code as a retryable server error carrying its status', () => {
    const thrown = throwsFromFrame({ code: 503, message: 'zz backend fell over' }) as MembraneError;

    expect(thrown.type).toBe('server');
    expect(thrown.retryable).toBe(true);
    expect(thrown.httpStatus).toBe(503);
    expect(thrown.message).toContain('zz backend fell over');
  });

  it('classifies an overloaded-shaped type with no code onto the overloaded schedule', () => {
    const thrown = throwsFromFrame({ type: 'overloaded_error', message: 'zz capacity gone' }) as MembraneError;

    expect(thrown.type).toBe('server');
    expect(thrown.retryable).toBe(true);
    expect(thrown.httpStatus).toBe(529);
    expect(isOverloadedError(thrown.toErrorInfo())).toBe(true);
  });
});

describe('throwOnStreamErrorFrame auth frames', () => {
  it('classifies 401 as non-retryable auth', () => {
    const thrown = throwsFromFrame({ code: 401, message: 'zz key rejected' }) as MembraneError;

    expect(thrown.type).toBe('auth');
    expect(thrown.retryable).toBe(false);
    expect(thrown.message).toContain('zz key rejected');
  });

  it('classifies 403 as non-retryable auth', () => {
    const thrown = throwsFromFrame({ code: 403, message: 'zz key forbidden' }) as MembraneError;

    expect(thrown.type).toBe('auth');
    expect(thrown.retryable).toBe(false);
  });

  it('classifies an auth-shaped type with no numeric code', () => {
    const thrown = throwsFromFrame({ type: 'invalid_api_key', message: 'zz key rejected' }) as MembraneError;

    expect(thrown.type).toBe('auth');
    expect(thrown.retryable).toBe(false);
  });
});

describe('throwOnStreamErrorFrame unclassified frames', () => {
  it('keeps the generic error but preserves code and type in the message', () => {
    const thrown = throwsFromFrame({ code: 400, type: 'zz_unrecognized_frame_1', message: 'zz malformed tool schema' });

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(MembraneError);
    const generic = thrown as Error;
    expect(generic.message).toContain('400');
    expect(generic.message).toContain('zz_unrecognized_frame_1');
    expect(generic.message).toContain('zz malformed tool schema');
  });

  it('falls back to the serialized payload when the frame carries no message', () => {
    const thrown = throwsFromFrame({ zzDetail1: 'zz opaque payload' }) as Error;

    expect(thrown.message).toContain('zz opaque payload');
  });
});

describe('throwOnStreamErrorFrame payload fidelity', () => {
  it('attaches the raw frame and the raw request to a classified error', () => {
    const thrown = throwsFromFrame({ code: 429, message: 'zz quota gone' }, zzRequest) as MembraneError;

    expect(JSON.stringify(thrown.rawError)).toContain('zz quota gone');
    expect(thrown.rawRequest).toBe(zzRequest);
  });
});

describe('throwOnStreamErrorFrame non-error frames (pinned)', () => {
  it('ignores frames that carry no error payload', () => {
    expect(() => throwOnStreamErrorFrame({ choices: [{ delta: { content: 'zz text' } }] }, 'zz-provider-1')).not.toThrow();
    expect(() => throwOnStreamErrorFrame({ candidates: [{ content: { parts: [] } }] }, 'zz-provider-1')).not.toThrow();
    expect(() => throwOnStreamErrorFrame({}, 'zz-provider-1')).not.toThrow();
    expect(() => throwOnStreamErrorFrame({ error: null }, 'zz-provider-1')).not.toThrow();
    expect(() => throwOnStreamErrorFrame('zz-not-an-object', 'zz-provider-1')).not.toThrow();
    expect(() => throwOnStreamErrorFrame(null, 'zz-provider-1')).not.toThrow();
  });
});

describe('classified stream errors reaching an adapter caller', () => {
  it('normalizes a status-only 429 frame as a retryable rate limit through OpenRouter', async () => {
    stubFetchWithSseLines([
      '{"choices":[{"delta":{"content":"partial "}}]}',
      '{"error":{"status":429,"message":"zz quota exhausted for this key"}}',
    ]);
    const adapter = new OpenRouterAdapter({ apiKey: 'zz-key' });
    const chunks: string[] = [];

    const thrown = await rejectionFrom(
      adapter.stream(zzRequest as any, { onChunk: (chunk: string) => chunks.push(chunk) } as any),
    );

    const normalized = classifyError(thrown);
    expect(normalized.type).toBe('rate_limit');
    expect(normalized.retryable).toBe(true);
    expect(normalized.message).toContain('zz quota exhausted for this key');
    expect(chunks).toEqual(['partial ']);
  });

  it('normalizes a type-only auth frame as non-retryable auth through OpenAI', async () => {
    stubFetchWithSseLines([
      '{"error":{"type":"invalid_api_key","message":"zz key rejected mid-stream"}}',
    ]);
    const adapter = new OpenAIAdapter({ apiKey: 'zz-key' });

    const thrown = await rejectionFrom(adapter.stream(zzRequest as any, { onChunk: () => {} } as any));

    const normalized = classifyError(thrown);
    expect(normalized.type).toBe('auth');
    expect(normalized.retryable).toBe(false);
    expect(normalized.message).toContain('zz key rejected mid-stream');
  });

  it('carries the raw request through to the caller-visible error (pinned)', async () => {
    stubFetchWithSseLines(['{"error":{"status":429,"message":"zz quota exhausted for this key"}}']);
    const adapter = new OpenRouterAdapter({ apiKey: 'zz-key' });

    const thrown = await rejectionFrom(adapter.stream(zzRequest as any, { onChunk: () => {} } as any));

    expect((thrown as MembraneError).rawRequest).toMatchObject({ model: 'zz-model-1' });
  });

  it('still completes a normal stream (pinned)', async () => {
    stubFetchWithSseLines([
      '{"choices":[{"delta":{"content":"zz hello"}}]}',
      '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
      '[DONE]',
    ]);
    const adapter = new OpenRouterAdapter({ apiKey: 'zz-key' });
    const chunks: string[] = [];

    await adapter.stream(zzRequest as any, { onChunk: (chunk: string) => chunks.push(chunk) } as any);

    expect(chunks).toEqual(['zz hello']);
  });
});

/**
 * The Responses API adapter does not use the SSE line loop the other adapters
 * share: it dispatches on `event.type` and carries its own two error-frame
 * throw sites. Those threw structureless `Error`s for the same reason the
 * shared helper did, so a `response.failed` or an `error` event whose code did
 * not happen to contain a substring `handleError` matches — `overloaded_error`,
 * `too_many_requests`, `permission_denied` — normalized to unknown and
 * non-retryable. Both sites now route through the one classification, so the
 * token lists have a single source of truth.
 */
const zzResponsesRequest = {
  model: 'zz-model-1',
  maxTokens: 64,
  messages: [{ type: 'message', role: 'user', content: 'zz prompt' }],
};

function responsesFailedFrame(errorPayload: unknown): string {
  return JSON.stringify({
    type: 'response.failed',
    response: { id: 'resp_zz1', status: 'failed', output: [], error: errorPayload },
  });
}

async function responsesStreamCategory(dataLines: string[]): Promise<{ type: string; retryable: boolean; message: string }> {
  stubFetchWithSseLines(dataLines);
  const adapter = new OpenAIResponsesAPIAdapter({ apiKey: 'zz-key' });
  const thrown = await rejectionFrom(adapter.stream(zzResponsesRequest as any, { onChunk: () => {} } as any));
  const normalized = classifyError(thrown);
  return { type: normalized.type, retryable: normalized.retryable, message: normalized.message };
}

describe('OpenAI Responses API error frames keep their classification', () => {
  it('classifies an overloaded-shaped response.failed as retryable server-class', async () => {
    const normalized = await responsesStreamCategory([
      responsesFailedFrame({ code: 'overloaded_error', message: 'zz responses capacity gone' }),
    ]);

    expect(normalized.type).toBe('server');
    expect(normalized.retryable).toBe(true);
    expect(normalized.message).toContain('zz responses capacity gone');
  });

  it('classifies a permission-shaped response.failed as non-retryable auth', async () => {
    const normalized = await responsesStreamCategory([
      responsesFailedFrame({ code: 'permission_denied', message: 'zz responses key forbidden' }),
    ]);

    expect(normalized.type).toBe('auth');
    expect(normalized.retryable).toBe(false);
    expect(normalized.message).toContain('zz responses key forbidden');
  });

  it('classifies a throttle-shaped error event as a retryable rate limit', async () => {
    const normalized = await responsesStreamCategory([
      JSON.stringify({ type: 'error', code: 'too_many_requests', message: 'zz responses stream throttled' }),
    ]);

    expect(normalized.type).toBe('rate_limit');
    expect(normalized.retryable).toBe(true);
    expect(normalized.message).toContain('zz responses stream throttled');
  });

  it('still fails loudly on a response.failed carrying no error payload (pinned)', async () => {
    stubFetchWithSseLines([
      JSON.stringify({ type: 'response.failed', response: { id: 'resp_zz2', status: 'failed', output: [] } }),
    ]);
    const adapter = new OpenAIResponsesAPIAdapter({ apiKey: 'zz-key' });

    const thrown = await rejectionFrom(adapter.stream(zzResponsesRequest as any, { onChunk: () => {} } as any));

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('OpenAI Responses API');
  });

  it('leaves a normal Responses stream untouched (pinned)', async () => {
    stubFetchWithSseLines([
      JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_zz1', role: 'assistant', status: 'in_progress', content: [] } }),
      JSON.stringify({ type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'msg_zz1', delta: 'zz hello' }),
      JSON.stringify({ type: 'response.completed', response: { id: 'resp_zz3', model: 'zz-model-1', status: 'completed', output: [{ type: 'message', id: 'msg_zz1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'zz hello' }] }], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } }),
    ]);
    const adapter = new OpenAIResponsesAPIAdapter({ apiKey: 'zz-key' });
    const chunks: string[] = [];

    const result: any = await adapter.stream(zzResponsesRequest as any, { onChunk: (chunk: string) => chunks.push(chunk) } as any);

    expect(chunks).toEqual(['zz hello']);
    expect(result.stopReason).toBe('end_turn');
  });
});

/**
 * The Responses API's terminal-response check throws the same structured
 * payload from two reachable paths: the streaming one, where the terminal
 * frame (`response.completed`/`response.incomplete`) carries an `error`
 * object, and the non-streaming one, where a 200 body does. A 200 carrying an
 * error object never reaches an HTTP-status boundary classifier, so this
 * helper is the only lawful home for that classification.
 */
function jsonResponseStub(payload: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    ),
  );
}

describe('OpenAI Responses API terminal-response errors keep their classification', () => {
  it('classifies an error on the terminal stream frame (response.incomplete)', async () => {
    stubFetchWithSseLines([
      JSON.stringify({
        type: 'response.incomplete',
        response: {
          id: 'resp_zz4',
          model: 'zz-model-1',
          status: 'incomplete',
          output: [],
          error: { code: 'overloaded_error', message: 'zz terminal capacity gone' },
        },
      }),
    ]);
    const adapter = new OpenAIResponsesAPIAdapter({ apiKey: 'zz-key' });

    const thrown = await rejectionFrom(adapter.stream(zzResponsesRequest as any, { onChunk: () => {} } as any));

    const normalized = classifyError(thrown);
    expect(normalized.type).toBe('server');
    expect(normalized.retryable).toBe(true);
    expect(normalized.message).toContain('zz terminal capacity gone');
  });

  it('classifies an error on a non-streaming 200 body', async () => {
    jsonResponseStub({
      id: 'resp_zz5',
      model: 'zz-model-1',
      status: 'failed',
      output: [],
      error: { code: 'too_many_requests', message: 'zz completion throttled' },
    });
    const adapter = new OpenAIResponsesAPIAdapter({ apiKey: 'zz-key' });

    const thrown = await rejectionFrom(adapter.complete(zzResponsesRequest as any));

    const normalized = classifyError(thrown);
    expect(normalized.type).toBe('rate_limit');
    expect(normalized.retryable).toBe(true);
    expect(normalized.message).toContain('zz completion throttled');
  });

  it('does not call a non-streaming failure a stream error', async () => {
    jsonResponseStub({
      id: 'resp_zz6',
      model: 'zz-model-1',
      status: 'failed',
      output: [],
      error: { code: 'too_many_requests', message: 'zz completion throttled' },
    });
    const adapter = new OpenAIResponsesAPIAdapter({ apiKey: 'zz-key' });

    const thrown = await rejectionFrom(adapter.complete(zzResponsesRequest as any));

    expect((thrown as Error).message).toContain('OpenAI Responses API response error');
    expect((thrown as Error).message).not.toContain('stream error');
  });

  it('leaves a clean non-streaming response untouched (pinned)', async () => {
    jsonResponseStub({
      id: 'resp_zz7',
      model: 'zz-model-1',
      status: 'completed',
      output: [{ type: 'message', id: 'msg_zz7', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'zz hello' }] }],
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    });
    const adapter = new OpenAIResponsesAPIAdapter({ apiKey: 'zz-key' });

    const result: any = await adapter.complete(zzResponsesRequest as any);

    expect(result.content[0].text).toBe('zz hello');
  });
});
