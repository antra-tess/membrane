import { afterEach, expect, it, vi } from 'vitest';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { Membrane } from '../../src/membrane.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { lineageKey, type CacheKeepaliveConfig, type KeepaliveDiagnostic, type KeepaliveEvent, type KeepaliveSuppression } from '../../src/cache-keepalive.js';
import type { ProviderRequest } from '../../src/types/index.js';

const adapters: AnthropicAdapter[] = [];
afterEach(() => {
  for (const a of adapters.splice(0)) a.cacheKeepalive?.stop();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const message = {
  id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-4-1',
  content: [], stop_reason: 'end_turn', stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 1000 },
};
const events = (reason: string) => [
  { type: 'message_start', message: { ...message, stop_reason: null } },
  { type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 0 } },
  { type: 'message_stop' },
].map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

function interceptBodies(streamReason = () => 'end_turn') {
  const bodies: string[] = [];
  vi.stubGlobal('fetch', async (_input: unknown, init: RequestInit) => {
    const body = String(init.body);
    bodies.push(body); // Actual SDK-serialized bytes, not fake messages arguments.
    return JSON.parse(body).stream
      ? new Response(events(streamReason()), { headers: { 'content-type': 'text/event-stream' } })
      : new Response(JSON.stringify(message), { headers: { 'content-type': 'application/json' } });
  });
  return bodies;
}

function sdkRequest(): ProviderRequest {
  return {
    model: message.model, maxTokens: 32,
    system: [{ type: 'text', text: 'system', cache_control: { type: 'ephemeral', ttl: '1h' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  };
}

function setup(config: CacheKeepaliveConfig = {}) {
  const bodies = interceptBodies();
  const a = new AnthropicAdapter({ apiKey: 'sk-test', cacheKeepalive: {
    suppressOnRefusal: true, lanes: ['complete', 'stream'], refreshAfterMs: 0, ...config,
  } });
  adapters.push(a);
  const request = sdkRequest();
  const run = (lane: 'complete' | 'stream') => lane === 'complete'
    ? a.complete(request) : a.stream(request, { onChunk() {} });
  return { a, request, bodies, run };
}

const observerReplacement = {
  model: 'observer-model',
  system: [{ type: 'text', text: 'observer replacement', cache_control: { type: 'ephemeral', ttl: '1h' } }],
  messages: [{ role: 'user', content: 'redacted' }],
};
const replaceObservedFields = { onRequest(wire: unknown) { Object.assign(wire as object, observerReplacement); } };
const callbacks = { onChunk() {} };

it('suppression-enabled stream bookkeeping follows the SDK body', async () => {
  vi.useFakeTimers();
  let reason = 'end_turn';
  const bodies = interceptBodies(() => reason);
  const suppressed: KeepaliveSuppression[] = [];
  const a = new AnthropicAdapter({ apiKey: 'sk-test', cacheKeepalive: {
    suppressOnRefusal: true, refreshAfterMs: 100, checkIntervalMs: 100,
    onSuppressed: notice => { suppressed.push(notice); },
  } });
  adapters.push(a);
  const request = sdkRequest();
  await a.stream(request, callbacks, replaceObservedFields);
  expect(bodies).toHaveLength(1);
  expect(JSON.parse(bodies[0])).toMatchObject({
    model: request.model, system: request.system, messages: request.messages, stream: true,
  });
  const key = lineageKey(JSON.parse(bodies[0]));
  expect(a.cacheKeepalive!.getStatus().map(s => s.key)).toEqual([key]);

  // With no hour marker in the actual body, an observer-only marker cannot
  // make a different stream eligible or create its own key.
  await a.stream({ ...request, system: 'unmarked' }, callbacks, replaceObservedFields);
  expect(JSON.parse(bodies[1]).system).toBe('unmarked');
  expect(a.cacheKeepalive!.getStatus().map(s => s.key)).toEqual([key]);
  await vi.advanceTimersByTimeAsync(100);
  expect(bodies).toHaveLength(3);
  expect(bodies[2]).toBe(bodies[0].replace('"max_tokens":32', '"max_tokens":0').replace(',"stream":true', ''));

  reason = 'refusal';
  await a.stream(request, callbacks); // Refusal for the identity actually sent.
  expect(bodies[3]).toBe(bodies[0]);
  expect(suppressed).toEqual([{ type: 'suppressed', key, source: 'foreground' }]);
  expect(a.cacheKeepalive!.getStatus()).toEqual([]);
  await vi.advanceTimersByTimeAsync(300);
  expect(bodies).toHaveLength(4);
});

// Raw body strings captured against this PR's base, upstream/main 9d4dc61,
// with the real SDK. Legacy replays use the observer-modified body in both lanes.
const mainForeground = {
  complete: '{"model":"observer-model","max_tokens":32,"messages":[{"role":"user","content":"redacted"}],"system":[{"type":"text","text":"observer replacement","cache_control":{"type":"ephemeral","ttl":"1h"}}],"stream":false}',
  stream: '{"model":"claude-opus-4-1","max_tokens":32,"messages":[{"role":"user","content":[{"type":"text","text":"hello"}]}],"system":[{"type":"text","text":"system","cache_control":{"type":"ephemeral","ttl":"1h"}}],"stream":true}',
};
const mainReplay = '{"model":"observer-model","max_tokens":0,"messages":[{"role":"user","content":"redacted"}],"system":[{"type":"text","text":"observer replacement","cache_control":{"type":"ephemeral","ttl":"1h"}}]}';

it.each<CacheKeepaliveConfig>([
  {},
  { suppressOnRefusal: false },
  { enabled: true },
  { enabled: true, suppressOnRefusal: false },
])('suppression-off foreground and replay match main in both lanes (%j)', async config => {
  vi.useFakeTimers();
  const bodies = interceptBodies(() => 'refusal');
  for (const lane of ['complete', 'stream'] as const) {
    const a = new AnthropicAdapter({ apiKey: 'sk-test', cacheKeepalive: {
      ...config, lanes: [lane], refreshAfterMs: 100, checkIntervalMs: 100,
    } });
    adapters.push(a);
    if (lane === 'complete') await a.complete(sdkRequest(), replaceObservedFields);
    else {
      const result = await a.stream(sdkRequest(), callbacks, replaceObservedFields);
      expect(result.stopReason).toBe('refusal'); // Legacy still schedules a refused prefix.
    }
    await vi.advanceTimersByTimeAsync(100);
    expect(bodies.splice(0)).toEqual([mainForeground[lane], mainReplay]);
    expect(a.cacheKeepalive!.getStatus().map(s => s.key)).toEqual([lineageKey(observerReplacement)]);
    a.cacheKeepalive!.stop();
  }
});

it('suppression does not change either foreground transport', async () => {
  vi.useFakeTimers();
  const bodies = interceptBodies(() => 'refusal');
  const optIn = new AnthropicAdapter({ apiKey: 'sk-test', cacheKeepalive: { suppressOnRefusal: true } });
  adapters.push(optIn);
  await optIn.complete(sdkRequest(), replaceObservedFields);
  await optIn.stream(sdkRequest(), callbacks, replaceObservedFields);
  expect(bodies).toEqual([mainForeground.complete, mainForeground.stream]);
});

it.each(['complete', 'stream'] as const)('%s preserves exact digits in SDK body, key, and replay', async lane => {
  const { a, request, bodies, run } = setup();
  const raw = (JSON as unknown as { rawJSON(value: string): unknown }).rawJSON;
  for (const digits of ['9007199254740992', '9007199254740993']) {
    request.extra = {
      tools: [{ name: 'lookup', input_schema: { type: 'object', properties: { id: { const: raw(digits) } } } }],
      messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'tool', name: 'lookup', input: { id: raw(digits) } }] }],
    };
    await run(lane);
    expect(bodies.at(-1)).toContain(`"id":${digits}`);
    expect(bodies.at(-1)).toContain(`"const":${digits}`);
    expect(a.cacheKeepalive!.getStatus().map(s => s.key)).toContain(lineageKey({
      model: request.model, system: request.system, tools: request.extra.tools,
    }));
  }
  expect(a.cacheKeepalive!.getStatus()).toHaveLength(2); // Adjacent IDs must not collapse.
  await (a.cacheKeepalive as any).tick();
  expect(bodies).toHaveLength(4);
  for (let i = 0; i < 2; i++) {
    // Compare the complete serialized body without parsing away rawJSON digits.
    const expected = bodies[i].replace(/"max_tokens":32/, '"max_tokens":0')
      .replace(/,"stream":(?:true|false)/, '');
    expect(bodies[i + 2]).toBe(expected);
  }
  expect(a.cacheKeepalive!.getStatus()).toHaveLength(2);
});

it('stream leaves stream:true serialization to the SDK, without rewriting the prompt', async () => {
  const { request, bodies, run } = setup();
  request.extra = {
    toJSON(this: any) {
      const { toJSON, ...body } = this;
      return { ...body, system: this.stream ? 'B' : 'A' };
    },
  };
  await run('stream');
  expect(JSON.parse(bodies[0])).toMatchObject({ stream: true, system: 'B' });
  // Custom root serialization is outside the keepalive identity contract, but
  // enabling suppression must not change what the ordinary SDK transport sends.
});

it.each(['complete', 'stream'] as const)('%s real SDK rejects a pre-aborted request without qualifying it', async lane => {
  const { a, request, bodies } = setup();
  const controller = new AbortController();
  controller.abort();
  const result = lane === 'complete' ? a.complete(request, { signal: controller.signal })
    : a.stream(request, { onChunk() {} }, { signal: controller.signal });
  await expect(result).rejects.toThrow(/abort/i);
  expect(bodies).toEqual([]);
  expect(a.cacheKeepalive!.getStatus()).toEqual([]);
});

it('Membrane.complete succeeds, then replay preparation rejects an onRequest root serializer that changes during spread', async () => {
  vi.useFakeTimers();
  const observed: KeepaliveDiagnostic[] = [];
  const events: KeepaliveEvent[] = [];
  const { a, bodies } = setup({ checkIntervalMs: 100, onDiagnostic: event => { observed.push(event); }, onEvent: event => { events.push(event); } });
  const membrane = new Membrane(a, { formatter: new NativeFormatter() });
  let reads = 0;
  const serialize = vi.fn(() => ({ model: message.model, max_tokens: 1024, messages: [] }));
  await membrane.complete({
    messages: [{ participant: 'User', content: [{ type: 'text', text: 'hello' }] }],
    system: 'public root serializer regression',
    config: { model: message.model, maxTokens: 32 },
    promptCaching: true, cacheTtl: '1h', toolMode: 'native',
  }, {
    refusalRetries: 0,
    onRequest(wire) {
      // Installed before admission, without touching private keepalive state.
      // Each stringify reads toJSON twice (root hook and enumerable field).
      // Foreground (1–2), refresh stringify (3–4), and root check (5) see
      // no serializer; the replay spread (6) receives a callable serializer.
      Object.defineProperty(wire, 'toJSON', {
        enumerable: true, get: () => ++reads < 6 ? undefined : serialize,
      });
    },
  });
  expect(reads).toBe(2); // Foreground path, including real SDK serialization.
  expect(bodies).toHaveLength(1);
  expect(JSON.parse(bodies[0])).toMatchObject({ max_tokens: 32 });
  expect(a.cacheKeepalive!.getStatus()).toHaveLength(1);

  await vi.advanceTimersByTimeAsync(100); // Public scheduler, not a private tick.
  expect(reads).toBe(6);
  expect(serialize).not.toHaveBeenCalled();
  expect(bodies).toHaveLength(1); // No refresh transport invocation.
  expect(a.cacheKeepalive!.getStatus()).toEqual([]);
  expect(events).toEqual([]);
  expect(observed).toContainEqual(expect.objectContaining({
    type: 'diagnostic',
    reason: 'replay-preparation-failed: replay snapshot retired; remove callable root toJSON',
  }));
});
