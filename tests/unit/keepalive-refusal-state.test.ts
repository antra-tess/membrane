import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CacheKeepalive, type KeepaliveCall, type KeepaliveEvent } from '../../src/cache-keepalive.js';
const wire = (model = 'claude-test') => ({ model, system: [{ type: 'text', text: 'system', cache_control: { type: 'ephemeral', ttl: '1h' } }], messages: [{ role: 'user', content: 'hi' }] });
const ok = { stop_reason: 'max_tokens', usage: { cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } };
const keepers: CacheKeepalive[] = [];
function setup(send: any = async () => ok, extra: any = {}) {
  const calls: KeepaliveCall[] = [], events: KeepaliveEvent[] = [];
  const k = new CacheKeepalive(send, { suppressOnRefusal: true, refreshAfterMs: 100, checkIntervalMs: 100, maxIdleMs: 1000, onCall: c => { calls.push(c); }, onEvent: e => { events.push(e); }, ...extra });
  keepers.push(k);
  const begin = (purpose: 'normal' | 'maintenance' = 'normal', w = wire()) => k.begin(w, undefined, 'stream', purpose)!;
  const normal = () => { const a = begin(); k.prefix(a); k.finish(a, 'end_turn'); return a; };
  return { k, calls, events, begin, normal };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1000); });
afterEach(() => { keepers.splice(0).forEach(k => k.stop()); vi.useRealTimers(); });

it('refresh refusal suppresses despite positive usage; receipt is transport success only', async () => {
  const { k, calls, events, normal } = setup(async () => ({ ...ok, stop_reason: 'refusal' }));
  normal();
  await vi.advanceTimersByTimeAsync(100);
  expect(k.getStatus()).toEqual([]);
  expect(calls).toHaveLength(1);
  expect(calls[0].outcome).toBe('success');
  expect(events.map(e => e.type)).toEqual(['suppressed']);
  await vi.advanceTimersByTimeAsync(300);
  expect(calls).toHaveLength(1);
});

it.each([null, undefined, 'future_stop'])('unknown refresh %s never claims refreshed', async reason => {
  const { normal, events, calls } = setup(async () => ({ ...ok, stop_reason: reason }));
  normal(); await vi.advanceTimersByTimeAsync(100);
  expect(calls).toHaveLength(1);
  expect(events).toEqual([]);
});

it('error, unknown, cancellation (no finish), and maintenance cannot rearm a barrier', () => {
  const { k, begin, normal } = setup();
  normal(); k.finish(begin(), 'refusal');
  for (const reason of [undefined, null, 'future_stop']) { const a = begin(); k.prefix(a); k.finish(a, reason); }
  k.prefix(begin()); // cancelled/error: no successful terminal
  const maintenance = begin('maintenance'); k.prefix(maintenance); k.finish(maintenance, 'max_tokens');
  expect(k.getStatus()).toEqual([]);
  normal(); expect(k.getStatus()).toHaveLength(1);
});

it.each(['success', 'refusal', 'error'])('stale refresh %s after replacement has receipt but no state effects', async outcome => {
  let resolve!: (r: any) => void, reject!: (r: any) => void;
  const deferred = new Promise((a, b) => { resolve = a; reject = b; });
  const { k, normal, calls, events } = setup(() => deferred);
  normal(); await vi.advanceTimersByTimeAsync(100);
  const replacement = normal();
  if (outcome === 'error') reject(new Error('old')); else resolve({ ...ok, stop_reason: outcome === 'refusal' ? 'refusal' : 'max_tokens' });
  await vi.advanceTimersByTimeAsync(0);
  expect(calls).toHaveLength(1); expect(events).toEqual([]);
  expect(k.getStatus()).toHaveLength(1);
  k.finish(replacement, 'refusal'); expect(k.getStatus()).toEqual([]);
});

it.each(['stop', 'evict', 'drop'])('old foreground and refresh cannot resurrect after %s', async action => {
  let resolve!: (r: any) => void;
  const { k, normal, begin, calls, events } = setup(() => new Promise(r => { resolve = r; }), { maxLineages: 1, maxIneffective: 1 });
  const old = normal(); await vi.advanceTimersByTimeAsync(100);
  if (action === 'stop') k.stop();
  if (action === 'evict') begin('normal', wire('other'));
  resolve(action === 'drop' ? { stop_reason: 'max_tokens', usage: {} } : ok);
  await vi.advanceTimersByTimeAsync(0);
  k.prefix(old); k.finish(old, 'end_turn');
  expect(k.getStatus()).toEqual([]); expect(calls).toHaveLength(1);
  expect(events.some(e => e.type === 'refreshed')).toBe(false);
});

it('onCall reentrancy cannot refresh a stopped keeper', async () => {
  let k!: CacheKeepalive;
  const state = setup(undefined, { onCall: () => k.stop() }); k = state.k;
  state.normal(); await vi.advanceTimersByTimeAsync(100);
  expect(state.events).toEqual([]); expect(k.getStatus()).toEqual([]);
});

it('older success cannot replace a newer snapshot even without refusal', () => {
  const { k, begin } = setup();
  const old = begin();
  const newer = begin();
  k.prefix(newer); k.finish(newer, 'end_turn');
  vi.advanceTimersByTime(10);
  k.prefix(old); k.finish(old, 'end_turn');
  expect(k.getStatus()[0].realIdleMs).toBe(10);
  // Exact wire identity is more meaningful than the shared timestamp.
  expect((k as any).lineages.get(old.key).wire).toBe(newer.wire);
});

it('retained suppression is bounded and survives an ineligible prefix', () => {
  const { k, begin } = setup(undefined, { maxLineages: 1 });
  const a = begin(); k.finish(a, 'refusal');
  const ineligible = k.begin({ ...wire(), thinking: { type: 'enabled' } }, undefined, 'stream')!;
  k.prefix(ineligible); k.finish(ineligible, undefined);
  k.finish(a, 'end_turn'); expect(k.getStatus()).toEqual([]);
  const other = begin('normal', wire('other')); k.prefix(other);
  expect(k.getStatus()).toEqual([]);
  k.finish(other, 'end_turn');
  k.finish(a, 'end_turn'); expect(k.getStatus()[0].key).toBe(other.key);
  expect((k as any).outcomes.size).toBe(1);
});

it('legacy record alone cannot bypass suppression or outcome identity', () => {
  const { k, begin } = setup();
  k.record(wire(), undefined, 'stream');
  expect(k.getStatus()).toEqual([]);
  const a = begin(); k.finish(a, 'refusal');
  k.record({ ...wire(), thinking: { type: 'enabled' } }, undefined, 'stream');
  k.record(wire(), undefined, 'stream');
  expect(k.getStatus()).toEqual([]);
  k.finish(a, 'end_turn'); expect(k.getStatus()).toEqual([]);
});


it('fresh identities require known-normal completion, and newer prefix orders initial qualification', () => {
  const { k, begin } = setup();
  const maintenance = begin('maintenance'); k.prefix(maintenance); k.finish(maintenance, 'max_tokens');
  const unknown = begin(); k.prefix(unknown); k.finish(unknown, undefined);
  k.record(wire(), undefined, 'stream');
  expect(k.getStatus()).toEqual([]);
  k.prefix(begin()); // Failed/cancelled attempt with no successful finish.
  expect(k.getStatus()).toEqual([]);
  const old = begin(); const newer = begin(); k.prefix(newer);
  k.finish(old, 'end_turn'); expect(k.getStatus()).toEqual([]);
  k.finish(newer, 'end_turn'); expect(k.getStatus()).toHaveLength(1);
});
