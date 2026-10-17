/**
 * Membrane is the one layer that retries.
 *
 *  - AnthropicAdapter's SDK client sends each request a call makes once: its
 *    own retries (two by default, invisible to membrane) are off on them, so
 *    a 429 reaches a caller that asked for it at once, and `attempts`,
 *    `backoff` and `retryDelaysMs` count every send. The cache keepalive's
 *    background replays keep the SDK's retries.
 *  - What the SDK used to retry before delivery, membrane retries: a 5xx, a
 *    provider's 408 and a connection failure get the base schedule, five
 *    attempts by default, on every entry point. `maxRetries` still sets it.
 *  - A deadline that ran out on a sent request is the caller's: it isn't sent
 *    again. A connect timeout is, where the adapter can tell it apart.
 *  - The API's `x-should-retry` and `retry-after-ms`, which the SDK obeyed,
 *    are read where the adapter types the error.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { Membrane } from '../../src/membrane.js';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { OpenAIAdapter } from '../../src/providers/openai.js';
import { OpenAICompatibleAdapter } from '../../src/providers/openai-compatible.js';
import { OpenAICompletionsAdapter } from '../../src/providers/openai-completions.js';
import { OpenAIResponsesAPIAdapter } from '../../src/providers/openai-responses-api.js';
import { OpenAIResponsesAdapter } from '../../src/providers/openai-responses.js';
import { OpenRouterAdapter } from '../../src/providers/openrouter.js';
import { GeminiAdapter } from '../../src/providers/gemini.js';
import { BedrockAdapter } from '../../src/providers/bedrock.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import {
  MembraneError,
  deadlineExpired,
  errorFromThrown,
  isDeadlineExpiry,
  networkError,
  serverError,
  timeoutError,
} from '../../src/types/errors.js';
import type {
  NormalizedRequest,
  ProviderAdapter,
  ProviderRequest,
  ProviderResponse,
  StreamCallbacks,
  StreamEvent,
} from '../../src/types/index.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const REQUEST: NormalizedRequest = {
  messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz go' }] }],
  config: { model: 'zz-model', maxTokens: 64 },
};

const FAST = { retry: { retryDelayMs: 1, maxRetryDelayMs: 2, backoffMultiplier: 1 } };

/** Fails its first `failures` sends with `makeError`, then answers. */
class FailingAdapter implements ProviderAdapter {
  readonly name = 'zz-failing';
  sends = 0;
  constructor(private failures: number, private makeError: () => Error) {}
  supportsModel(): boolean { return true; }
  private answer(): ProviderResponse {
    return { content: [{ type: 'text', text: 'zz ok' }], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, raw: {} } as unknown as ProviderResponse;
  }
  async complete(): Promise<ProviderResponse> {
    if (++this.sends <= this.failures) throw this.makeError();
    return this.answer();
  }
  async stream(_request: ProviderRequest, callbacks: StreamCallbacks): Promise<ProviderResponse> {
    if (++this.sends <= this.failures) throw this.makeError();
    callbacks.onChunk('zz ok');
    return this.answer();
  }
}

const membrane = (adapter: ProviderAdapter, config: object = FAST) =>
  new Membrane(adapter, { formatter: new NativeFormatter(), ...config });

async function yielding(m: Membrane): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of m.streamYielding(REQUEST)) events.push(event);
  return events;
}

describe('membrane retries what the SDK used to, before delivery, on every entry point', () => {
  it('a 5xx gets the base schedule, five attempts by default', async () => {
    const adapter = new FailingAdapter(Infinity, () => serverError('zz internal', 500));
    const events = await yielding(membrane(adapter));

    expect(adapter.sends).toBe(5);
    const backoffs = events.filter((e) => e.type === 'backoff') as Extract<StreamEvent, { type: 'backoff' }>[];
    expect(backoffs.map((e) => [e.schedule, e.attempt, e.maxAttempts])).toEqual([
      ['base', 1, 4], ['base', 2, 4], ['base', 3, 4], ['base', 4, 4],
    ]);
    const error = (events.at(-1) as Extract<StreamEvent, { type: 'error' }>).error;
    expect(error).toMatchObject({ httpStatus: 500, attempts: 5 });
  });

  it.each(['complete', 'stream', 'yielding'] as const)('%s: a connection failure is sent again', async (entry) => {
    const adapter = new FailingAdapter(1, () => networkError('zz connection reset'));
    const m = membrane(adapter);
    if (entry === 'complete') await m.complete(REQUEST);
    else if (entry === 'stream') await m.stream(REQUEST);
    else expect((await yielding(m)).at(-1)?.type).toBe('complete');
    expect(adapter.sends).toBe(2);
  });

  it("a provider's 408 is sent again", async () => {
    const adapter = new FailingAdapter(1, () =>
      new MembraneError({ type: 'timeout', message: 'zz request timeout', retryable: true, httpStatus: 408, rawError: undefined }));
    await membrane(adapter).stream(REQUEST);
    expect(adapter.sends).toBe(2);
  });

  it.each(['complete', 'stream', 'yielding'] as const)('%s: maxRetries 1 leaves a 5xx to the caller', async (entry) => {
    const adapter = new FailingAdapter(Infinity, () => serverError('zz internal', 503));
    const m = membrane(adapter, { retry: { ...FAST.retry, maxRetries: 1 } });
    const thrown = entry === 'complete'
      ? await m.complete(REQUEST).catch((e) => e)
      : entry === 'stream'
        ? await m.stream(REQUEST).catch((e) => e)
        : ((await yielding(m)).at(-1) as Extract<StreamEvent, { type: 'error' }>).error;
    expect(thrown).toMatchObject({ httpStatus: 503, attempts: 1 });
    expect(adapter.sends).toBe(1);
  });

  it.each(['complete', 'stream', 'yielding'] as const)("%s: an adapter's own deadline is not sent again", async (entry) => {
    const adapter = new FailingAdapter(Infinity, () => deadlineExpired(timeoutError('zz first-event timeout')));
    const m = membrane(adapter);
    const thrown = entry === 'complete'
      ? await m.complete(REQUEST).catch((e) => e)
      : entry === 'stream'
        ? await m.stream(REQUEST).catch((e) => e)
        : ((await yielding(m)).at(-1) as Extract<StreamEvent, { type: 'error' }>).error;
    // Still the retryable timeout the caller sees; membrane just doesn't spend
    // another full deadline on it.
    expect(thrown).toMatchObject({ type: 'timeout', retryable: true, attempts: 1 });
    expect(adapter.sends).toBe(1);
  });
});

describe('AnthropicAdapter sends each request once', () => {
  const overloadedBody = JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'zz overloaded' } });
  const adapter = () => new AnthropicAdapter({ apiKey: 'zz-key', cacheKeepalive: { enabled: false } });
  const wire: ProviderRequest = { model: 'zz-model', messages: [{ role: 'user', content: 'zz go' }], maxTokens: 16 };

  it.each(['complete', 'stream'] as const)('%s: a 529 is one HTTP send, not three', async (entry) => {
    const fetch = vi.fn(async () => new Response(overloadedBody, { status: 529, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    const a = adapter();
    const thrown = entry === 'complete'
      ? await a.complete(wire).catch((e) => e)
      : await a.stream(wire, { onChunk() {} }).catch((e) => e);
    expect(thrown).toMatchObject({ type: 'server', httpStatus: 529, retryable: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('the cache keepalive’s replays keep the SDK’s own retries', async () => {
    // A replay refreshes an idle cache in the background, with no caller
    // waiting, so it keeps the SDK's default of two retries.
    const fetch = vi.fn(async () => new Response(
      JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'zz internal' } }),
      { status: 500, headers: { 'content-type': 'application/json', 'retry-after-ms': '1' } },
    ));
    vi.stubGlobal('fetch', fetch);
    const keepalive = (new AnthropicAdapter({ apiKey: 'zz-key' }).cacheKeepalive as any);
    await keepalive.send({ model: 'zz-model', max_tokens: 0, messages: [{ role: 'user', content: 'zz go' }] }, {}).catch(() => {});
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('through membrane, a 429 left to the caller arrives after one send', async () => {
    const fetch = vi.fn(async () => new Response(
      JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'zz slow down' } }),
      { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '30' } },
    ));
    vi.stubGlobal('fetch', fetch);
    const m = new Membrane(adapter(), { formatter: new NativeFormatter() });
    await expect(m.stream(REQUEST, { retryRateLimits: false })).rejects.toMatchObject({
      type: 'rate_limit', retryAfterMs: 30_000, attempts: 1,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("AnthropicAdapter's watchdog expiry is a deadline", () => {
  it('a stream with no first event ends with a timeout that carries the deadline mark', async () => {
    // Headers arrive, then nothing: the body stays open until the request is aborted.
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: { signal?: AbortSignal }) => new Response(
      new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )));
    const adapter = new AnthropicAdapter({ apiKey: 'zz-key', cacheKeepalive: { enabled: false } });
    const wire: ProviderRequest = { model: 'zz-model', messages: [{ role: 'user', content: 'zz go' }], maxTokens: 16 };
    const thrown = await adapter.stream(wire, { onChunk() {} }, { firstEventTimeoutMs: 50 }).catch((e) => e);

    expect(thrown).toMatchObject({ type: 'timeout', retryable: true });
    expect(isDeadlineExpiry(thrown)).toBe(true);
  });
});

describe('a deadline on a sent request is the caller’s; a connect timeout is sent again', () => {
  // The shapes Node's fetch (undici) rejects with: `TypeError: fetch failed`
  // before response headers, `TypeError: terminated` while reading the body,
  // each with the undici error as its cause.
  const undici = (message: string, name: string, code: string, outer = 'fetch failed') =>
    new TypeError(outer, { cause: Object.assign(new Error(message), { name, code }) });
  const connectTimeout = () => undici('Connect Timeout Error', 'ConnectTimeoutError', 'UND_ERR_CONNECT_TIMEOUT');
  const headersTimeout = () => undici('Headers Timeout Error', 'HeadersTimeoutError', 'UND_ERR_HEADERS_TIMEOUT');
  const bodyTimeout = () => undici('Body Timeout Error', 'BodyTimeoutError', 'UND_ERR_BODY_TIMEOUT', 'terminated');
  const systemTimeout = () => undici('connect ETIMEDOUT 192.0.2.1:443', 'Error', 'ETIMEDOUT');
  const reset = () => undici('read ECONNRESET', 'Error', 'ECONNRESET');
  // What Bun's fetch rejects with when its own timeout ends a request.
  const bunTimeout = () => new DOMException('The operation timed out.', 'TimeoutError');

  async function run(m: Membrane, entry: 'complete' | 'stream' | 'yielding'): Promise<unknown> {
    if (entry === 'complete') return m.complete(REQUEST).catch((e) => e);
    if (entry === 'stream') return m.stream(REQUEST).catch((e) => e);
    const last = (await yielding(m)).at(-1) as StreamEvent;
    return last.type === 'error' ? last.error : last;
  }

  it('a TimeoutError is a retryable timeout by its name, whatever its message', () => {
    const typed = errorFromThrown(new DOMException('zz no keyword here', 'TimeoutError'));
    expect(typed).toMatchObject({ type: 'timeout', retryable: true });
    expect(isDeadlineExpiry(typed)).toBe(true);
  });

  it('a TimeoutError under a wrapper is a retryable, marked timeout, whatever the wrapper says', () => {
    // As the SDK's MessageStream wraps a failed read: a plain error whose
    // cause is the runtime's TimeoutError.
    const wrapped = new Error('zz stream read failed', { cause: new DOMException('zz', 'TimeoutError') });
    const typed = errorFromThrown(wrapped);
    expect(typed).toMatchObject({ type: 'timeout', retryable: true });
    expect(isDeadlineExpiry(typed)).toBe(true);
  });

  it('a mark set by a second loaded copy of membrane survives the retyping', () => {
    // Another copy's MembraneError isn't this copy's, so it's typed afresh,
    // and the mark, keyed by Symbol.for, goes with it.
    const foreign = Object.assign(new Error('zz watchdog'), { [Symbol.for('membrane.deadlineExpiry')]: true });
    expect(isDeadlineExpiry(errorFromThrown(foreign))).toBe(true);
  });

  it('errorFromThrown keeps an error that is already typed, and its mark', () => {
    const marked = deadlineExpired(timeoutError('zz watchdog'));
    expect(errorFromThrown(marked)).toBe(marked);
    expect(isDeadlineExpiry(errorFromThrown(marked))).toBe(true);
  });

  it('the API’s x-should-retry advice keeps a deadline’s mark', () => {
    const sdkTimeout = Object.assign(new Anthropic.APIConnectionTimeoutError(), {
      headers: new Headers({ 'x-should-retry': 'false' }),
    });
    const typed = (new AnthropicAdapter({ apiKey: 'zz-key', cacheKeepalive: { enabled: false } }) as any).handleError(sdkTimeout, {});
    expect(typed).toMatchObject({ type: 'timeout', retryable: false });
    expect(isDeadlineExpiry(typed)).toBe(true);
  });

  it.each([
    ['headers timeout', true, headersTimeout],
    ['body timeout', true, bodyTimeout],
    ['Bun fetch timeout', true, bunTimeout],
    ['connect timeout', false, connectTimeout],
    ['ETIMEDOUT', false, systemTimeout],
    ['reset', false, reset],
  ] as const)('errorFromThrown: a %s is a deadline: %s', (_name, deadline, make) => {
    const typed = errorFromThrown(make(), { zz: 'request' });
    expect(typed).toMatchObject({ retryable: true, rawRequest: { zz: 'request' } });
    expect(isDeadlineExpiry(typed)).toBe(deadline);
  });

  describe('every fetch adapter marks undici’s headers timeout', () => {
    const wire: ProviderRequest = { model: 'zz-model', messages: [{ role: 'user', content: 'zz go' }], maxTokens: 16 };
    const adapters = [
      ['OpenAI', () => new OpenAIAdapter({ apiKey: 'zz-key' })],
      ['compatible', () => new OpenAICompatibleAdapter({ apiKey: 'zz-key', baseURL: 'https://zz.invalid/v1' })],
      ['completions', () => new OpenAICompletionsAdapter({ apiKey: 'zz-key', baseURL: 'https://zz.invalid/v1' })],
      ['Responses API', () => new OpenAIResponsesAPIAdapter({ apiKey: 'zz-key' })],
      ['Responses', () => new OpenAIResponsesAdapter({ apiKey: 'zz-key' })],
      ['OpenRouter', () => new OpenRouterAdapter({ apiKey: 'zz-key' })],
      ['Gemini', () => new GeminiAdapter({ apiKey: 'zz-key' })],
      ['Bedrock', () => new BedrockAdapter({ accessKeyId: 'zz-access', secretAccessKey: 'zz-secret', region: 'us-east-1' })],
    ] as const;
    for (const [name, create] of adapters) {
      it.each(['complete', 'stream'] as const)(`${name} %s`, async (entry) => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw headersTimeout(); }));
        const adapter = create();
        const thrown = entry === 'complete'
          ? await adapter.complete(wire).catch((e) => e)
          : await adapter.stream(wire, { onChunk() {} }).catch((e) => e);
        expect(thrown).toMatchObject({ type: 'timeout', retryable: true });
        expect(isDeadlineExpiry(thrown)).toBe(true);
      });
    }
  });

  describe('a fetch adapter (OpenAIAdapter)', () => {
    const openai = () => membrane(new OpenAIAdapter({ apiKey: 'zz-key' }));

    it.each(['complete', 'stream', 'yielding'] as const)('%s: undici’s headers timeout is sent once', async (entry) => {
      const fetch = vi.fn(async () => { throw headersTimeout(); });
      vi.stubGlobal('fetch', fetch);
      expect(await run(openai(), entry)).toMatchObject({ type: 'timeout', retryable: true, attempts: 1 });
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it.each(['complete', 'stream', 'yielding'] as const)('%s: undici’s body timeout is sent once', async (entry) => {
      // Headers arrive; the body then fails before any data, as undici's
      // bodyTimeout fails it.
      const fetch = vi.fn(async () => new Response(
        new ReadableStream({ start(controller) { controller.error(bodyTimeout()); } }),
        { status: 200, headers: { 'content-type': entry === 'complete' ? 'application/json' : 'text/event-stream' } },
      ));
      vi.stubGlobal('fetch', fetch);
      expect(await run(openai(), entry)).toMatchObject({ type: 'timeout', retryable: true, attempts: 1 });
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it.each(['complete', 'stream', 'yielding'] as const)('%s: a connect timeout gets the base schedule', async (entry) => {
      const fetch = vi.fn(async () => { throw connectTimeout(); });
      vi.stubGlobal('fetch', fetch);
      expect(await run(openai(), entry)).toMatchObject({ type: 'timeout', retryable: true, attempts: 5 });
      expect(fetch).toHaveBeenCalledTimes(5);
    });

    it('ETIMEDOUT gets the base schedule', async () => {
      const fetch = vi.fn(async () => { throw systemTimeout(); });
      vi.stubGlobal('fetch', fetch);
      expect(await run(openai(), 'stream')).toMatchObject({ type: 'timeout', attempts: 5 });
      expect(fetch).toHaveBeenCalledTimes(5);
    });

    it.each(['complete', 'stream', 'yielding'] as const)('%s: Bun’s fetch timeout is sent once', async (entry) => {
      const fetch = vi.fn(async () => { throw bunTimeout(); });
      vi.stubGlobal('fetch', fetch);
      expect(await run(openai(), entry)).toMatchObject({ type: 'timeout', retryable: true, attempts: 1 });
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    // A fetch that, once the send is in flight, fires the caller's cancel,
    // then rejects with `reason(signal)` when the request's signal aborts.
    const untilAborted = (cancel: () => void, reason: (signal: AbortSignal) => unknown) =>
      vi.fn((_url: unknown, init?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(reason(init.signal!)));
        cancel();
      }));

    it.each(['complete', 'stream', 'yielding'] as const)('%s: a caller’s own AbortSignal.timeout() is still a cancellation', async (entry) => {
      // It rejects with the same TimeoutError, but the caller's signal decides.
      // The caller's signal fires as AbortSignal.timeout()'s does, once the
      // send is in flight.
      const controller = new AbortController();
      const fetch = untilAborted(
        () => controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
        (signal) => signal.reason,
      );
      vi.stubGlobal('fetch', fetch);
      const m = openai();
      const signal = controller.signal;
      if (entry === 'complete') {
        expect(await m.complete(REQUEST, { signal }).catch((e) => e)).toMatchObject({ type: 'abort', retryable: false });
      } else if (entry === 'stream') {
        expect(await m.stream(REQUEST, { signal })).toMatchObject({ aborted: true });
      } else {
        const events: StreamEvent[] = [];
        for await (const event of m.streamYielding(REQUEST, { signal })) events.push(event);
        expect(events.map((e) => e.type)).toEqual(['aborted']);
      }
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it.each(['stream', 'yielding'] as const)('%s: a retryable failure after the caller cancelled asks onError nothing', async (entry) => {
      // The caller cancels once the send is in flight, and the send then
      // fails as a connection failure would.
      const controller = new AbortController();
      const fetch = untilAborted(() => controller.abort(), () => new TypeError('fetch failed'));
      vi.stubGlobal('fetch', fetch);
      const onError = vi.fn(async () => 'retry' as const);
      const m = new Membrane(new OpenAIAdapter({ apiKey: 'zz-key' }), { formatter: new NativeFormatter(), ...FAST, hooks: { onError } });
      if (entry === 'stream') {
        expect(await m.stream(REQUEST, { signal: controller.signal })).toMatchObject({ aborted: true });
      } else {
        const events: StreamEvent[] = [];
        for await (const event of m.streamYielding(REQUEST, { signal: controller.signal })) events.push(event);
        expect(events.map((e) => e.type)).toEqual(['aborted']);
      }
      expect(onError).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('AnthropicAdapter, whose SDK reports every timeout the same way', () => {
    const anthropic = () => membrane(new AnthropicAdapter({ apiKey: 'zz-key', cacheKeepalive: { enabled: false } }));

    it.each(['complete', 'stream', 'yielding'] as const)('%s: a connect timeout is sent once', async (entry) => {
      const fetch = vi.fn(async () => { throw connectTimeout(); });
      vi.stubGlobal('fetch', fetch);
      const thrown = await run(anthropic(), entry);
      expect(thrown).toMatchObject({ type: 'timeout', retryable: true, attempts: 1 });
      expect(isDeadlineExpiry(thrown)).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it.each(['complete', 'stream', 'yielding'] as const)('%s: undici’s headers timeout is sent once', async (entry) => {
      const fetch = vi.fn(async () => { throw headersTimeout(); });
      vi.stubGlobal('fetch', fetch);
      expect(await run(anthropic(), entry)).toMatchObject({ type: 'timeout', retryable: true, attempts: 1 });
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it.each(['complete', 'stream', 'yielding'] as const)('%s: a reset connection gets the base schedule', async (entry) => {
      const fetch = vi.fn(async () => { throw reset(); });
      vi.stubGlobal('fetch', fetch);
      expect(await run(anthropic(), entry)).toMatchObject({ type: 'network', retryable: true, attempts: 5 });
      expect(fetch).toHaveBeenCalledTimes(5);
    });

    // A read that fails after the headers reaches the stream paths wrapped
    // once more, by the SDK's MessageStream, so its code is two causes down.
    const failedRead = (failure: () => Error) => vi.fn(async () => new Response(
      new ReadableStream({ start(controller) { controller.error(failure()); } }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ));

    it.each(['stream', 'yielding'] as const)('%s: undici’s body timeout before any event is sent once', async (entry) => {
      const fetch = failedRead(bodyTimeout);
      vi.stubGlobal('fetch', fetch);
      const thrown = await run(anthropic(), entry);
      expect(thrown).toMatchObject({ type: 'timeout', retryable: true, attempts: 1 });
      expect(isDeadlineExpiry(thrown)).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it.each(['stream', 'yielding'] as const)('%s: Bun’s fetch timeout before any event, wrapped by MessageStream, is sent once', async (entry) => {
      const fetch = failedRead(bunTimeout);
      vi.stubGlobal('fetch', fetch);
      const thrown = await run(anthropic(), entry);
      expect(thrown).toMatchObject({ type: 'timeout', retryable: true, attempts: 1 });
      expect(isDeadlineExpiry(thrown)).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it.each(['stream', 'yielding'] as const)('%s: a socket closed before any event gets the base schedule', async (entry) => {
      const fetch = failedRead(() => undici('other side closed', 'SocketError', 'UND_ERR_SOCKET', 'terminated'));
      vi.stubGlobal('fetch', fetch);
      expect(await run(anthropic(), entry)).toMatchObject({ type: 'network', retryable: true, attempts: 5 });
      expect(fetch).toHaveBeenCalledTimes(5);
    });
  });

  it.each(['complete', 'stream', 'yielding'] as const)(
    '%s: an adapter that throws what fetch threw gets the same rule',
    async (entry) => {
      // Not every adapter types its own failures. Membrane types one with
      // errorFromThrown, decides the retry on that, and every entry point
      // ends with it, streamYielding's error event included.
      const adapter = new FailingAdapter(Infinity, headersTimeout);
      const thrown = await run(membrane(adapter), entry);
      expect(adapter.sends).toBe(1);
      expect(isDeadlineExpiry(thrown)).toBe(true);
    },
  );
});

describe("AnthropicAdapter reads the API's retry advice, as the SDK did", () => {
  const classify = (error: unknown) =>
    (new AnthropicAdapter({ apiKey: 'zz-key', cacheKeepalive: { enabled: false } }) as any).handleError(error, {});
  const apiError = (status: number, type: string, headers: Record<string, string>) =>
    new Anthropic.APIError(status, { error: { type, message: 'zz' } }, undefined, new Headers(headers));

  it('x-should-retry: false makes a 5xx not retryable', () => {
    expect(classify(apiError(500, 'api_error', { 'x-should-retry': 'false' }))).toMatchObject({ type: 'server', retryable: false });
  });

  it('x-should-retry: true makes a 4xx retryable', () => {
    expect(classify(apiError(400, 'invalid_request_error', { 'x-should-retry': 'true' }))).toMatchObject({ retryable: true });
  });

  it('no x-should-retry leaves the status to decide', () => {
    expect(classify(apiError(500, 'api_error', {}))).toMatchObject({ retryable: true });
    expect(classify(apiError(400, 'invalid_request_error', {}))).toMatchObject({ retryable: false });
  });

  it('retry-after-ms is read before retry-after', () => {
    expect(classify(apiError(429, 'rate_limit_error', { 'retry-after-ms': '1500', 'retry-after': '30' }))).toMatchObject({
      type: 'rate_limit', retryAfterMs: 1500,
    });
  });
});
