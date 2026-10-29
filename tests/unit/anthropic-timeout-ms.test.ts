import { getEventListeners } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import type { ProviderRequest } from '../../src/types/index.js';

// membrane#97: ProviderRequestOptions.timeoutMs is documented as the request
// timeout and the other provider adapters honour it through
// createCombinedSignal; the Anthropic adapter never reads it. A stream whose
// body keeps sending deltas re-arms the idle watchdog forever, so besides the
// caller's own signal, timeoutMs is the only whole-call bound a caller has —
// and here it is inert.
//
// RED on main: the call ignores timeoutMs and runs on until the caller's own
// abort, or the test's timeout where there is none. GREEN once the adapter
// bounds the whole call by timeoutMs with the TimeoutAbortError
// classification the other adapters' timeoutMs gives
// (type 'timeout', retryable false — a spent whole-call budget, unlike the
// idle watchdog's retryable stall).

const TIMEOUT_MS = 40;
const DELTA_MS = 20;
const CALLER_ABORT_MS = 600;

const request: ProviderRequest = {
  model: 'claude-sonnet-4-6', maxTokens: 32,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
};
const message = {
  id: 'msg_test', type: 'message', role: 'assistant', model: request.model,
  content: [], stop_reason: null, stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 0 },
};
const frame = (event: string, data: object): string =>
  `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`;

function foreverStreamingResponse(init: RequestInit | undefined): Response {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let done = false;
  const stop = (error?: Error): void => {
    if (done) return;
    done = true;
    try { if (error) controller.error(error); else controller.close(); } catch { }
  };
  const body = new ReadableStream<Uint8Array>({
    start(c) { controller = c; },
    cancel() { done = true; },
  });
  init?.signal?.addEventListener('abort', () => {
    stop(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
  }, { once: true });
  void (async () => {
    const emit = (text: string): void => { if (!done) { try { controller.enqueue(encoder.encode(text)); } catch { } } };
    emit(frame('message_start', { message }));
    emit(frame('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }));
    for (let i = 0; !done; i++) {
      emit(frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text: `t${i} ` } }));
      await new Promise<void>(resolve => setTimeout(resolve, DELTA_MS));
    }
  })();
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_fixture' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function completingResponse(): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(frame('message_start', { message })));
      controller.enqueue(encoder.encode(frame('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })));
      controller.enqueue(encoder.encode(frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'hello back' } })));
      controller.enqueue(encoder.encode(frame('content_block_stop', { index: 0 })));
      controller.enqueue(encoder.encode(frame('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } })));
      controller.enqueue(encoder.encode(frame('message_stop', {})));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_fixture' } });
}

function unfinishedBodyResponse(init: RequestInit | undefined): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"id":"msg_test",'));
      init?.signal?.addEventListener('abort', () => {
        try { controller.error(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })); } catch { }
      }, { once: true });
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_fixture' } });
}

function hangingResponse(init: RequestInit | undefined): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
    }, { once: true });
  });
}

describe('Anthropic adapter timeoutMs (membrane#97)', () => {
  it('bounds complete() by timeoutMs when the response never arrives', async () => {
    vi.stubGlobal('fetch', async (_input: unknown, init: RequestInit) => hangingResponse(init));
    const adapter = new AnthropicAdapter({ apiKey: 'sk-test', cacheKeepalive: { enabled: false } });
    await expect(
      adapter.complete(request, { timeoutMs: TIMEOUT_MS }),
    ).rejects.toMatchObject({ type: 'timeout', retryable: false, name: 'TimeoutAbortError' });
  });

  it('bounds complete() by timeoutMs once the headers have come and the body never finishes', async () => {
    vi.stubGlobal('fetch', async (_input: unknown, init: RequestInit) => unfinishedBodyResponse(init));
    const adapter = new AnthropicAdapter({ apiKey: 'sk-test', cacheKeepalive: { enabled: false } });
    await expect(
      adapter.complete(request, { timeoutMs: TIMEOUT_MS }),
    ).rejects.toMatchObject({ type: 'timeout', retryable: false, name: 'TimeoutAbortError' });
  });

  // The SDK client takes the global fetch when it is built, so each adapter
  // is built after its stub.
  it('keeps a caller abort an abort when timeoutMs is set too, on stream() and complete()', async () => {
    const aborted = { type: 'abort', retryable: false, name: 'MembraneError' };
    const streamingFetch = vi.fn(async (_input: unknown, init: RequestInit) => foreverStreamingResponse(init));
    vi.stubGlobal('fetch', streamingFetch);
    const streamer = new AnthropicAdapter({ apiKey: 'sk-test', cacheKeepalive: { enabled: false } });
    const streaming = new AbortController();
    setTimeout(() => streaming.abort(), DELTA_MS * 2);
    await expect(
      streamer.stream(request, { onChunk: () => {} }, { timeoutMs: 600_000, signal: streaming.signal }),
    ).rejects.toMatchObject(aborted);
    expect(streamingFetch).toHaveBeenCalledTimes(1);

    const hangingFetch = vi.fn(async (_input: unknown, init: RequestInit) => hangingResponse(init));
    vi.stubGlobal('fetch', hangingFetch);
    const completer = new AnthropicAdapter({ apiKey: 'sk-test', cacheKeepalive: { enabled: false } });
    const completing = new AbortController();
    setTimeout(() => completing.abort(), DELTA_MS);
    await expect(
      completer.complete(request, { timeoutMs: 600_000, signal: completing.signal }),
    ).rejects.toMatchObject(aborted);
    expect(hangingFetch).toHaveBeenCalledTimes(1);
  });

  it('bounds a stream that never stops sending deltas by timeoutMs, not by the caller', async () => {
    vi.stubGlobal('fetch', async (_input: unknown, init: RequestInit) => foreverStreamingResponse(init));
    const adapter = new AnthropicAdapter({ apiKey: 'sk-test', cacheKeepalive: { enabled: false } });
    const caller = new AbortController();
    const callerAbort = setTimeout(() => caller.abort(), CALLER_ABORT_MS);
    try {
      await expect(
        adapter.stream(request, { onChunk: () => {} }, {
          timeoutMs: TIMEOUT_MS, idleTimeoutMs: 5000, firstEventTimeoutMs: 5000, signal: caller.signal,
        }),
      ).rejects.toMatchObject({ type: 'timeout', retryable: false, name: 'TimeoutAbortError' });
    } finally {
      clearTimeout(callerAbort);
      caller.abort();
    }
  });

  // The combined signal's cleanup must run on the SUCCESS paths too: without
  // it, a finished call leaves the deadline timer armed (setLongTimeout is a
  // plain setTimeout, not unref'd — a 600s timeoutMs keeps a script's process
  // alive ten minutes after its last stream) and a dead listener on the
  // caller's signal.
  it('releases the caller-signal listener once a stream completes, with or without timeoutMs', async () => {
    vi.stubGlobal('fetch', async () => completingResponse());
    const adapter = new AnthropicAdapter({ apiKey: 'sk-test', cacheKeepalive: { enabled: false } });
    for (const timeoutMs of [600_000, undefined]) {
      const caller = new AbortController();
      const result = await adapter.stream(request, { onChunk: () => {} }, { signal: caller.signal, ...(timeoutMs ? { timeoutMs } : {}) });
      expect(result.stopReason).toBe('end_turn');
      expect(getEventListeners(caller.signal, 'abort')).toHaveLength(0);
    }
  });

  it('releases the deadline and the caller-signal listener once complete() returns', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      ...message, content: [{ type: 'text', text: 'hello back' }], stop_reason: 'end_turn',
    }), { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_fixture' } }));
    const adapter = new AnthropicAdapter({ apiKey: 'sk-test', cacheKeepalive: { enabled: false } });
    const caller = new AbortController();
    const timers = () => process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length;
    const timersBefore = timers();
    const result = await adapter.complete(request, { timeoutMs: 600_000, signal: caller.signal });
    expect(result.stopReason).toBe('end_turn');
    expect(getEventListeners(caller.signal, 'abort')).toHaveLength(0);
    expect(timers()).toBeLessThanOrEqual(timersBefore);
  });

  // membrane#212: the SDK's fetchWithTimeout adds an abort listener to the
  // signal it's handed and never removes it, and without a credentials
  // resolver credentialSession used to hand it the caller's own signal. With
  // no timeoutMs there is no combined signal in between, so a caller reusing
  // one signal gained one listener per complete() — 3 after 3 calls on the
  // unfixed adapter.
  it('complete() with an API key and no timeoutMs leaves no listener on a reused caller signal (#212)', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      ...message, content: [{ type: 'text', text: 'hello back' }], stop_reason: 'end_turn',
    }), { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_fixture' } }));
    const adapter = new AnthropicAdapter({ apiKey: 'sk-test', cacheKeepalive: { enabled: false } });
    const caller = new AbortController();
    for (let i = 0; i < 3; i++) {
      const result = await adapter.complete(request, { signal: caller.signal });
      expect(result.stopReason).toBe('end_turn');
    }
    expect(getEventListeners(caller.signal, 'abort')).toHaveLength(0);
  });

  it("a caller abort still aborts complete() through the request's own signal (#212)", async () => {
    vi.stubGlobal('fetch', async (_input: unknown, init: RequestInit) => hangingResponse(init));
    const adapter = new AnthropicAdapter({ apiKey: 'sk-test', cacheKeepalive: { enabled: false } });
    const caller = new AbortController();
    const pending = adapter.complete(request, { signal: caller.signal });
    setTimeout(() => caller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ type: 'abort' });
    expect(getEventListeners(caller.signal, 'abort')).toHaveLength(0);
  });

  it('releases the caller-signal listener when a stream or complete() fails', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      type: 'error', error: { type: 'invalid_request_error', message: 'zz bad request' },
    }), { status: 400, headers: { 'content-type': 'application/json', 'request-id': 'req_fixture' } }));
    const adapter = new AnthropicAdapter({ apiKey: 'sk-test', cacheKeepalive: { enabled: false } });
    for (const timeoutMs of [600_000, undefined]) {
      const caller = new AbortController();
      await expect(
        adapter.stream(request, { onChunk: () => {} }, { signal: caller.signal, ...(timeoutMs ? { timeoutMs } : {}) }),
      ).rejects.toMatchObject({ httpStatus: 400 });
      expect(getEventListeners(caller.signal, 'abort')).toHaveLength(0);
    }
    const caller = new AbortController();
    await expect(
      adapter.complete(request, { timeoutMs: 600_000, signal: caller.signal }),
    ).rejects.toMatchObject({ httpStatus: 400 });
    expect(getEventListeners(caller.signal, 'abort')).toHaveLength(0);
  });
});
