import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { CacheKeepalive, type KeepaliveCall, type KeepaliveEvent } from '../../src/cache-keepalive.js';

const keepers: CacheKeepalive[] = [];
afterEach(() => { for (const k of keepers.splice(0)) k.stop(); });
function setup(send: any, onCall?: (call: KeepaliveCall) => void) {
  const events: KeepaliveEvent[] = [];
  const calls: KeepaliveCall[] = [];
  const k = new CacheKeepalive(send, {
    suppressOnRefusal: true, refreshAfterMs: 0, maxConsecutiveErrors: 2,
    onCall: onCall ?? (c => { calls.push(c); }), onEvent: e => { events.push(e); },
  });
  keepers.push(k);
  const wire: Record<string, unknown> = {
    model: 'claude-test', max_tokens: 1024, stream: true,
    system: [{ type: 'text', text: 'system', cache_control: { type: 'ephemeral', ttl: '1h' } }],
    messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'answer' }],
  };
  const qualify = () => k.finish(k.begin(wire, undefined, 'stream')!, 'end_turn');
  const tick = () => (k as any).tick();
  return { k, wire, qualify, tick, events, calls };
}
const response = { stop_reason: 'max_tokens', usage: { cache_read_input_tokens: 10 } };

it('documents request receipts as caller objects, not wire bytes, and pins rawJSON brand loss', async () => {
  const { wire, qualify, tick, calls, events } = setup(async (payload: unknown) => {
    expect(JSON.stringify(payload)).toContain('"id":9007199254740993');
    return response;
  });
  wire.metadata = { id: (JSON as any).rawJSON('9007199254740993') };
  qualify(); await tick();
  // Node versions either strip the rawJSON brand or reject its clone entirely.
  let cloneable = true;
  try { structuredClone(wire.metadata); } catch { cloneable = false; }
  if (cloneable) {
    expect(JSON.stringify(calls[0]!.request)).toContain('"id":{"rawJSON":"9007199254740993"}');
  } else {
    expect(calls).toEqual([]);
    expect(events[0]).toMatchObject({ type: 'skipped', reason: 'receipt-clone-failed' });
  }
  const guide = readFileSync(new URL('../../docs/keepalive-refusal-suppression.md', import.meta.url), 'utf8');
  const api = readFileSync(new URL('../../src/cache-keepalive.ts', import.meta.url), 'utf8');
  for (const text of [guide, api]) {
    expect(text).toContain('caller request object, not wire bytes');
    expect(text).toContain('JSON.rawJSON');
  }
});

it.each(['request', 'response'] as const)('reports %s clone loss without changing refresh accounting', async side => {
  const { wire, qualify, tick, events, calls, k } = setup(async (payload: any) => {
    // A callable metadata serializer is valid for the SDK but not structuredClone.
    expect(JSON.parse(JSON.stringify(payload)).metadata).toEqual({ id: 'sent' });
    return side === 'response' ? { ...response, custom: () => {} } : response;
  });
  wire.metadata = side === 'request' ? { toJSON() { return { id: 'sent' }; } } : { id: 'sent' };
  qualify(); await tick();
  expect(calls).toEqual([]);
  expect(events.map(e => e.type)).toEqual(['skipped', 'refreshed']);
  expect(events[0]).toEqual({ type: 'skipped', key: k.getStatus()[0]!.key, reason: 'receipt-clone-failed' });
  expect(k.getStatus()).toHaveLength(1);
});

it('does not misreport a throwing receipt observer as a clone failure', async () => {
  const { qualify, tick, events } = setup(async () => response, () => { throw new Error('observer'); });
  qualify(); await tick();
  expect(events.map(e => e.type)).toEqual(['refreshed']);
});

it('rejects root serialization that could undo the prefill budget and trimming', async () => {
  const send = vi.fn(async () => response);
  const { wire, qualify, tick, events, k } = setup(send);
  wire.toJSON = function(this: any) { return { ...this, toJSON: undefined, max_tokens: 1024 }; };
  qualify(); expect(k.getStatus()).toHaveLength(1);
  await tick();
  expect(send).not.toHaveBeenCalled();
  expect(k.getStatus()).toEqual([]);
  expect(events).toEqual([expect.objectContaining({ type: 'error', consecutive: 0 })]);
});

it('counts opt-in unprintable Error.message failures through disabling', async () => {
  const error = new Error('original');
  Object.defineProperty(error, 'message', { value: Object.create(null) });
  const { qualify, tick, events, k } = setup(async () => { throw error; });
  qualify(); await tick(); await tick();
  expect(events).toEqual([
    expect.objectContaining({ type: 'error', error: 'Unprintable keepalive error', consecutive: 1 }),
    expect.objectContaining({ type: 'error', error: 'Unprintable keepalive error', consecutive: 2 }),
    { type: 'disabled', reason: '2 consecutive keepalive failures; last: Unprintable keepalive error' },
  ]);
  expect(k.getStatus()).toEqual([]);
});


it.each([{}, { suppressOnRefusal: false }])('keeps legacy serialization and silent clone loss: %j', async config => {
  const calls: KeepaliveCall[] = [], events: KeepaliveEvent[] = [];
  const send = vi.fn(async () => ({ ...response, uncloneable: () => {} }));
  const k = new CacheKeepalive(send, { ...config, refreshAfterMs: 0,
    onCall: c => { calls.push(c); }, onEvent: e => { events.push(e); } });
  keepers.push(k);
  const wire = { model: 'claude-test', system: [{ type: 'text', text: 'system',
    cache_control: { type: 'ephemeral', ttl: '1h' } }], messages: [{ role: 'user', content: 'hi' }],
    metadata: { toJSON() { return { sent: true }; } },
    toJSON(this: any) { return { ...this, toJSON: undefined, max_tokens: 1024, stream: true }; },
  };
  k.record(wire, undefined, 'stream'); await (k as any).tick();
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]![0]).toMatchObject({ max_tokens: 0, metadata: { sent: true } });
  expect(send.mock.calls[0]![0]).not.toHaveProperty('stream');
  expect(calls).toEqual([]);
  expect(events.map(e => e.type)).toEqual(['refreshed']);
});
