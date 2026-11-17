import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CacheKeepalive, lineageKey, type KeepaliveCall, type KeepaliveEvent } from '../../src/cache-keepalive.js';
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
  expect(events).toEqual([{ type: 'skipped', key: lineageKey(wire()), reason: 'unknown-refresh-terminal' }]);
  await vi.advanceTimersByTimeAsync(500);
  expect(calls).toHaveLength(1);
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

it.each(['success', 'refusal', 'error'])('stale refresh %s preserves replacement; errors still count globally', async outcome => {
  let resolve!: (r: any) => void, reject!: (r: any) => void;
  const deferred = new Promise((a, b) => { resolve = a; reject = b; });
  const { k, normal, calls, events } = setup(() => deferred);
  normal(); await vi.advanceTimersByTimeAsync(100);
  const replacement = normal();
  if (outcome === 'error') reject(new Error('old')); else resolve({ ...ok, stop_reason: outcome === 'refusal' ? 'refusal' : 'max_tokens' });
  await vi.advanceTimersByTimeAsync(0);
  expect(calls).toHaveLength(1);
  expect(events.map(e => e.type)).toEqual(outcome === 'error' ? ['error'] : []);
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
  const send = vi.fn(async () => ok);
  const onCall = vi.fn(() => k.stop());
  const state = setup(send, { onCall }); k = state.k;
  state.normal(); await vi.advanceTimersByTimeAsync(100);
  expect(send).toHaveBeenCalledTimes(1); expect(onCall).toHaveBeenCalledTimes(1);
  expect(state.events).toEqual([]); expect(k.getStatus()).toEqual([]);
});

it('older success cannot replace a newer snapshot even without refusal', () => {
  const { k, begin } = setup();
  const old = begin();
  const newerWire = wire();
  const newer = begin('normal', newerWire);
  k.prefix(newer); k.finish(newer, 'end_turn');
  vi.advanceTimersByTime(10);
  k.prefix(old); k.finish(old, 'end_turn');
  expect(k.getStatus()[0].realIdleMs).toBe(10);
  // Exact wire identity is more meaningful than the shared timestamp.
  expect((k as any).lineages.get(old.key).wire).toBe(newerWire);
});

it('retained suppression is bounded and blocks an ineligible prefix', () => {
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


it('fresh identities require known-normal completion, not pending-prefix order', () => {
  const { k, begin } = setup();
  const maintenance = begin('maintenance'); k.prefix(maintenance); k.finish(maintenance, 'max_tokens');
  const unknown = begin(); k.prefix(unknown); k.finish(unknown, undefined);
  k.record(wire(), undefined, 'stream');
  expect(k.getStatus()).toEqual([]);
  k.prefix(begin()); // Failed/cancelled attempt with no successful finish.
  expect(k.getStatus()).toEqual([]);
  const old = begin(); const newer = begin(); k.prefix(newer);
  k.finish(old, 'end_turn'); expect(k.getStatus()).toHaveLength(1);
  k.finish(newer, 'end_turn'); expect(k.getStatus()).toHaveLength(1);
});

it.each(['refusal', null, 'future_stop'])('resolved %s refresh breaks consecutive transport failures', async reason => {
  const send = vi.fn()
    .mockRejectedValueOnce(new Error('first'))
    .mockResolvedValueOnce({ ...ok, stop_reason: reason })
    .mockRejectedValueOnce(new Error('second'));
  const { k, events } = setup(send, { maxConsecutiveErrors: 2 });
  for (const model of ['a', 'b', 'c']) {
    const a = k.begin(wire(model), undefined, 'stream')!;
    k.finish(a, 'end_turn');
  }
  await vi.advanceTimersByTimeAsync(100);
  expect(send).toHaveBeenCalledTimes(3);
  expect(events.filter(e => e.type === 'error').map(e => e.consecutive)).toEqual([1, 1]);
  expect(events.some(e => e.type === 'disabled')).toBe(false);
});

it.each(['forced-tool-choice', 'legacy-thinking-budget'])('ineligible prefix emits skipped for %s even without a terminal', reason => {
  const { k, normal, events } = setup();
  normal();
  const w = { ...wire(), ...(reason === 'forced-tool-choice' ? { tool_choice: { type: 'any' } } : { thinking: { type: 'enabled' } }) };
  const a = k.begin(w, undefined, 'stream')!;
  k.prefix(a); k.finish(a, undefined);
  expect(k.getStatus()).toEqual([]);
  expect(events).toEqual([{ type: 'skipped', key: a.key, reason }]);
});

it.each([{ tool_choice: { type: 'any' } }, { system: [{ type: 'text', text: 'system' }] }])('excluded lane cannot drop a snapshot for ineligibility: %j', changes => {
  const { k, normal, events } = setup();
  // Mark messages instead so removing the marker does not change the shared key.
  const eligible = { ...wire(), messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral', ttl: '1h' } }] }] };
  if ('system' in changes) eligible.system = changes.system as any;
  const a = k.begin(eligible, undefined, 'stream')!; k.finish(a, 'end_turn');
  const ineligible = { ...eligible, ...changes, messages: [{ role: 'user', content: 'hi' }] };
  const excluded = k.begin(ineligible, undefined, 'complete')!;
  expect(excluded.key).toBe(a.key);
  k.prefix(excluded); k.finish(excluded, 'end_turn');
  expect(k.getStatus()).toHaveLength(1);
  expect(events).toEqual([]);
  k.finish(excluded, 'refusal');
  expect(k.getStatus()).toEqual([]); // Excluded lanes still observe refusals.
});

it('ineligible completion preserves identity for an older in-flight refusal and its barrier', () => {
  const { k, normal, begin, events } = setup(); normal();
  const refusing = begin();
  const identity = (k as any).outcomes.get(refusing.key);
  const ineligible = begin('normal', { ...wire(), thinking: { type: 'enabled' } } as any);
  k.prefix(ineligible);
  expect((k as any).outcomes.get(refusing.key)).toBe(identity); k.finish(ineligible, 'end_turn');
  const beforeRefusal = begin();
  k.finish(refusing, 'refusal');
  k.prefix(beforeRefusal); k.finish(beforeRefusal, 'end_turn');
  expect(events.some(e => e.type === 'suppressed')).toBe(true);
  expect(k.getStatus()).toEqual([]);
  normal(); expect(k.getStatus()).toHaveLength(1);
});

it('unrelated excluded/ineligible traffic consumes the bounded outcome LRU visibly', () => {
  const { k, normal, events } = setup(); const main = normal();
  for (let i = 0; i < 4; i++) {
    const a = k.begin({ model: `other-${i}`, messages: [] }, undefined, 'complete')!;
    k.prefix(a); k.finish(a, undefined);
  }
  expect(k.getStatus()).toEqual([]);
  expect((k as any).outcomes.size).toBe(4);
  expect(events).toEqual([{ type: 'skipped', key: main.key, reason: 'outcome-lru-eviction' }]);
  k.finish(main, 'end_turn'); expect(k.getStatus()).toEqual([]);
});

it.each([NaN, Infinity, -Infinity])('nonfinite maxLineages %s uses the bounded default', cap => {
  const { k } = setup(undefined, { maxLineages: cap });
  for (let i = 0; i < 8; i++) {
    const a = k.begin(wire(String(i)), undefined, 'stream')!; k.finish(a, 'end_turn');
  }
  expect((k as any).outcomes.size).toBe(4);
  expect(k.getStatus()).toHaveLength(4);
});

// Differential oracle: main 9d4dc61a src/cache-keepalive.ts record()'s
// insertion/eviction loop, deliberately without cap normalization.
function mainRetainedModels(maxLineages: number): string[] {
  const lineages = new Map<string, string>();
  for (let i = 0; i < 8; i++) {
    const model = String(i);
    const key = lineageKey(wire(model));
    lineages.delete(key);
    lineages.set(key, model);
    while (lineages.size > maxLineages) {
      const oldest = lineages.keys().next().value;
      if (oldest === undefined) break;
      lineages.delete(oldest);
    }
  }
  return [...lineages.values()];
}

for (const suppression of [{}, { suppressOnRefusal: false }]) {
  it.each([Infinity, NaN, -Infinity, 0, -1, -0.5, 0.5, 4])(
    `default-off cap %s matches main retention and sends (suppression ${JSON.stringify(suppression)})`,
    async cap => {
      const send = vi.fn(async (_wire: Record<string, unknown>) => ok);
      const k = new CacheKeepalive(send, {
        ...suppression, maxLineages: cap,
        refreshAfterMs: 100, checkIntervalMs: 100, maxIdleMs: 1000,
      });
      keepers.push(k);
      for (let i = 0; i < 8; i++) k.record(wire(String(i)), undefined, 'stream');
      const expected = mainRetainedModels(cap);
      expect(k.getStatus().map(s => s.key)).toEqual(expected.map(model => lineageKey(wire(model))));
      await vi.advanceTimersByTimeAsync(100);
      expect(send.mock.calls.map(call => call[0].model)).toEqual(expected);
      expect(k.getStatus()).toHaveLength(expected.length);
    },
  );
}

it('attempt handles do not expose mutable state and are issuer-specific', () => {
  const { k, begin } = setup(); const { k: other } = setup();
  const a = begin();
  expect(Object.keys(a)).toEqual(['key']);
  expect(Object.isFrozen(a)).toBe(true);
  other.prefix(a); other.finish(a, 'end_turn');
  expect(other.getStatus()).toEqual([]);
  k.finish(a, 'end_turn'); expect(k.getStatus()).toHaveLength(1);
});

it.each([true, false])('async event rejection is isolated with suppression %s', async suppressOnRefusal => {
  const onEvent = vi.fn(async () => { throw new Error('observer'); });
  const { k, begin } = setup(undefined, { onEvent, suppressOnRefusal });
  if (suppressOnRefusal) k.finish(begin(), 'refusal');
  else {
    k.record({ ...wire(), thinking: { type: 'enabled' } }, undefined, 'stream');
    k.record(wire(), undefined, 'stream');
    k.record({ ...wire(), thinking: { type: 'enabled' } }, undefined, 'stream');
  }
  expect(onEvent).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(0); // Vitest also fails on unhandled rejections.
  expect(k.getStatus()).toEqual([]);
});

it('uncloneable custom response drops its receipt without losing refresh processing', async () => {
  const { normal, calls, events } = setup(async () => ({ ...ok, custom: () => {} }));
  normal(); await vi.advanceTimersByTimeAsync(100);
  expect(calls).toEqual([]);
  expect(events.map(e => e.type)).toEqual(['refreshed']);
});


it('excluded-lane completion cannot starve a fresh stream snapshot', () => {
  const { k, begin } = setup();
  const stream = begin(); k.prefix(stream);
  const complete = k.begin(wire(), undefined, 'complete')!;
  k.prefix(complete); k.finish(complete, 'end_turn');
  expect(k.getStatus()).toEqual([]);
  k.finish(stream, 'end_turn');
  expect(k.getStatus().map(s => s.lane)).toEqual(['stream']);
});

it.each(['refusal', 'success'])('finish preserves prefix snapshot during %s refresh', async result => {
  let resolve!: (r: any) => void;
  const { k, normal, begin, events } = setup(() => new Promise(r => { resolve = r; }));
  normal();
  const stream = begin(); k.prefix(stream);
  const snapshot = (k as any).lineages.get(stream.key);
  await vi.advanceTimersByTimeAsync(100);
  k.finish(stream, 'end_turn');
  expect((k as any).lineages.get(stream.key)).toBe(snapshot);
  resolve(result === 'refusal' ? { ...ok, stop_reason: 'refusal' } : ok);
  await vi.advanceTimersByTimeAsync(0);
  expect(events.map(e => e.type)).toEqual([result === 'refusal' ? 'suppressed' : 'refreshed']);
});

it('finish after a resolved refresh preserves the refreshed baseline', async () => {
  const { k, normal, begin } = setup(); normal();
  const stream = begin(); k.prefix(stream);
  await vi.advanceTimersByTimeAsync(100);
  expect(k.getStatus()[0].idleMs).toBe(0);
  k.finish(stream, 'end_turn');
  expect(k.getStatus()[0].idleMs).toBe(0);
});

it('reentrant eviction refusal bars the outer begin', () => {
  let k!: CacheKeepalive, nested = false;
  const state = setup(undefined, { maxLineages: 1, onEvent: (e: KeepaliveEvent) => {
    if (e.type === 'skipped' && !nested) {
      nested = true;
      const a = k.begin(wire('B'), undefined, 'stream')!;
      k.finish(a, 'refusal');
    }
  } }); k = state.k;
  state.normal();
  const outer = k.begin(wire('B'), undefined, 'stream')!;
  k.prefix(outer); k.finish(outer, 'end_turn');
  expect(nested).toBe(true);
  expect(k.getStatus()).toEqual([]);
  const after = k.begin(wire('B'), undefined, 'stream')!;
  k.finish(after, 'end_turn'); expect(k.getStatus()).toHaveLength(1);
});

it.each(['inflight replacement', 'error observer'])('global send-error limit survives %s', async race => {
  let reject!: (e: Error) => void;
  let replace!: () => void;
  const events: KeepaliveEvent[] = [];
  const { k, normal, begin, calls } = setup(() => new Promise((_r, j) => { reject = j; }), {
    maxConsecutiveErrors: 1,
    onEvent: (e: KeepaliveEvent) => {
      events.push(e);
      if (race === 'error observer' && e.type === 'error') replace();
    },
  });
  normal();
  replace = () => k.prefix(begin());
  await vi.advanceTimersByTimeAsync(100);
  if (race === 'inflight replacement') replace();
  reject(new Error('outage'));
  await vi.advanceTimersByTimeAsync(0);
  expect(calls.map(c => c.outcome)).toEqual(['error']);
  expect(events.map(e => e.type)).toEqual(['error', 'disabled']);
  expect(k.getStatus()).toEqual([]);
});

it('eviction of pending outcome identities is visible and invalidates old handles', () => {
  const { k, begin, events } = setup(undefined, { maxLineages: 1 });
  const old = begin();
  const other = begin('normal', wire('other'));
  expect(events).toEqual([{ type: 'skipped', key: old.key, reason: 'outcome-lru-eviction' }]);
  k.finish(old, 'end_turn'); expect(k.getStatus()).toEqual([]);
  k.finish(other, 'end_turn'); expect(k.getStatus()[0].key).toBe(other.key);
});


it('excluded-lane rearm does not unblock a pre-refusal stream handle', () => {
  const { k, begin } = setup();
  const old = begin(); k.prefix(old);
  k.finish(begin(), 'refusal');
  const complete = k.begin(wire(), undefined, 'complete')!;
  k.finish(complete, 'end_turn');
  k.prefix(old); k.finish(old, 'end_turn');
  expect(k.getStatus()).toEqual([]);
  const fresh = begin(); k.finish(fresh, 'end_turn');
  expect(k.getStatus()).toHaveLength(1);
});
