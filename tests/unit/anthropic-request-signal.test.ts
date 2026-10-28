import { getEventListeners } from 'node:events';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import type { ProviderRequest } from '../../src/types/index.js';

// membrane#212: SDK 0.52 adds an abort listener to the signal each request is
// handed (fetchWithTimeout, MessageStream) and never removes it, and that
// listener holds the request's own AbortController. So whatever signal the
// adapter hands the SDK has to be one that nothing keeps once the request
// settles, or each request's controllers stay alive with it. The caller's own
// signal isn't: a reused one gains a listener per call. Nor is a signal from
// AbortSignal.any(): one that holds a listener stays alive until a source
// aborts, on Node 22.12 (its gcPersistentSignals) and on Bun 1.4, so a derived
// signal only moves the leak. These keep a weak reference to the signal each
// request hands fetch, and count how many are still alive once the calls have
// settled and the garbage collector has run.

setFlagsFromString('--expose-gc');
const collectGarbage = runInNewContext('gc') as () => void;

const CALLS = 50;
// A request's objects can stay reachable for a moment after it settles; a
// leak keeps every request's.
const SLACK = 2;

const request: ProviderRequest = {
  model: 'claude-sonnet-4-6', maxTokens: 32,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
};
const message = {
  id: 'msg_test', type: 'message', role: 'assistant', model: request.model,
  content: [{ type: 'text', text: 'hello back' }], stop_reason: 'end_turn', stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 3 },
};
const frame = (event: string, data: object): string =>
  `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`;
const events = [
  frame('message_start', { message: { ...message, content: [], stop_reason: null } }),
  frame('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
  frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'hello back' } }),
  frame('content_block_stop', { index: 0 }),
  frame('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }),
  frame('message_stop', {}),
].join('');

function stubAnthropic(): WeakRef<AbortSignal>[] {
  const seen: WeakRef<AbortSignal>[] = [];
  vi.stubGlobal('fetch', async (_input: unknown, init: RequestInit) => {
    if (init.signal) seen.push(new WeakRef(init.signal));
    const streaming = JSON.parse(String(init.body)).stream === true;
    return streaming
      ? new Response(events, { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_fixture' } })
      : new Response(JSON.stringify(message), { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_fixture' } });
  });
  return seen;
}

// Some AbortSignal.any() composites are freed only by a FinalizationRegistry
// callback that runs after a collection, so this collects again after those
// callbacks have had their turns: what's left is what stays.
async function stillAlive(seen: WeakRef<AbortSignal>[]): Promise<number> {
  for (let i = 0; i < 4; i++) {
    collectGarbage();
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return seen.filter(ref => ref.deref() !== undefined).length;
}

const adapters = {
  'an API key': () => new AnthropicAdapter({ apiKey: 'sk-test', cacheKeepalive: { enabled: false } }),
  'a credentials resolver': () => new AnthropicAdapter({
    credentials: async () => ({ token: 'tok-test' }), cacheKeepalive: { enabled: false },
  }),
};

afterEach(() => vi.unstubAllGlobals());

describe("the signal the Anthropic adapter hands the SDK (membrane#212)", () => {
  describe.each(Object.entries(adapters))('with %s', (_auth, create) => {
    it('complete() on one reused caller signal keeps no request alive', async () => {
      const seen = stubAnthropic();
      const adapter = create();
      const caller = new AbortController();
      for (let i = 0; i < CALLS; i++) {
        expect((await adapter.complete(request, { signal: caller.signal })).stopReason).toBe('end_turn');
      }
      expect(seen).toHaveLength(CALLS);
      expect(await stillAlive(seen)).toBeLessThanOrEqual(SLACK);
      expect(getEventListeners(caller.signal, 'abort')).toHaveLength(0);
    });

    it('complete() with a new caller signal each call keeps no request alive', async () => {
      const seen = stubAnthropic();
      const adapter = create();
      for (let i = 0; i < CALLS; i++) {
        expect((await adapter.complete(request, { signal: new AbortController().signal })).stopReason).toBe('end_turn');
      }
      expect(seen).toHaveLength(CALLS);
      expect(await stillAlive(seen)).toBeLessThanOrEqual(SLACK);
    });

    it('complete() that fails leaves no listener on a reused caller signal', async () => {
      vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
        type: 'error', error: { type: 'invalid_request_error', message: 'zz bad request' },
      }), { status: 400, headers: { 'content-type': 'application/json', 'request-id': 'req_fixture' } }));
      const adapter = create();
      const caller = new AbortController();
      for (let i = 0; i < 3; i++) {
        await expect(adapter.complete(request, { signal: caller.signal })).rejects.toMatchObject({ httpStatus: 400 });
      }
      expect(getEventListeners(caller.signal, 'abort')).toHaveLength(0);
    });

    for (const method of ['complete', 'stream'] as const) {
      it(`a caller's abort still ends a ${method}() request, as an abort`, async () => {
        const handed: AbortSignal[] = [];
        vi.stubGlobal('fetch', (_input: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
          handed.push(init.signal!);
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
        }));
        const adapter = create();
        const caller = new AbortController();
        const call = method === 'complete'
          ? adapter.complete(request, { signal: caller.signal })
          : adapter.stream(request, { onChunk: () => {} }, { signal: caller.signal });
        await vi.waitFor(() => expect(handed).toHaveLength(1));
        caller.abort(new Error('zz caller gave up'));
        await expect(call).rejects.toMatchObject({ type: 'abort', retryable: false });
        expect(handed[0]!.aborted).toBe(true);
        expect(getEventListeners(caller.signal, 'abort')).toHaveLength(0);
      });
    }

    it('a stream() that completes keeps no request alive', async () => {
      const seen = stubAnthropic();
      const adapter = create();
      for (let i = 0; i < CALLS; i++) {
        expect((await adapter.stream(request, { onChunk: () => {} })).stopReason).toBe('end_turn');
      }
      expect(seen).toHaveLength(CALLS);
      expect(await stillAlive(seen)).toBeLessThanOrEqual(SLACK);
    });
  });
});
