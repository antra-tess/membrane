import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CacheKeepalive, lineageKey, type KeepaliveCall, type KeepaliveEvent, type KeepaliveSuppression } from '../../src/cache-keepalive.js';
const wire = (model = 'claude-test') => ({ model, system: [{ type: 'text', text: 'system', cache_control: { type: 'ephemeral', ttl: '1h' } }], messages: [{ role: 'user', content: 'hi' }] });
const ok = { stop_reason: 'max_tokens', usage: { cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } };
const keepers: CacheKeepalive[] = [];
function setup(send: any = async () => ok, extra: any = {}) {
  const calls: KeepaliveCall[] = [], events: (KeepaliveEvent | KeepaliveSuppression)[] = [];
  const k = new CacheKeepalive(send, { suppressOnRefusal: true, refreshAfterMs: 100, checkIntervalMs: 100, maxIdleMs: 1000, onCall: c => { calls.push(c); }, onSuppressed: e => { events.push(e); }, onEvent: e => { events.push(e); }, ...extra });
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
  expect(events).toEqual([{ type: 'error', key: lineageKey(wire()), error: 'unknown-refresh-terminal: replay snapshot retired', consecutive: 0 }]);
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

it.each(['success', 'refusal', 'error'])('stale refresh %s: refusal removes replacement; errors still count globally', async outcome => {
  let resolve!: (r: any) => void, reject!: (r: any) => void;
  const deferred = new Promise((a, b) => { resolve = a; reject = b; });
  const { k, normal, calls, events } = setup(() => deferred);
  const original = normal();
  const originalSnapshot = (k as any).lineages.get(original.key);
  await vi.advanceTimersByTimeAsync(100);
  const replacement = normal();
  const replacementSnapshot = (k as any).lineages.get(replacement.key);
  expect(replacementSnapshot).toBeDefined();
  expect(replacementSnapshot).not.toBe(originalSnapshot);
  if (outcome === 'error') reject(new Error('old')); else resolve({ ...ok, stop_reason: outcome === 'refusal' ? 'refusal' : 'max_tokens' });
  await vi.advanceTimersByTimeAsync(0);
  expect(calls).toHaveLength(1);
  expect(events.map(e => e.type)).toEqual(outcome === 'error' ? ['error'] : outcome === 'refusal' ? ['suppressed'] : []);
  if (outcome === 'error') {
    expect(events).toContainEqual({ type: 'error', key: original.key, error: 'old', consecutive: 1 });
    expect((k as any).consecutiveErrors).toBe(1);
  }
  expect(k.getStatus()).toHaveLength(outcome === 'refusal' ? 0 : 1);
  expect((k as any).lineages.get(replacement.key)).toBe(outcome === 'refusal' ? undefined : replacementSnapshot);
  k.finish(k.begin(wire(), undefined, 'stream')!, 'refusal'); expect(k.getStatus()).toEqual([]);
});

it.each(['stop', 'evict', 'drop'])('old foreground and refresh cannot resurrect after %s', async action => {
  let resolve!: (r: any) => void;
  const { k, normal, begin, calls, events } = setup(() => new Promise(r => { resolve = r; }), { maxLineages: 1, maxIneffective: 1 });
  normal();
  const old = begin(); // Unregistered in-flight attempt must lose its identity.
  await vi.advanceTimersByTimeAsync(100);
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
  vi.advanceTimersByTime(5);
  const newerWire = wire();
  newerWire.messages[0].content = 'newer request';
  const newer = begin('normal', newerWire);
  k.prefix(newer); k.finish(newer, 'end_turn');
  vi.advanceTimersByTime(10);
  k.prefix(old); k.finish(old, 'end_turn');
  expect(k.getStatus()[0].realIdleMs).toBe(10);
  expect(k.getStatus()[0].idleMs).toBe(10);
  // Same lineage key, distinct messages and send times reveal stale replacement.
  expect((k as any).lineages.get(old.key).wire).toEqual(newerWire);
});

it('retained suppression is bounded and blocks an ineligible prefix', () => {
  const { k, begin } = setup(undefined, { maxLineages: 1 });
  const qualified = begin(); k.finish(qualified, 'end_turn');
  const stale = begin();
  const a = begin(); k.finish(a, 'refusal');
  const ineligible = k.begin({ ...wire(), thinking: { type: 'enabled' } }, undefined, 'stream')!;
  k.prefix(ineligible); k.finish(ineligible, undefined);
  k.prefix(stale); k.finish(stale, 'end_turn'); expect(k.getStatus()).toEqual([]);
  const evicted = begin();
  const other = begin('normal', wire('other')); k.prefix(other);
  expect(k.getStatus()).toEqual([]);
  k.finish(other, 'end_turn');
  k.prefix(evicted); k.finish(evicted, 'end_turn'); expect(k.getStatus()[0].key).toBe(other.key);
  expect((k as any).outcomes.size).toBe(1);
});

it('legacy record alone cannot bypass suppression or outcome identity', () => {
  const { k, begin, normal, events } = setup();
  k.record(wire(), undefined, 'stream');
  expect(k.getStatus()).toEqual([]);
  normal();
  expect(k.getStatus()).toHaveLength(1);
  const a = begin(); k.finish(a, 'refusal');
  expect(k.getStatus()).toEqual([]);
  expect(events).toEqual([{ type: 'suppressed', key: a.key, source: 'foreground' }]);
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
  const oldWire = wire(), newerWire = { ...wire(), max_tokens: 777 };
  const old = begin('normal', oldWire), newer = begin('normal', newerWire); k.prefix(newer);
  k.finish(old, 'end_turn');
  expect((k as any).lineages.get(old.key).wire).toEqual(oldWire);
  k.finish(newer, 'end_turn');
  expect((k as any).lineages.get(newer.key).wire).toEqual(newerWire);
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
  expect(events.filter(e => e.type === 'error' && !e.error.startsWith('unknown-refresh-terminal')).map(e => e.consecutive)).toEqual([1, 1]);
  if (reason !== 'refusal') {
    expect(events).toContainEqual(expect.objectContaining({
      type: 'error', error: 'unknown-refresh-terminal: replay snapshot retired', consecutive: 1,
    }));
  }
  expect(events.some(e => e.type === 'disabled')).toBe(false);
});

it.each(['forced-tool-choice', 'legacy-thinking-budget'])('ineligible prefix emits skipped for %s even without a terminal', reason => {
  const { k, normal, events } = setup();
  normal();
  const w = { ...wire(), ...(reason === 'forced-tool-choice' ? { tool_choice: { type: 'any' } } : { thinking: { type: 'enabled' } }) };
  const a = k.begin(w, undefined, 'stream')!;
  k.prefix(a); // Cancellation can prevent finish from ever being called.
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
  k.finish(k.begin(ineligible, undefined, 'complete')!, 'refusal');
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

it('unrelated excluded/ineligible traffic cannot evict eligible outcomes', () => {
  const { k, normal, begin, events } = setup(); normal();
  const pending = begin();
  for (let i = 0; i < 4; i++) {
    const a = k.begin({ model: `other-${i}`, messages: [] }, undefined, 'complete')!;
    k.prefix(a); k.finish(a, undefined);
  }
  expect(k.getStatus()).toHaveLength(1);
  expect((k as any).outcomes.size).toBe(1);
  expect(events).toEqual([]);
  k.prefix(pending); k.finish(pending, 'end_turn'); expect(k.getStatus()).toHaveLength(1);
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
  it.each([Infinity, NaN, 0, 0.5, 4])(
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
  const { k, begin } = setup(undefined, { onEvent, onSuppressed: onEvent, suppressOnRefusal });
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
  expect(events.map(e => e.type)).toEqual(['error', 'refreshed']);
  expect(events[0]).toMatchObject({ type: 'error', error: 'receipt-clone-failed: receipt dropped', consecutive: 0 });
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

it.each(['inflight replacement', 'error observer'])('global send-error limit survives %s', async race => {
  let reject!: (e: Error) => void;
  let replace!: () => void;
  let replacementSnapshot: unknown;
  const events: (KeepaliveEvent | KeepaliveSuppression)[] = [];
  const { k, normal, begin, calls } = setup(() => new Promise((_r, j) => { reject = j; }), {
    maxConsecutiveErrors: 1,
    onEvent: (e: KeepaliveEvent) => {
      events.push(e);
      if (race === 'error observer' && e.type === 'error') replace();
    },
  });
  normal();
  const originalSnapshot = [...(k as any).lineages.values()][0];
  expect(originalSnapshot).toBeDefined();
  replace = () => {
    const replacement = begin(); k.prefix(replacement);
    replacementSnapshot = (k as any).lineages.get(replacement.key);
  };
  await vi.advanceTimersByTimeAsync(100);
  if (race === 'inflight replacement') replace();
  reject(new Error('outage'));
  await vi.advanceTimersByTimeAsync(0);
  expect(replacementSnapshot).toBeDefined();
  expect(replacementSnapshot).not.toBe(originalSnapshot);
  expect(calls.map(c => c.outcome)).toEqual(['error']);
  expect(events.map(e => e.type)).toEqual(['error', 'disabled']);
  expect(k.getStatus()).toEqual([]);
});

it('eviction of pending outcome identities reports the cap and invalidates old handles', () => {
  const { k, begin, events } = setup(undefined, { maxLineages: 1 });
  const old = begin();
  const other = begin('normal', wire('other'));
  expect(events).toEqual([{ type: 'error', key: old.key, error: 'outcome-lru-eviction: maxLineages cap exceeded', consecutive: 0 }]);
  k.finish(old, 'end_turn'); expect(k.getStatus()).toEqual([]);
  k.finish(other, 'end_turn'); expect(k.getStatus()[0].key).toBe(other.key);
});


it('excluded-lane rearm does not unblock a pre-refusal stream handle', () => {
  const { k, begin } = setup();
  const old = begin(); k.prefix(old);
  k.finish(begin(), 'refusal');
  const complete = k.begin(wire(), undefined, 'complete')!;
  k.finish(complete, 'end_turn');
  expect((k as any).outcomes.get(complete.key).qualified).toBe(true);
  k.prefix(old); k.finish(old, 'end_turn');
  expect(k.getStatus()).toEqual([]);
  const fresh = begin(); k.finish(fresh, 'end_turn');
  expect(k.getStatus()).toHaveLength(1);
});


it('refresh refusal installs the barrier before a reentrant receipt prefix', async () => {
  let k!: CacheKeepalive, pending!: ReturnType<CacheKeepalive['begin']>;
  const onCall = vi.fn(() => {
    pending = k.begin(wire(), undefined, 'stream');
    k.prefix(pending!); // Never completes: must not inherit pre-refusal eligibility.
  });
  const state = setup(async () => ({ ...ok, stop_reason: 'refusal' }), { onCall });
  k = state.k; state.normal();
  await vi.advanceTimersByTimeAsync(100);
  expect(onCall).toHaveBeenCalledTimes(1);
  expect(state.events).toEqual([{ type: 'suppressed', key: pending!.key, source: 'refresh' }]);
  expect(k.getStatus()).toEqual([]);
  await vi.advanceTimersByTimeAsync(100);
  expect(onCall).toHaveBeenCalledTimes(1);
  k.finish(pending!, 'end_turn');
  expect(k.getStatus()).toHaveLength(1);
});

it('record-only pre-refusal wire cannot replace a qualified post-barrier snapshot', async () => {
  const send = vi.fn(async (_wire: Record<string, unknown>) => ok);
  const { k, begin } = setup(send);
  const oldWire = { ...wire(), messages: [{ role: 'user', content: 'old' }] };
  k.finish(begin(), 'refusal');
  const freshWire = { ...wire(), messages: [{ role: 'user', content: 'fresh' }] };
  const fresh = begin('normal', freshWire); k.finish(fresh, 'end_turn');
  k.record(oldWire, undefined, 'stream');
  // Nor may a record-only ineligible request delete the qualified snapshot.
  k.record({ ...oldWire, thinking: { type: 'enabled' } }, undefined, 'stream');
  expect((k as any).lineages.get(fresh.key).wire).toEqual(freshWire);
  await vi.advanceTimersByTimeAsync(100);
  expect(send.mock.calls[0][0].messages).toEqual(freshWire.messages);
});

it('a refusal handle is observed once, including reentrant finish and replay after rearm', () => {
  let k!: CacheKeepalive, refusing!: ReturnType<CacheKeepalive['begin']>;
  const onSuppressed = vi.fn((e: KeepaliveSuppression) => {
    if (e.type === 'suppressed') k.finish(refusing!, 'refusal');
  });
  const state = setup(undefined, { onSuppressed }); k = state.k;
  refusing = state.begin(); k.finish(refusing!, 'refusal');
  expect(onSuppressed).toHaveBeenCalledTimes(1);
  state.normal();
  const snapshot = (k as any).lineages.get(refusing!.key);
  expect(snapshot).toBeDefined();
  k.finish(refusing!, 'refusal');
  expect(onSuppressed).toHaveBeenCalledTimes(1);
  expect((k as any).lineages.get(refusing!.key)).toBe(snapshot);
});

it.each([null, undefined])('empty resolved refresh %s resets send failures and reports success once', async response => {
  const send = vi.fn().mockRejectedValueOnce(new Error('outage')).mockResolvedValue(response);
  const { k, normal, calls, events } = setup(send, { maxConsecutiveErrors: 2 });
  normal();
  await vi.advanceTimersByTimeAsync(200);
  expect(calls.map(c => c.outcome)).toEqual(['error', 'success']);
  expect(events.map(e => e.type)).toEqual(['error', 'error']);
  expect(k.getStatus()).toEqual([]);
  // A new failed send must start a fresh run, not disable the keeper.
  send.mockRejectedValue(new Error('new outage'));
  normal();
  await vi.advanceTimersByTimeAsync(100);
  expect(events.at(-1)).toMatchObject({ type: 'error', consecutive: 1 });
  expect(k.getStatus()).toHaveLength(1);
});

it.each(['cycle', 'toJSON'])('replay %s preparation errors retire the snapshot without changing the transport-error run', async failure => {
  const send = vi.fn(async () => { throw new Error('outage'); });
  const { k, begin, events, calls } = setup(send, { maxConsecutiveErrors: 2 });
  const w: Record<string, unknown> = wire();
  const a = begin('normal', w as ReturnType<typeof wire>); k.finish(a, 'end_turn');
  await vi.advanceTimersByTimeAsync(100);
  const owned = (k as any).lineages.get(a.key).wire; // Internal fault injection.
  if (failure === 'cycle') owned.circular = owned;
  else owned.toJSON = () => { throw new Error('cannot serialize'); };
  await vi.advanceTimersByTimeAsync(300);
  expect(send).toHaveBeenCalledTimes(1);
  expect(calls.map(c => c.outcome)).toEqual(['error']);
  expect(events).toHaveLength(2);
  expect(events.every(e => e.type === 'error' && e.consecutive === 1)).toBe(true);
  expect(k.getStatus()).toHaveLength(0);
  expect((k as any).outcomes.has(a.key)).toBe(true);
  delete w.circular; delete w.toJSON;
  const fresh = begin(); k.prefix(fresh);
  expect(k.getStatus()).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(100);
  expect(events.slice(-2).map(e => e.type)).toEqual(['error', 'disabled']);
  expect(k.getStatus()).toEqual([]);
});

it('an evicted refusal suppresses a newly retained identity and bars its pending success', () => {
  const { k, begin, normal, events } = setup(undefined, { maxLineages: 1 });
  const old = begin();
  const oldState = (k as any).outcomes.get(old.key);
  const other = begin('normal', wire('other'));
  expect([...(k as any).outcomes.keys()]).toEqual([other.key]);
  expect((k as any).outcomes.has(old.key)).toBe(false);
  const pending = begin();
  expect((k as any).outcomes.get(old.key)).not.toBe(oldState);
  expect((k as any).outcomes.has(other.key)).toBe(false);
  k.finish(old, 'refusal');
  expect(events.at(-1)).toEqual({ type: 'suppressed', key: old.key, source: 'foreground' });
  k.prefix(pending); k.finish(pending, 'end_turn');
  expect(k.getStatus()).toEqual([]);
  normal();
  expect(k.getStatus()).toHaveLength(1);
  k.finish(old, 'refusal'); // Duplicate observation must not suppress the rearm.
  expect(k.getStatus()).toHaveLength(1);
  expect((k as any).outcomes.size).toBe(1);
});

it('an evicted refusal does not recreate a forgotten identity', () => {
  const { k, begin, events } = setup(undefined, { maxLineages: 1 });
  const old = begin();
  const other = begin('normal', wire('other'));
  k.finish(other, 'end_turn');
  k.finish(old, 'refusal');
  expect(events.filter(e => e.type === 'suppressed')).toEqual([]);
  expect(k.getStatus().map(s => s.key)).toEqual([other.key]);
  expect((k as any).outcomes.size).toBe(1);
});

it.each([null, undefined])('default-off preserves main double receipts for empty response %s', async response => {
  const { k, calls, events } = setup(async () => response, { suppressOnRefusal: false });
  k.record(wire(), undefined, 'stream');
  await vi.advanceTimersByTimeAsync(100);
  expect(calls.map(c => c.outcome)).toEqual(['success', 'error']);
  expect(events).toEqual([expect.objectContaining({ type: 'error', consecutive: 1 })]);
});

it('default-off preserves main serialization-failure disable behavior', async () => {
  const send = vi.fn();
  const { k, events, calls } = setup(send, { suppressOnRefusal: false, maxConsecutiveErrors: 1 });
  const w: Record<string, unknown> = wire();
  k.record(w, undefined, 'stream'); w.circular = w;
  await vi.advanceTimersByTimeAsync(100);
  expect(send).not.toHaveBeenCalled(); expect(calls).toEqual([]);
  expect(events.map(e => e.type)).toEqual(['error', 'disabled']);
});

it.each([false, true])('receipt stop rechecks remain opt-in (%s)', async suppressOnRefusal => {
  let k!: CacheKeepalive;
  const state = setup(undefined, { suppressOnRefusal, onCall: () => k.stop('shutdown') });
  k = state.k;
  if (suppressOnRefusal) state.normal(); else k.record(wire(), undefined, 'stream');
  await vi.advanceTimersByTimeAsync(100);
  expect(state.events.map(e => e.type)).toEqual(suppressOnRefusal ? ['disabled'] : ['disabled', 'refreshed']);
});

it.each([false, true])('error observer stop rechecks remain opt-in (%s)', async suppressOnRefusal => {
  let k!: CacheKeepalive;
  const events: (KeepaliveEvent | KeepaliveSuppression)[] = [];
  const state = setup(async () => { throw new Error('outage'); }, {
    suppressOnRefusal, maxConsecutiveErrors: 1, onEvent: (e: KeepaliveEvent) => {
      events.push(e); if (e.type === 'error') k.stop('operator stop');
    },
  });
  k = state.k;
  if (suppressOnRefusal) state.normal(); else k.record(wire(), undefined, 'stream');
  await vi.advanceTimersByTimeAsync(100);
  expect(events.map(e => e.type)).toEqual(suppressOnRefusal ? ['error', 'disabled'] : ['error', 'disabled', 'disabled']);
});

it('throwing terminal metadata still delivers one error receipt', async () => {
  const response = { ...ok };
  Object.defineProperty(response, 'stop_reason', { enumerable: false, get() { throw new Error('metadata'); } });
  const { normal, calls, events } = setup(async () => response);
  normal(); await vi.advanceTimersByTimeAsync(100);
  expect(calls.map(c => c.outcome)).toEqual(['error']);
  expect(events).toEqual([expect.objectContaining({ type: 'error', consecutive: 1 })]);
});

it.each([false, true])('suppression uses only its dedicated channel (enabled %s)', suppressOnRefusal => {
  const onEvent = vi.fn(), onSuppressed = vi.fn();
  const { k, begin } = setup(undefined, { suppressOnRefusal, onEvent, onSuppressed });
  if (suppressOnRefusal) k.finish(begin(), 'refusal');
  else k.record(wire(), undefined, 'stream');
  expect(onEvent).not.toHaveBeenCalled();
  expect(onSuppressed).toHaveBeenCalledTimes(suppressOnRefusal ? 1 : 0);
});

it.each(['same identity', 'recreated identity'])('stale refresh refusal bars pre-observation attempts: %s', async identity => {
  let resolve!: (r: any) => void;
  const { k, normal, begin, events, calls } = setup(() => new Promise(r => { resolve = r; }), { maxLineages: 1 });
  const original = normal();
  const originalState = (k as any).outcomes.get(original.key);
  await vi.advanceTimersByTimeAsync(100);
  if (identity === 'recreated identity') {
    const other = begin('normal', wire('other'));
    expect([...(k as any).outcomes.keys()]).toEqual([other.key]);
    expect((k as any).outcomes.has(original.key)).toBe(false);
  }
  const replacement = normal();
  if (identity === 'recreated identity') expect((k as any).outcomes.get(original.key)).not.toBe(originalState);
  else expect((k as any).outcomes.get(original.key)).toBe(originalState);
  const pending = begin();
  expect(k.getStatus()).toHaveLength(1);
  resolve({ ...ok, stop_reason: 'refusal' });
  await vi.advanceTimersByTimeAsync(0);
  expect(events.at(-1)).toEqual({ type: 'suppressed', key: replacement.key, source: 'refresh' });
  expect(k.getStatus()).toEqual([]);
  k.prefix(pending); k.finish(pending, 'end_turn');
  k.prefix(replacement); k.finish(replacement, 'end_turn');
  expect(k.getStatus()).toEqual([]);
  await vi.advanceTimersByTimeAsync(100);
  expect(calls).toHaveLength(1);
  normal(); expect(k.getStatus()).toHaveLength(1);
});

it.each(['prefix', 'finish'])('eligibility accessor refusal cannot install a snapshot from %s', operation => {
  const { k, normal, begin, events } = setup(); normal();
  const refusing = begin();
  const w = wire();
  const attempt = begin('normal', w);
  Object.defineProperty((k as any).attempts.get(attempt).wire, 'tool_choice', { get() { k.finish(refusing, 'refusal'); return undefined; } });
  if (operation === 'prefix') k.prefix(attempt);
  else k.finish(attempt, 'end_turn');
  expect(events.at(-1)?.type).toBe('suppressed');
  expect(k.getStatus()).toEqual([]);
  k.finish(attempt, 'end_turn'); expect(k.getStatus()).toEqual([]);
});

it('refusal suppresses before an unrelated response accessor throws', async () => {
  const response = { stop_reason: 'refusal', get usage() { throw new Error('usage'); } };
  const { k, normal, begin, calls, events } = setup(async () => response);
  normal(); const pending = begin();
  await vi.advanceTimersByTimeAsync(300);
  expect(events.map(e => e.type)).toEqual(['suppressed', 'error']);
  expect(calls.map(c => c.outcome)).toEqual(['error']);
  k.finish(pending, 'end_turn');
  expect(k.getStatus()).toEqual([]);
});

it('terminal metadata is read once for classification before checking snapshot identity', async () => {
  let normal!: () => unknown, reads = 0;
  const response = { usage: ok.usage };
  Object.defineProperty(response, 'stop_reason', { get() {
    reads++;
    normal();
    return 'future_stop';
  } });
  const state = setup(async () => response); normal = state.normal;
  normal();
  await vi.advanceTimersByTimeAsync(100);
  expect(reads).toBe(1);
  expect(state.k.getStatus()).toHaveLength(1);
  expect(state.events).toEqual([]);
});

it.each(['stop', 'refusal', 'replace'])('usage accessor %s prevents stale refresh events', async action => {
  let act!: () => void, reads = 0;
  const response = { stop_reason: 'max_tokens' };
  Object.defineProperty(response, 'usage', { get() { reads++; act(); return ok.usage; } });
  const { k, begin, normal, events } = setup(async () => response);
  const original = normal();
  const originalSnapshot = (k as any).lineages.get(original.key);
  let replacement: unknown;
  let once = false;
  act = () => {
    if (once) return; once = true;
    if (action === 'stop') k.stop();
    if (action === 'refusal') k.finish(begin(), 'refusal');
    if (action === 'replace') { normal(); replacement = (k as any).lineages.get(original.key); }
  };
  await vi.advanceTimersByTimeAsync(100);
  expect(reads).toBeGreaterThan(0);
  expect(once).toBe(true);
  if (action === 'replace') {
    expect(replacement).toBeDefined();
    expect(replacement).not.toBe(originalSnapshot);
    expect((k as any).lineages.get(original.key)).toBe(replacement);
  }
  expect(events.map(e => e.type)).toEqual(action === 'refusal' ? ['suppressed'] : []);
  expect(k.getStatus()).toHaveLength(action === 'replace' ? 1 : 0);
});

it.each(['prefix', 'finish'])('eligibility accessor eviction/recreation invalidates %s', operation => {
  const { k, begin, normal } = setup(undefined, { maxLineages: 1 }); normal();
  const w = wire(), attempt = begin('normal', w);
  let replacement: unknown;
  Object.defineProperty((k as any).attempts.get(attempt).wire, 'tool_choice', { get() {
    begin('normal', wire('other'));
    const fresh = begin(); k.finish(fresh, 'end_turn');
    replacement = (k as any).lineages.get(fresh.key);
    return undefined;
  } });
  if (operation === 'prefix') k.prefix(attempt); else k.finish(attempt, 'end_turn');
  expect(replacement).toBeDefined();
  expect((k as any).lineages.get(attempt.key)).toBe(replacement);
});

it.each(['prefix', 'finish'])('eligibility accessor stop invalidates %s', operation => {
  const { k, begin, normal } = setup(); normal();
  const w = wire(), attempt = begin('normal', w);
  Object.defineProperty((k as any).attempts.get(attempt).wire, 'tool_choice', { get() { k.stop(); return undefined; } });
  if (operation === 'prefix') k.prefix(attempt); else k.finish(attempt, 'end_turn');
  expect(k.getStatus()).toEqual([]);
});

it('eligibility accessor newer prefix cannot be overwritten by the outer prefix', () => {
  const { k, begin, normal } = setup(); normal();
  const w = wire(), attempt = begin('normal', w), freshWire = wire();
  freshWire.messages[0].content = 'newer reentrant request';
  Object.defineProperty((k as any).attempts.get(attempt).wire, 'tool_choice', { get() {
    vi.advanceTimersByTime(5);
    const fresh = begin('normal', freshWire); k.prefix(fresh);
    return undefined;
  } });
  k.prefix(attempt);
  expect(k.getStatus()[0].realIdleMs).toBe(0);
  expect(k.getStatus()[0].idleMs).toBe(0);
  expect((k as any).lineages.get(attempt.key).wire).toEqual(freshWire);
});

it.each(['replace', 'refusal', 'stop'])('successful replay serialization %s prevents obsolete send', async action => {
  const send = vi.fn(async () => ok);
  const { k, begin, normal, calls } = setup(send);
  const w: Record<string, unknown> = wire();
  k.finish(begin('normal', w as ReturnType<typeof wire>), 'end_turn');
  const serialize = vi.fn(() => {
    if (action === 'replace') normal();
    if (action === 'refusal') k.finish(begin(), 'refusal');
    if (action === 'stop') k.stop();
    return { serialized: true };
  });
  // Non-root serialization succeeds without triggering the root-toJSON rejection.
  (k as any).lineages.values().next().value.wire.metadata = { toJSON: serialize };
  await vi.advanceTimersByTimeAsync(100);
  expect(serialize).toHaveBeenCalledTimes(1);
  expect(send).not.toHaveBeenCalled();
  expect(calls).toEqual([]);
  expect(k.getStatus()).toHaveLength(action === 'replace' ? 1 : 0);
});

it.each(['end_turn', 'stop_sequence', 'tool_use', 'max_tokens', 'pause_turn'])(
  'known terminal %s qualifies foreground and refresh', async reason => {
    const { k, begin, events, calls } = setup(async () => ({ ...ok, stop_reason: reason }));
    k.finish(begin(), reason);
    expect(k.getStatus()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(events.map(e => e.type)).toEqual(['refreshed']);
    expect(calls.map(c => c.outcome)).toEqual(['success']);
  },
);

it.each([{}, { suppressOnRefusal: false }])('default-off refusal never uses suppression channel (%j)', async config => {
  const onSuppressed = vi.fn();
  // Construct directly so the first case genuinely omits the flag.
  const send = vi.fn(async () => ({ ...ok, stop_reason: 'refusal' }));
  const k = new CacheKeepalive(send, {
    ...config, onSuppressed, refreshAfterMs: 100, checkIntervalMs: 100, maxIdleMs: 1000,
  });
  keepers.push(k);
  const attempt = k.begin(wire(), undefined, 'stream');
  expect(attempt).toBeUndefined();
  k.record(wire(), undefined, 'stream');
  await vi.advanceTimersByTimeAsync(300);
  expect(send).toHaveBeenCalledTimes(3);
  expect(onSuppressed).not.toHaveBeenCalled();
  expect(k.getStatus()).toHaveLength(1);
});

it.each(['system', 'tools'] as const)('begin reserves order before %s serialization can report refusal', field => {
  const { k, begin, normal } = setup(); normal();
  const refusing = begin();
  const w = wire();
  const value = field === 'system' ? w.system : null;
  Object.assign(w, { [field]: { toJSON() { k.finish(refusing, 'refusal'); return value; } } });
  const earlier = begin('normal', w);
  k.finish(earlier, 'end_turn');
  expect((k as any).outcomes.get(earlier.key).qualified).toBe(false);
  expect(k.getStatus()).toEqual([]);
  normal(); expect(k.getStatus()).toHaveLength(1);
});

it.each([1, 2])('begin cannot mutate outcomes after serialization stops keeper (cap %s)', maxLineages => {
  const { k, begin, normal, events } = setup(undefined, { maxLineages });
  normal();
  expect(k.getStatus()).toHaveLength(1);
  expect((k as any).timer).not.toBeNull();
  const w = wire();
  Object.assign(w, { system: { toJSON() { k.stop(); return wire().system; } } });
  expect(begin('normal', w)).toBeUndefined();
  expect((k as any).outcomes.size).toBe(0);
  expect(k.getStatus()).toEqual([]);
  expect((k as any).timer).toBeNull();
  expect(events).toEqual([]);
});

it('success receipt uses the single captured enumerable terminal value', async () => {
  let reads = 0;
  const response = { usage: ok.usage, get stop_reason() { return ++reads === 1 ? 'refusal' : 'end_turn'; } };
  const { k, normal, calls, events } = setup(async () => response);
  normal(); await vi.advanceTimersByTimeAsync(100);
  expect(reads).toBe(1);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ outcome: 'success', response: { stop_reason: 'refusal' } });
  expect(events.map(e => e.type)).toEqual(['suppressed']);
  expect(k.getStatus()).toEqual([]);
});

it('unknown finish cannot be replayed as a normal terminal', () => {
  const { k, begin } = setup();
  const a = begin(); k.finish(a, 'future_stop'); k.finish(a, 'end_turn');
  expect(k.getStatus()).toEqual([]);
});

it('normal finish cannot be replayed as refusal against newer work', () => {
  const { k, normal, events } = setup();
  const old = normal(); normal();
  k.finish(old, 'refusal');
  expect(k.getStatus()).toHaveLength(1);
  expect(events).toEqual([]);
});

it('serialization cannot recreate an identity evicted after a nested refusal', () => {
  const { k, begin } = setup(undefined, { maxLineages: 1 });
  const outerWire = wire();
  let serialized = 0;
  Object.assign(outerWire.system, { toJSON() {
    serialized++;
    k.finish(begin(), 'refusal');
    expect((k as any).outcomes.get(lineageKey(wire())).qualified).toBe(false);
    begin('normal', wire('other'));
    expect((k as any).outcomes.has(lineageKey(wire()))).toBe(false);
    return wire().system;
  } });
  const outer = k.begin(outerWire, undefined, 'stream');
  expect(serialized).toBe(1);
  expect(outer).toBeDefined();
  k.finish(outer!, 'end_turn');
  expect(k.getStatus()).toEqual([]);
});

it('repeated usage-processing errors reach the send failure threshold', async () => {
  const usage = { get cache_read_input_tokens(): number { throw new Error('bad usage'); } };
  const { normal, events, k } = setup(async () => ({ stop_reason: 'max_tokens', usage }), { maxConsecutiveErrors: 3 });
  normal();
  await vi.advanceTimersByTimeAsync(300);
  expect(events.filter(e => e.type === 'error' && !e.error.startsWith('receipt-clone-failed')).map(e => e.consecutive)).toEqual([1, 2, 3]);
  expect(events.some(e => e.type === 'disabled')).toBe(true);
  expect(k.getStatus()).toEqual([]);
});

it('unprintable preparation errors retire the snapshot and emit a diagnostic', async () => {
  const { k, events } = setup();
  const w = wire();
  k.finish(k.begin(w, undefined, 'stream')!, 'end_turn');
  Object.assign((k as any).lineages.values().next().value.wire, { toJSON() { throw Object.create(null); } });
  await vi.advanceTimersByTimeAsync(100);
  expect(k.getStatus()).toEqual([]);
  expect(events).toEqual([expect.objectContaining({ type: 'error', error: 'replay-preparation-failed: replay snapshot retired; Unprintable keepalive error', consecutive: 0 })]);
});

it('model context window terminal qualifies fresh and post-refusal attempts', () => {
  const { k, begin } = setup();
  k.finish(begin(), 'model_context_window_exceeded');
  expect(k.getStatus()).toHaveLength(1);
  k.finish(begin(), 'refusal');
  expect(k.getStatus()).toEqual([]);
  k.finish(begin(), 'model_context_window_exceeded');
  expect(k.getStatus()).toHaveLength(1);
});


it('hashing cannot adopt a barrier-zero identity recreated after nested refusal and eviction', () => {
  const { k, begin, events } = setup(undefined, { maxLineages: 1 });
  const key = lineageKey(wire());
  const w = wire();
  Object.assign(w.system, { toJSON() {
    const refusing = begin();
    k.finish(refusing, 'refusal');
    expect(events).toContainEqual({ type: 'suppressed', key, source: 'foreground' });
    begin('normal', wire('other'));
    expect((k as any).outcomes.has(key)).toBe(false);
    begin();
    expect((k as any).outcomes.get(key).barrier).toBe(0);
    return wire().system;
  } });
  const outer = begin('normal', w);
  k.prefix(outer); k.finish(outer, 'end_turn');
  expect(k.getStatus()).toEqual([]);
  k.finish(begin(), 'end_turn');
  expect(k.getStatus()).toHaveLength(1);
});

it('hashing reentered by an unrelated key retains a handle for a later refusal', () => {
  const { k, begin, events } = setup();
  const w = wire();
  Object.assign(w.system, { toJSON() {
    begin('normal', wire('other'));
    return wire().system;
  } });
  const refusing = begin('normal', w);
  expect(refusing).toBeDefined();
  k.finish(begin(), 'end_turn');
  expect(k.getStatus()).toHaveLength(1);
  k.finish(refusing, 'refusal');
  expect(events).toContainEqual({ type: 'suppressed', key: lineageKey(wire()), source: 'foreground' });
  expect(k.getStatus()).toEqual([]);
});

it.each(['cache_read_input_tokens', 'cache_creation_input_tokens'])('suppression counts repeated %s coercion failures', async field => {
  const { normal, events, k } = setup(async () => ({
    stop_reason: 'max_tokens', usage: { ...ok.usage, [field]: Object.create(null) },
  }), { maxConsecutiveErrors: 3 });
  normal();
  await vi.advanceTimersByTimeAsync(300);
  expect(events.filter(e => e.type === 'error').map(e => e.consecutive)).toEqual([1, 2, 3]);
  expect(events.some(e => e.type === 'disabled')).toBe(true);
  expect(k.getStatus()).toEqual([]);
});

it.each([{}, { suppressOnRefusal: false }])('default-off preserves main per-resolution resets: %j', async config => {
  // Pin main's distinction between a rejected send and a failure after resolution.
  // Run explicitly below rather than relying on timer cadence.
  for (const response of [null, undefined,
    { usage: { get cache_read_input_tokens() { throw new Error('bad usage'); } } },
    { usage: { cache_read_input_tokens: Object.create(null) } },
  ]) {
    const events: KeepaliveEvent[] = [];
    const k = new CacheKeepalive(async () => response as any, {
      ...config, refreshAfterMs: 0, maxConsecutiveErrors: 3,
      onEvent: e => { events.push(e); },
    });
    keepers.push(k);
    k.record(wire(), undefined, 'stream');
    for (let i = 0; i < 3; i++) await (k as any).tick();
    expect(events.filter(e => e.type === 'error').map(e => e.consecutive)).toEqual([1, 1, 1]);
    expect(events.some(e => e.type === 'disabled')).toBe(false);
    expect(k.getStatus()).toHaveLength(1);
    k.stop();
  }
});

it.each(['prefix', 'finish'])('lanes reentrancy cannot restore a refused or stopped snapshot via %s', operation => {
  for (const action of ['refusal', 'stop']) {
    let reenter = () => {};
    const lanes = ['stream'];
    lanes.includes = () => { reenter(); return true; };
    const { k, normal, begin } = setup(undefined, { lanes }); normal();
    expect(k.getStatus()).toHaveLength(1);
    const refusing = begin(), pending = begin();
    reenter = vi.fn(() => { if (action === 'stop') k.stop(); else k.finish(refusing, 'refusal'); });
    if (operation === 'prefix') k.prefix(pending); else k.finish(pending, 'end_turn');
    expect(reenter).toHaveBeenCalled();
    expect(k.getStatus()).toEqual([]);
  }
});

it.each(['prefix', 'finish'])('sentAt is coerced once at begin, never during %s installation', operation => {
  const { k, normal, begin } = setup(); normal();
  const refusing = begin();
  const valueOf = vi.fn(() => { k.finish(refusing, 'refusal'); return 1000; });
  const pending = k.begin(wire(), undefined, 'stream', 'normal', { valueOf } as any)!;
  expect(valueOf).toHaveBeenCalledTimes(1);
  if (operation === 'prefix') k.prefix(pending); else k.finish(pending, 'end_turn');
  expect(valueOf).toHaveBeenCalledTimes(1);
  expect(k.getStatus()).toEqual([]);
});

it('begin retains SDK-native values without replacing the caller object', () => {
  const { k } = setup();
  const w = wire();
  const a = k.begin(w, undefined, 'stream')!;
  expect(k.requestForAttempt(a)).toBe(w);
});

it('unknown terminal retires replay before an unrelated throwing getter', async () => {
  const send = vi.fn(async () => ({ stop_reason: 'future_stop', get extra() { throw new Error('extra'); } }));
  const { k, normal, events } = setup(send); normal();
  await vi.advanceTimersByTimeAsync(300);
  expect(send).toHaveBeenCalledTimes(1);
  expect(k.getStatus()).toEqual([]);
  expect(events).toContainEqual({ type: 'error', key: lineageKey(wire()), error: 'unknown-refresh-terminal: replay snapshot retired', consecutive: 0 });
});

it('begin touches an existing outcome before LRU eviction', () => {
  const { k, begin } = setup(undefined, { maxLineages: 2 });
  const a = begin('normal', wire('a')), b = begin('normal', wire('b'));
  begin('normal', wire('a')); begin('normal', wire('c'));
  expect((k as any).outcomes.has(a.key)).toBe(true);
  expect((k as any).outcomes.has(b.key)).toBe(false);
});

it('newer ineligible prefix under a barrier prevents an older snapshot', () => {
  const { k, begin, events } = setup(); k.finish(begin(), 'refusal');
  expect(events).toContainEqual({ type: 'suppressed', key: lineageKey(wire()), source: 'foreground' });
  expect((k as any).outcomes.get(lineageKey(wire()))).toMatchObject({ qualified: false, barrier: expect.any(Number) });
  expect((k as any).outcomes.get(lineageKey(wire())).barrier).toBeGreaterThan(0);
  const pending = begin();
  const newer = k.begin({ ...wire(), thinking: { type: 'enabled' } }, undefined, 'stream')!;
  k.prefix(newer); k.finish(pending, 'end_turn');
  expect(k.getStatus()).toHaveLength(0);
});

it('non-enumerable uncloneable terminal does not poison a receipt', async () => {
  const response = { usage: ok.usage };
  Object.defineProperty(response, 'stop_reason', { value: Symbol('unknown') });
  const { normal, calls } = setup(async () => response); normal();
  await vi.advanceTimersByTimeAsync(100);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ outcome: 'success', response: { usage: ok.usage } });
});

it.each(['excluded', 'registered'])('finish does not rescan discarded eligibility for %s attempts', kind => {
  const { k, normal } = setup(); normal();
  const a = k.begin(wire(), undefined, kind === 'excluded' ? 'complete' : 'stream')!;
  if (kind === 'registered') k.prefix(a);
  const owned = (k as any).attempts.get(a).wire;
  const messages = owned.messages;
  const read = vi.fn(() => messages);
  Object.defineProperty(owned, 'messages', { get: read }); // Internal scan instrumentation.
  k.finish(a, 'end_turn');
  expect(read).not.toHaveBeenCalled();
});

it.each(['cache_read_input_tokens', 'cache_creation_input_tokens'] as const)('non-finite %s counts toward shutdown', async field => {
  for (const value of ['not-a-number', NaN, Infinity, -Infinity]) {
    const { k, normal, events, calls } = setup(async () => ({ ...ok, usage: { ...ok.usage, [field]: value } }), { maxConsecutiveErrors: 2 });
    normal();
    await vi.advanceTimersByTimeAsync(200);
    expect(events.map(e => e.type)).toEqual(['error', 'error', 'disabled']);
    expect(calls.map(c => c.outcome)).toEqual(['success', 'success']);
    expect(events[0]).toMatchObject({ error: expect.stringContaining(field) });
    expect(k.getStatus()).toEqual([]);
  }
});

it('stop releases attempt data even while its handle is retained', () => {
  const { k, begin } = setup();
  const handle = begin();
  expect(k.requestForAttempt(handle)).toBeDefined();
  k.stop();
  expect(k.requestForAttempt(handle)).toBeUndefined();
  k.prefix(handle); k.finish(handle, 'end_turn');
  expect(k.getStatus()).toEqual([]);
});


it('outcome eviction reports removal of a live snapshot', () => {
  const { k, normal, begin, events } = setup(undefined, { maxLineages: 1 });
  normal(); expect(k.getStatus()).toHaveLength(1);
  const old = begin();
  expect(begin('normal', wire('other'))).toBeDefined();
  expect(k.getStatus()).toEqual([]);
  expect(events).toEqual([{ type: 'error', key: old.key, error: 'outcome-lru-eviction: maxLineages cap exceeded', consecutive: 0 }]);
  k.prefix(old); k.finish(old, 'end_turn');
  expect(k.getStatus()).toEqual([]);
});


it.each(['end_turn', 'refusal', undefined])('finish %s releases attempt data for retained handles', reason => {
  const { k, begin } = setup();
  const handle = begin();
  expect(k.requestForAttempt(handle)).toBeDefined();
  k.finish(handle, reason);
  expect(k.requestForAttempt(handle)).toBeUndefined();
  expect((k as any).attempts.has(handle)).toBe(false);
});


it('idle expiry invalidates an unfinished attempt identity', async () => {
  const { k, normal, begin, events } = setup(undefined, { maxIdleMs: 100, refreshAfterMs: 1000 });
  normal(); const pending = begin();
  expect(k.getStatus()).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(100);
  expect(events.map(e => e.type)).toEqual(['expired']);
  expect((k as any).outcomes.size).toBe(0);
  k.prefix(pending); k.finish(pending, 'end_turn');
  expect(k.getStatus()).toEqual([]);
});

it('success receipt duration excludes synchronous suppression observers', async () => {
  const { normal, calls } = setup(async () => {
    vi.setSystemTime(Date.now() + 10);
    return { ...ok, stop_reason: 'refusal' };
  }, { onSuppressed: () => vi.setSystemTime(Date.now() + 2000) });
  normal(); await vi.advanceTimersByTimeAsync(100);
  expect(calls).toHaveLength(1);
  expect(calls[0].durationMs).toBe(10);
});


it('ineffective retirement precedes an observer beginning replacement work', async () => {
  let replacement: ReturnType<CacheKeepalive['begin']>;
  let k!: CacheKeepalive;
  const state = setup(async () => ({ stop_reason: 'max_tokens', usage: {} }), {
    maxIneffective: 1,
    onEvent: (event: KeepaliveEvent) => {
      if (event.type === 'ineffective') replacement = k.begin(wire(), undefined, 'stream');
    },
  });
  k = state.k; state.normal();
  await vi.advanceTimersByTimeAsync(100);
  expect(replacement).toBeDefined();
  expect(k.getStatus()).toEqual([]);
  k.prefix(replacement!); k.finish(replacement!, 'end_turn');
  expect(k.getStatus()).toHaveLength(1);
});

it.each(['max_tokens', 'refusal', 'future_stop'])('clone failure makes no snapshot claim after %s', async stop_reason => {
  const { k, normal, calls, events } = setup(async () => ({ ...ok, stop_reason, uncloneable() {} }));
  normal(); await vi.advanceTimersByTimeAsync(100);
  expect(calls).toEqual([]);
  expect(events).toContainEqual({ type: 'error', key: lineageKey(wire()), error: 'receipt-clone-failed: receipt dropped', consecutive: 0 });
  expect(k.getStatus()).toHaveLength(stop_reason === 'max_tokens' ? 1 : 0);
  expect(events.some(e => e.type === 'refreshed')).toBe(stop_reason === 'max_tokens');
  expect(events.some(e => e.type === 'suppressed')).toBe(stop_reason === 'refusal');
});

it('stale throwing replay preparation leaves replacement and emits no diagnostic', async () => {
  const send = vi.fn(async () => ok);
  const { k, normal, calls, events } = setup(send);
  const attempt = normal();
  let replacement: unknown;
  (k as any).lineages.get(attempt.key).wire.metadata = { toJSON() {
    normal();
    replacement = (k as any).lineages.get(attempt.key);
    throw new Error('obsolete serializer');
  } };
  await vi.advanceTimersByTimeAsync(100);
  expect(send).not.toHaveBeenCalled();
  expect(calls).toEqual([]); expect(events).toEqual([]);
  expect((k as any).lineages.get(attempt.key)).toBe(replacement);
  expect(k.getStatus()).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(100);
  expect(send).toHaveBeenCalledTimes(1);
  expect(events.map(e => e.type)).toEqual(['refreshed']);
});

it('stale unreadable response metadata still hits the global processing limit', async () => {
  let resolve!: (r: unknown) => void;
  const { k, normal, calls, events } = setup(() => new Promise(r => { resolve = r; }), { maxConsecutiveErrors: 1 });
  const original = normal();
  const originalSnapshot = (k as any).lineages.get(original.key);
  expect(originalSnapshot).toBeDefined();
  await vi.advanceTimersByTimeAsync(100);
  const replacement = normal();
  expect(replacement.key).toBe(original.key);
  const replacementSnapshot = (k as any).lineages.get(replacement.key);
  expect(replacementSnapshot).toBeDefined();
  expect(replacementSnapshot).not.toBe(originalSnapshot);
  expect(k.getStatus()).toHaveLength(1);
  resolve({ stop_reason: 'max_tokens', get metadata() { throw new Error('unreadable metadata'); } });
  await vi.advanceTimersByTimeAsync(0);
  expect(calls.map(c => c.outcome)).toEqual(['error']);
  expect(events.map(e => e.type)).toEqual(['error', 'disabled']);
  expect(k.getStatus()).toEqual([]);
});

it.each(['excluded', 'ineligible', 'maintenance'])('untracked %s refusal still suppresses a subsequently retained key', kind => {
  const { k, normal } = setup();
  const w = kind === 'ineligible' ? { ...wire(), thinking: { type: 'enabled' } } : wire();
  const detached = k.begin(w, undefined, kind === 'excluded' ? 'complete' : 'stream',
    kind === 'maintenance' ? 'maintenance' : 'normal')!;
  expect((k as any).outcomes.size).toBe(0);
  normal();
  expect(k.getStatus()).toHaveLength(1);
  k.finish(detached, 'refusal');
  expect(k.getStatus()).toEqual([]);
});

it.each(['lanes', 'eligibility'] as const)('admission %s reentrant stop cannot retain a new request', source => {
  for (const eligible of [false, true]) {
    const { k, events } = setup();
    const w = wire();
    const accessor = vi.fn(() => { k.stop(); return eligible; });
    if (source === 'lanes') (k as any).cfg.lanes = { includes: accessor };
    else Object.defineProperty(w, 'thinking', { get() { return accessor() ? undefined : { type: 'enabled' }; } });
    const attempt = k.begin(w, { authorization: 'test-secret' }, 'stream');
    expect(accessor).toHaveBeenCalledTimes(1);
    expect(attempt).toBeUndefined();
    expect((k as any).outcomes.size).toBe(0);
    expect(k.getStatus()).toEqual([]);
    expect(events).toEqual([]);
  }
});

it('processing-error receipt duration excludes suppression observer time', async () => {
  const { normal, calls, events } = setup(async () => {
    vi.setSystemTime(Date.now() + 10);
    return { stop_reason: 'refusal', get usage() { throw new Error('metadata'); } };
  }, { onSuppressed: () => vi.setSystemTime(Date.now() + 2000) });
  normal(); await vi.advanceTimersByTimeAsync(100);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ outcome: 'error', durationMs: 10 });
  expect(events).toEqual([expect.objectContaining({ type: 'error', consecutive: 1 })]);
});

it('sender rejection after stop delivers receipt without changing failures or emitting events', async () => {
  let reject!: (error: Error) => void;
  const send = vi.fn(() => new Promise((_resolve, rejectSend) => { reject = rejectSend; }));
  const { k, normal, calls, events } = setup(send, { maxConsecutiveErrors: 1 });
  normal();
  await vi.advanceTimersByTimeAsync(100);
  expect(send).toHaveBeenCalledTimes(1);
  k.stop();
  const failures = (k as any).consecutiveErrors;
  reject(new Error('late rejection'));
  await vi.advanceTimersByTimeAsync(0);
  expect(calls).toEqual([expect.objectContaining({ outcome: 'error', error: expect.objectContaining({ message: 'late rejection' }) })]);
  expect((k as any).consecutiveErrors).toBe(failures);
  expect(events).toEqual([]);
  expect(k.getStatus()).toEqual([]);
});

it('outcome eviction leaves failure count unchanged before the next transport failure', async () => {
  const { k, begin, normal, events } = setup(async () => { throw new Error('outage'); }, {
    maxLineages: 1, maxConsecutiveErrors: 2,
  });
  normal();
  await vi.advanceTimersByTimeAsync(100);
  expect((k as any).consecutiveErrors).toBe(1);
  const other = begin('normal', wire('other'));
  expect(events.at(-1)).toMatchObject({ type: 'error', error: 'outcome-lru-eviction: maxLineages cap exceeded', consecutive: 1 });
  expect((k as any).consecutiveErrors).toBe(1);
  k.finish(other, 'end_turn');
  await vi.advanceTimersByTimeAsync(100);
  expect(events.slice(-2)).toEqual([
    expect.objectContaining({ type: 'error', error: 'outage', consecutive: 2 }),
    expect.objectContaining({ type: 'disabled' }),
  ]);
});
