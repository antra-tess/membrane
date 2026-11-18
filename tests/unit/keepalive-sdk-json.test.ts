import { afterEach, expect, it, vi } from 'vitest';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { Membrane } from '../../src/membrane.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { lineageKey, type CacheKeepaliveConfig, type KeepaliveDiagnostic, type KeepaliveEvent } from '../../src/cache-keepalive.js';

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
const events = [
  { type: 'message_start', message: { ...message, stop_reason: null } },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } },
  { type: 'message_stop' },
].map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

function setup(config: CacheKeepaliveConfig = {}) {
  const bodies: string[] = [];
  vi.stubGlobal('fetch', async (_input: unknown, init: RequestInit) => {
    const body = String(init.body);
    bodies.push(body); // Actual SDK-serialized bytes, not fake messages arguments.
    return JSON.parse(body).stream
      ? new Response(events, { headers: { 'content-type': 'text/event-stream' } })
      : new Response(JSON.stringify(message), { headers: { 'content-type': 'application/json' } });
  });
  const a = new AnthropicAdapter({ apiKey: 'sk-test', cacheKeepalive: {
    suppressOnRefusal: true, lanes: ['complete', 'stream'], refreshAfterMs: 0, ...config,
  } });
  adapters.push(a);
  const request: any = {
    model: message.model, maxTokens: 32,
    system: [{ type: 'text', text: 'system', cache_control: { type: 'ephemeral', ttl: '1h' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  };
  const run = (lane: 'complete' | 'stream') => lane === 'complete'
    ? a.complete(request) : a.stream(request, { onChunk() {} });
  return { a, request, bodies, run };
}

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
    reason: 'replay-preparation-failed: replay snapshot retired',
  }));
});
