import { afterEach, expect, it, vi } from 'vitest';
import { CacheKeepalive, cacheLineageKey, type KeepaliveSend, type CacheKeepaliveConfig, type KeepaliveDiagnostic, type KeepaliveEvent } from '../../src/index.js';

const keepers: CacheKeepalive[] = [];
afterEach(() => { keepers.splice(0).forEach(k => k.stop()); vi.useRealTimers(); });
const wire = (model = 'claude-test') => ({
  model, system: [{ type: 'text', text: 'system', cache_control: { type: 'ephemeral', ttl: '1h' } }],
  messages: [{ role: 'user', content: 'hi' }],
});
const ok = { stop_reason: 'max_tokens', usage: { cache_read_input_tokens: 100 } };
function setup(send: KeepaliveSend = async () => ok, config: CacheKeepaliveConfig = {}) {
  vi.useFakeTimers();
  const events: KeepaliveEvent[] = [], diagnostics: KeepaliveDiagnostic[] = [];
  const keeper = new CacheKeepalive(send, {
    suppressOnRefusal: true, refreshAfterMs: 0, checkIntervalMs: 100,
    onEvent: e => { events.push(e); }, onDiagnostic: d => { diagnostics.push(d); }, ...config,
  });
  keepers.push(keeper);
  const qualify = (model?: string) => keeper.finish(keeper.begin(wire(model), undefined, 'stream')!, 'end_turn');
  return { keeper, qualify, events, diagnostics, send };
}

it('distinguishes retryable ineffective refresh from retirement without changing legacy events', async () => {
  const send = vi.fn()
    .mockResolvedValueOnce({ stop_reason: 'max_tokens', usage: { cache_read_input_tokens: 0 } })
    .mockResolvedValueOnce({ stop_reason: 'max_tokens', usage: { cache_read_input_tokens: 30, cache_creation_input_tokens: 70 } });
  const { keeper, qualify, events, diagnostics } = setup(send, { maxIneffective: 2 });
  qualify();
  await vi.advanceTimersByTimeAsync(100);
  expect(keeper.getStatus()).toHaveLength(1);
  expect(diagnostics).toEqual([]);
  await vi.advanceTimersByTimeAsync(100);
  expect(keeper.getStatus()).toEqual([]);
  const key = cacheLineageKey(wire());
  expect(events).toEqual([
    { type: 'ineffective', key, reason: 'no-cache-read', readTokens: 0, writeTokens: 0 },
    { type: 'ineffective', key, reason: 'wrote-instead-of-read', readTokens: 30, writeTokens: 70 },
  ]);
  expect(diagnostics).toEqual([{
    type: 'diagnostic', key,
    reason: 'ineffective-retirement: replay snapshot and identity retired after 2 consecutive ineffective refreshes',
  }]);
});

it('unknown resolved refresh after failure emits no additional error event or stale failure count', async () => {
  const send = vi.fn().mockRejectedValueOnce(new Error('outage')).mockResolvedValueOnce({ ...ok, stop_reason: null });
  const { qualify, events, diagnostics } = setup(send);
  qualify();
  await vi.advanceTimersByTimeAsync(200);
  expect(events).toEqual([expect.objectContaining({ type: 'error', consecutive: 1, error: 'outage' })]);
  expect(diagnostics).toEqual([expect.objectContaining({ type: 'diagnostic', reason: 'unknown-refresh-terminal: replay snapshot retired' })]);
  expect(diagnostics[0]).not.toHaveProperty('consecutive');
});

it.each(['throw', 'reject'] as const)('isolates a diagnostic observer that %ss', async failure => {
  const observer = vi.fn(() => {
    if (failure === 'throw') throw new Error('observer');
    return Promise.reject(new Error('observer'));
  });
  const { keeper, qualify, events } = setup(undefined, { onDiagnostic: observer, maxLineages: 1 });
  qualify('a'); qualify('b');
  await vi.advanceTimersByTimeAsync(100);
  expect(observer).toHaveBeenCalledTimes(1);
  expect(keeper.getStatus()).toHaveLength(1);
  expect(events.map(e => e.type)).toEqual(['refreshed']);
});

it('does not deliver diagnostics when suppression is off', async () => {
  const { keeper, diagnostics, events } = setup(async () => ({ stop_reason: 'max_tokens', usage: {} }), { suppressOnRefusal: false, maxIneffective: 1 });
  keeper.record(wire(), undefined, 'stream');
  await vi.advanceTimersByTimeAsync(100);
  expect(keeper.getStatus()).toEqual([]);
  expect(events.map(e => e.type)).toEqual(['ineffective']);
  expect(diagnostics).toEqual([]);
});

it('keeps the adapter-global consecutive limit distinct from a per-key retry budget', async () => {
  const send = vi.fn(async (payload: Record<string, unknown>) => payload.model === 'broken'
    ? { stop_reason: 'max_tokens', usage: { cache_read_input_tokens: NaN } } : ok);
  const { qualify, events, keeper } = setup(send, { maxConsecutiveErrors: 2 });
  qualify('broken'); qualify('healthy');
  await vi.advanceTimersByTimeAsync(300);
  expect(send).toHaveBeenCalledTimes(6);
  expect(events.filter(e => e.type === 'error').map(e => e.consecutive)).toEqual([1, 1, 1]);
  expect(events.filter(e => e.type === 'refreshed')).toHaveLength(3);
  expect(events.some(e => e.type === 'disabled')).toBe(false);
  expect(keeper.getStatus()).toHaveLength(2);
});

it('does not return an attempt after a pending-eviction observer stops the keeper', () => {
  const observer = vi.fn(() => keeper.stop());
  const { keeper, qualify } = setup(undefined, { maxLineages: 1, onDiagnostic: observer });
  qualify('a');
  expect(keeper.getStatus()).toHaveLength(1);
  const pending = keeper.begin(wire('b'), undefined, 'stream')!;
  expect(keeper.getStatus()).toHaveLength(1);
  expect(observer).not.toHaveBeenCalled();
  const attempt = keeper.begin(wire('c'), undefined, 'stream');
  expect(observer).toHaveBeenCalledTimes(1);
  expect(attempt).toBeUndefined();
  expect(keeper.requestForAttempt(pending)).toBeUndefined();
  expect(keeper.getStatus()).toEqual([]);
});

it('reports preparation retirement only onDiagnostic without exception payloads', async () => {
  const send = vi.fn(async () => ok);
  const { keeper, events, diagnostics } = setup(send);
  const request = wire();
  keeper.finish(keeper.begin(request, undefined, 'stream')!, 'end_turn');
  Object.defineProperty(request.messages[0], 'toJSON', {
    value() { throw new Error('secret prompt or credential'); },
  });
  await vi.advanceTimersByTimeAsync(100);
  expect(keeper.getStatus()).toEqual([]);
  expect(send).not.toHaveBeenCalled();
  expect(events).toEqual([]);
  expect(diagnostics).toEqual([{
    type: 'diagnostic', key: cacheLineageKey(wire()),
    reason: 'replay-preparation-failed: replay snapshot retired',
  }]);
});
