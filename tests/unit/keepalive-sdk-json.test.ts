import { afterEach, expect, it, vi } from 'vitest';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { lineageKey } from '../../src/cache-keepalive.js';

const adapters: AnthropicAdapter[] = [];
afterEach(() => {
  for (const a of adapters.splice(0)) a.cacheKeepalive?.stop();
  vi.unstubAllGlobals();
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

function setup() {
  const bodies: string[] = [];
  vi.stubGlobal('fetch', async (_input: unknown, init: RequestInit) => {
    const body = String(init.body);
    bodies.push(body); // Actual SDK-serialized bytes, not fake messages arguments.
    return JSON.parse(body).stream
      ? new Response(events, { headers: { 'content-type': 'text/event-stream' } })
      : new Response(JSON.stringify(message), { headers: { 'content-type': 'application/json' } });
  });
  const a = new AnthropicAdapter({ apiKey: 'sk-test', cacheKeepalive: {
    suppressOnRefusal: true, lanes: ['complete', 'stream'], refreshAfterMs: 0,
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
