/**
 * The real SDK can surface request rejection at the first iterator event, or
 * transport failure after earlier events (distinct from semantic refusal),
 * after messages.stream() has returned. The provider's cache clock
 * starts at a request's send.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { lineageKey, type CacheKeepaliveConfig, type KeepaliveEvent, type KeepaliveSuppression } from '../../src/cache-keepalive.js';

const START = Date.parse('2026-10-19T00:00:00Z');
const timing = { refreshAfterMs: 100, checkIntervalMs: 100, maxIdleMs: 10_000 };

function request(system: string, turns = 1) {
  const hour = { type: 'ephemeral', ttl: '1h' };
  return {
    model: 'claude-opus-4-1', maxTokens: 1024,
    system: [{ type: 'text', text: system, cache_control: hour }],
    messages: Array.from({ length: turns }, (_, i) => ({
      role: 'user',
      content: [{ type: 'text', text: `turn ${i}`, ...(i === turns - 1 ? { cache_control: hour } : {}) }],
    })),
  } as any;
}

const readUsage = { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 };
const answer = { id: 'msg', model: 'claude-opus-4-1', role: 'assistant', type: 'message', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { ...readUsage, output_tokens: 1 } };
const unreachable = () => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' });

const messageStart = { type: 'message_start', message: { model: 'claude-opus-4-1', usage: { input_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } } };
const rest = [
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
];

function sdkStream(events: unknown[], failure?: Error) {
  return {
    controller: { abort() { } },
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next() {
          if (index < events.length) return { value: events[index++], done: false };
          if (failure) throw failure;
          return { value: undefined, done: true };
        },
      };
    },
  };
}

function held() {
  let release!: (value: unknown) => void;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

function heldStream(gate: Promise<unknown>, events: unknown[]) {
  const inner = sdkStream(events)[Symbol.asyncIterator]();
  let waited = false;
  return {
    controller: { abort() { } },
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (!waited) { waited = true; await gate; }
          return inner.next();
        },
      };
    },
  };
}

const adapters: AnthropicAdapter[] = [];
function adapter(config: CacheKeepaliveConfig, create: (wire: any) => unknown, stream?: (wire: any) => unknown) {
  const events: (KeepaliveEvent | KeepaliveSuppression)[] = [];
  const a = new AnthropicAdapter({ apiKey: 'sk-test', cacheKeepalive: { ...timing, ...config, onSuppressed: e => { events.push(e); }, onEvent: e => { events.push(e); } } });
  adapters.push(a);
  const sent: any[] = [];
  const client: any = {
    messages: {
      create: vi.fn(async (wire: any) => { sent.push(wire); return create(wire); }),
      stream: vi.fn(async (wire: any) => stream!(wire)),
    },
  };
  client.withOptions = () => client;
  (a as any).client = client;
  const replays = () => sent.filter(w => w.max_tokens === 0);
  return { a, events, replays, client };
}

const settle = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);
const noCallbacks = { onChunk: () => {} } as any;

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(START); });
afterEach(() => {
  for (const a of adapters.splice(0)) a.cacheKeepalive?.stop();
  vi.restoreAllMocks();
  vi.useRealTimers();
});


for (const lane of ['complete', 'stream'] as const) {
  describe(`opt-in ${lane} raw refusal observation`, () => {
    it('suppresses positive-read refusal, ignores unknown/maintenance, then rearms normal', async () => {
      let reason: any = 'end_turn';
      const { a, replays, events } = adapter({ suppressOnRefusal: true, lanes: [lane] },
        wire => ({ ...answer, stop_reason: wire.max_tokens === 0 ? 'max_tokens' : reason }),
        () => sdkStream([messageStart, { type: 'message_delta', delta: { stop_reason: reason }, usage: readUsage }]));
      const run = (options?: any) => lane === 'complete' ? a.complete(request('same'), options)
        : a.stream(request('same'), noCallbacks, options);
      await run(); expect(a.cacheKeepalive!.getStatus()).toHaveLength(1);
      reason = 'refusal';
      expect((await run()).stopReason).toBe('refusal');
      expect(events.map(e => e.type)).toContain('suppressed');
      expect(a.cacheKeepalive!.getStatus()).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(100);
      expect(replays()).toHaveLength(0);
      reason = undefined;
      await run(); // parse fallback end_turn is NOT known normal
      expect(a.cacheKeepalive!.getStatus()).toHaveLength(0);
      reason = 'end_turn';
      await run({ keepalivePurpose: 'maintenance' });
      expect(a.cacheKeepalive!.getStatus()).toHaveLength(0);
      await run();
      expect(a.cacheKeepalive!.getStatus()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(100);
      expect(replays()).toHaveLength(1);
      expect(replays()[0]).not.toHaveProperty('keepalivePurpose');
    });

    it('observes refusal from a disabled lane sharing a scheduled key', async () => {
      let reason = 'end_turn';
      const { a } = adapter({ suppressOnRefusal: true, lanes: [lane === 'stream' ? 'complete' : 'stream'] },
        () => ({ ...answer, stop_reason: reason }),
        () => sdkStream([messageStart, { type: 'message_delta', delta: { stop_reason: reason }, usage: readUsage }]));
      if (lane === 'stream') await a.complete(request('shared'));
      else await a.stream(request('shared'), noCallbacks);
      expect(a.cacheKeepalive!.getStatus()).toHaveLength(1);
      reason = 'refusal';
      if (lane === 'stream') await a.stream(request('shared'), noCallbacks);
      else await a.complete(request('shared'));
      expect(a.cacheKeepalive!.getStatus()).toHaveLength(0);
    });

    it('does not rearm older in-flight success at the same timestamp', async () => {
      const gate = held();
      let first = true;
      const { a } = adapter({ suppressOnRefusal: true, lanes: [lane] },
        () => { if (first) { first = false; return gate.promise; } return { ...answer, stop_reason: 'refusal' }; },
        () => { if (first) { first = false; return heldStream(gate.promise, [messageStart, ...rest]); }
          return sdkStream([messageStart, { type: 'message_delta', delta: { stop_reason: 'refusal' }, usage: readUsage }]); });
      const run = () => lane === 'complete' ? a.complete(request('race')) : a.stream(request('race'), noCallbacks);
      const old = run();
      await run();
      gate.release(answer);
      await old;
      expect(a.cacheKeepalive!.getStatus()).toHaveLength(0);
    });
  });
}

it('legacy resolved refusal continues scheduling by default', async () => {
  const { a, replays } = adapter({ lanes: ['complete'] }, () => ({ ...answer, stop_reason: 'refusal' }));
  await a.complete(request('legacy'));
  await vi.advanceTimersByTimeAsync(100);
  expect(replays()).toHaveLength(1);
});

for (const lane of ['complete', 'stream'] as const) {
  for (const suppression of [{}, { suppressOnRefusal: false }]) {
    it(`default-off ${lane} isolates record failure (${JSON.stringify(suppression)})`, async () => {
      const { a, client } = adapter({ ...suppression, lanes: [lane] }, () => answer,
        () => sdkStream([messageStart, ...rest]));
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const record = vi.spyOn(a.cacheKeepalive!, 'record').mockImplementation(() => {
        throw new Error('record bookkeeping');
      });
      const result = lane === 'complete' ? await a.complete(request('record-error'))
        : await a.stream(request('record-error'), noCallbacks);
      expect(result.stopReason).toBe('end_turn');
      expect(result.content).toEqual([{ type: 'text', text: 'ok' }]);
      expect(record).toHaveBeenCalledTimes(1);
      expect(record.mock.calls[0][2]).toBe(lane);
      expect(lane === 'complete' ? client.messages.create : client.messages.stream).toHaveBeenCalledTimes(1);
      expect(warning).toHaveBeenCalledTimes(1);
    });
  }
}

it('bookkeeping exceptions do not break foreground results', async () => {
  const { a } = adapter({ suppressOnRefusal: true, lanes: ['complete'] }, () => answer);
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const finish = a.cacheKeepalive!.finish.bind(a.cacheKeepalive!);
  vi.spyOn(a.cacheKeepalive!, 'finish').mockImplementation((...args) => { finish(...args); throw new Error('observer'); });
  expect((await a.complete(request('safe'))).stopReason).toBe('end_turn');
  expect(a.cacheKeepalive!.getStatus()).toHaveLength(1); // State changed before the throw.
  expect(warning).toHaveBeenCalledWith('[membrane] Keepalive bookkeeping failed; state may be partially updated. Check custom request serialization; disable cacheKeepalive if failures persist.');
  warning.mockRestore();
});

for (const lane of ['complete', 'stream'] as const) {
  it(`${lane}: refresh refusal has one real-adapter receipt and cannot warm-stamp`, async () => {
    const calls: any[] = [];
    const { a, events, replays } = adapter({ suppressOnRefusal: true, lanes: [lane], onCall: c => { calls.push(c); } },
      w => ({ ...answer, stop_reason: w.max_tokens === 0 ? 'refusal' : 'end_turn' }),
      () => sdkStream([messageStart, ...rest]));
    if (lane === 'complete') await a.complete(request('refresher')); else await a.stream(request('refresher'), noCallbacks);
    await vi.advanceTimersByTimeAsync(100);
    expect(replays()).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].outcome).toBe('success');
    expect(events.map(e => e.type)).toEqual(['suppressed']);
    expect(a.cacheKeepalive!.getStatus()).toEqual([]);
  });

  it(`${lane}: actual errors/caller cancellation after refusal cannot rearm or lose signal`, async () => {
    let mode = 'end_turn';
    const { a, client, events } = adapter({ suppressOnRefusal: true, lanes: [lane] },
      () => { if (mode === 'error') throw unreachable(); return { ...answer, stop_reason: mode }; },
      () => mode === 'error' ? sdkStream([messageStart], unreachable())
        : sdkStream([messageStart, { type: 'message_delta', delta: { stop_reason: mode }, usage: readUsage }]));
    const run = (options?: any) => lane === 'complete' ? a.complete(request('errors'), options) : a.stream(request('errors'), noCallbacks, options);
    await run(); expect(a.cacheKeepalive!.getStatus()).toHaveLength(1);
    mode = 'refusal'; await run();
    expect(events.map(e => e.type)).toContain('suppressed');
    mode = 'error';
    expect(await settle(run())).toBeDefined();
    expect(a.cacheKeepalive!.getStatus()).toEqual([]);
    mode = 'end_turn';
    const abort = new AbortController(); abort.abort();
    await settle(run({ signal: abort.signal }));
    expect(a.cacheKeepalive!.getStatus()).toEqual([]);
    const sdkOptions = (lane === 'complete' ? client.messages.create : client.messages.stream).mock.calls.at(-1)[1];
    expect(sdkOptions.signal.aborted).toBe(true);
    expect(sdkOptions.maxRetries).toBe(0);
    await run(); expect(a.cacheKeepalive!.getStatus()).toHaveLength(1);
  });
}

it('complete parse failure after a barrier cannot rearm, but refusal survives parse failure', async () => {
  let response: any = { ...answer, stop_reason: 'refusal' };
  const { a, events } = adapter({ suppressOnRefusal: true, lanes: ['complete'] }, () => response);
  await a.complete(request('parse'));
  expect(events.map(e => e.type)).toEqual(['suppressed']);
  response = { ...answer, usage: undefined };
  expect(await settle(a.complete(request('parse')))).toBeDefined();
  expect(a.cacheKeepalive!.getStatus()).toEqual([]);
  response = answer; await a.complete(request('parse'));
  response = { ...answer, stop_reason: 'refusal', usage: undefined };
  expect(await settle(a.complete(request('parse')))).toBeDefined();
  expect(a.cacheKeepalive!.getStatus()).toEqual([]);
});

it('opt-in complete deadline still aborts the SDK and cannot rearm', async () => {
  const { a, client } = adapter({ suppressOnRefusal: true, lanes: ['complete'] }, () => ({ ...answer, stop_reason: 'refusal' }));
  await a.complete(request('deadline'));
  client.messages.create.mockImplementation((_wire: any, options: any) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  }));
  const result = settle(a.complete(request('deadline'), { timeoutMs: 20 }));
  await vi.advanceTimersByTimeAsync(20);
  expect((await result as any).type).toBe('timeout');
  expect(a.cacheKeepalive!.getStatus()).toEqual([]);
  expect(client.messages.create.mock.calls.at(-1)[0]).not.toHaveProperty('keepalivePurpose');
});

for (const lane of ['complete', 'stream'] as const) {
  for (const action of ['replace', 'drop', 'stop', 'evict']) {
    it(`${lane}: old SDK completion cannot resurrect ${action}d identity`, async () => {
      const gate = held(), entry = held(); let holdNext = false, entered = false;
      const { a, replays } = adapter({ suppressOnRefusal: true, lanes: [lane], maxLineages: 1, maxIneffective: 1 },
        w => {
          if (w.max_tokens === 0) return { ...answer, stop_reason: 'max_tokens', usage: {} };
          if (holdNext) { holdNext = false; entered = true; entry.release(undefined); return gate.promise; }
          return answer;
        },
        () => {
          if (holdNext) { holdNext = false; entered = true; entry.release(undefined); return heldStream(gate.promise, [messageStart, ...rest]); }
          return sdkStream([messageStart, ...rest]);
        });
      const run = (system = 'retire', turns = 1) => lane === 'complete' ? a.complete(request(system, turns)) : a.stream(request(system, turns), noCallbacks);
      await run(); holdNext = true;
      const old = run();
      await entry.promise;
      expect(entered).toBe(true);
      if (action === 'stop') a.cacheKeepalive!.stop();
      if (action === 'evict') await run('other');
      const retainedKeys = a.cacheKeepalive!.getStatus().map(s => s.key);
      if (action === 'evict') expect(retainedKeys).toEqual([lineageKey({
        model: request('other').model, system: request('other').system,
      })]);
      if (action === 'replace') await run('retire', 2);
      if (action === 'drop') await vi.advanceTimersByTimeAsync(100);
      gate.release(answer); await old;
      expect(a.cacheKeepalive!.getStatus()).toHaveLength(action === 'replace' || action === 'evict' ? 1 : 0);
      if (action === 'evict') expect(a.cacheKeepalive!.getStatus().map(s => s.key)).toEqual(retainedKeys);
      if (action === 'replace') {
        await vi.advanceTimersByTimeAsync(100);
        expect(replays()[0].messages).toHaveLength(2);
      }
    });
  }
}

for (const lane of ['complete', 'stream'] as const) {
  for (const mode of ['maintenance', 'unknown'] as const) {
    it(`${lane}: ${mode} cannot qualify evicted identity; normal default can`, async () => {
      let reason: any = mode === 'maintenance' ? 'max_tokens' : undefined;
      const { a, replays, events } = adapter({ suppressOnRefusal: true, lanes: ['complete', 'stream'], maxLineages: 1 },
        w => ({ ...answer, stop_reason: w.max_tokens === 0 ? 'max_tokens' : reason }),
        () => sdkStream([messageStart, { type: 'message_delta', delta: { stop_reason: reason }, usage: readUsage }]));
      const run = (key: string, options?: any) => lane === 'complete' ? a.complete(request(key), options)
        : a.stream(request(key), noCallbacks, options);
      const options = mode === 'maintenance' ? { keepalivePurpose: 'maintenance' } : undefined;
      reason = 'end_turn'; await run('A');
      expect(a.cacheKeepalive!.getStatus()).toHaveLength(1);
      reason = 'refusal'; await run('A');
      expect(events.map(e => e.type)).toContain('suppressed');
      reason = mode === 'maintenance' ? 'max_tokens' : undefined;
      await run('A', options); // Retained-barrier control.
      expect(a.cacheKeepalive!.getStatus()).toEqual([]);
      const aKey = lineageKey({ model: request('A').model, system: request('A').system });
      const bKey = lineageKey({ model: request('B').model, system: request('B').system });
      expect((a.cacheKeepalive as any).outcomes.has(aKey)).toBe(true);
      reason = undefined; await run('B'); // Evict A with no known-normal success.
      expect([...(a.cacheKeepalive as any).outcomes.keys()]).toEqual([bKey]);
      expect(events).toContainEqual({ type: 'skipped', key: aKey, reason: 'outcome-lru-eviction' });
      reason = mode === 'maintenance' ? 'max_tokens' : undefined;
      await run('A', options);
      await vi.advanceTimersByTimeAsync(100);
      expect(replays()).toHaveLength(0);
      expect(a.cacheKeepalive!.getStatus()).toEqual([]);
      expect((a.cacheKeepalive as any).outcomes.size).toBe(1);
      reason = 'max_tokens'; await run('A'); // Honest normal-default declaration.
      await vi.advanceTimersByTimeAsync(100);
      expect(replays()).toHaveLength(1); // Actual adapter refresh sender, not status alone.
    });
  }
}

it('raw stream refusal survives throwing progress with real generator cleanup and foreground error', async () => {
  let reason = 'end_turn', closed = 0;
  const { a, replays, events } = adapter({ suppressOnRefusal: true }, () => answer,
    () => ({ controller: { abort() {} }, async *[Symbol.asyncIterator]() {
      try {
        yield messageStart;
        yield { type: 'message_delta', delta: { stop_reason: reason }, usage: readUsage };
        throw new Error('terminal break must close rather than resume generator');
      } finally { closed++; }
    } }));
  await a.stream(request('progress'), noCallbacks);
  expect(closed).toBe(1);
  reason = 'refusal';
  let progressCount = 0;
  // onProgress receives a classification, not the raw SDK event. The second
  // notification here corresponds exactly to the yielded message_delta.
  const progress = vi.fn(() => { if (++progressCount % 2 === 0) throw new Error('observer failed'); });
  const failure = await settle(a.stream(request('progress'), noCallbacks, { onProgress: progress }));
  expect(String((failure as any).message)).toContain('observer failed');
  expect(progress).toHaveBeenCalledTimes(2);
  expect(closed).toBe(2);
  expect(events.map(e => e.type)).toEqual(['suppressed']);
  expect(a.cacheKeepalive!.getStatus()).toEqual([]);
  await vi.advanceTimersByTimeAsync(100);
  expect(replays()).toHaveLength(0);
  reason = 'end_turn';
  // Normal terminal received but callback failed: not successful rearm.
  expect(await settle(a.stream(request('progress'), noCallbacks, { onProgress: progress }))).toBeDefined();
  expect(closed).toBe(3);
  expect(a.cacheKeepalive!.getStatus()).toEqual([]);
  const abort = new AbortController();
  await settle(a.stream(request('progress'), noCallbacks, { signal: abort.signal,
    onProgress: () => { if (++progressCount % 2 === 0) abort.abort(); } }));
  expect(closed).toBe(4);
  expect(a.cacheKeepalive!.getStatus()).toEqual([]);
  await a.stream(request('progress'), noCallbacks);
  expect(closed).toBe(5);
  await vi.advanceTimersByTimeAsync(100);
  expect(replays()).toHaveLength(1);
});


it('complete refusal is observed even if prefix bookkeeping throws', async () => {
  let reason = 'end_turn';
  const { a, events } = adapter({ suppressOnRefusal: true, lanes: ['complete'] }, () => ({ ...answer, stop_reason: reason }));
  await a.complete(request('prefix-error'));
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(a.cacheKeepalive!, 'prefix').mockImplementation(() => { throw new Error('prefix'); });
  reason = 'refusal';
  expect((await a.complete(request('prefix-error'))).stopReason).toBe('refusal');
  expect(events.map(e => e.type)).toContain('suppressed');
  expect(a.cacheKeepalive!.getStatus()).toEqual([]);
  warning.mockRestore();
});

it('abort in final open content callback cannot qualify a stream with combined signal', async () => {
  const { a } = adapter({ suppressOnRefusal: true }, () => answer,
    () => sdkStream([messageStart,
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: readUsage },
    ]));
  const abort = new AbortController();
  let blocks = 0;
  const onContentBlock = vi.fn(() => { if (++blocks === 2) abort.abort(); });
  await a.stream(request('late-abort'), { ...noCallbacks, onContentBlock }, { signal: abort.signal, timeoutMs: 1000 });
  expect(onContentBlock).toHaveBeenCalledTimes(2);
  expect(abort.signal.aborted).toBe(true);
  expect(a.cacheKeepalive!.getStatus()).toEqual([]);
});


for (const lane of ['complete', 'stream'] as const) {
  it(`${lane}: failed begin stops keepalive rather than losing a later refusal`, async () => {
    let reason = 'end_turn';
    const { a, replays, events } = adapter({ suppressOnRefusal: true, lanes: [lane] },
      w => { JSON.stringify(w); return { ...answer, stop_reason: reason }; },
      w => { JSON.stringify(w); return sdkStream([messageStart, { type: 'message_delta', delta: { stop_reason: reason }, usage: readUsage }]); });
    const run = (options?: any) => lane === 'complete' ? a.complete(request('begin-error'), options)
      : a.stream(request('begin-error'), noCallbacks, options);
    await run(); expect(a.cacheKeepalive!.getStatus()).toHaveLength(1);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    reason = 'refusal';
    let serializations = 0;
    const result = await run({ onRequest: (w: any) => {
      const original = w.system;
      w.system = { toJSON() {
        if (++serializations === 1) throw new Error('custom serialization');
        return original;
      } };
    } });
    expect(result.stopReason).toBe('refusal');
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('keepalive is now permanently stopped for this adapter'));
    expect(events).toEqual([{ type: 'disabled', reason: 'keepalive begin bookkeeping failed' }]);
    expect(a.cacheKeepalive!.getStatus()).toEqual([]);
    reason = 'end_turn';
    await run(); // Later successful foreground calls cannot restart this keeper.
    await vi.advanceTimersByTimeAsync(100);
    expect(a.cacheKeepalive!.getStatus()).toEqual([]);
    expect(events).toHaveLength(1);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(replays()).toHaveLength(0);
    warning.mockRestore();
  });
}

it('complete qualification checks caller abort even if combined-signal propagation is blocked', async () => {
  const abort = new AbortController();
  abort.signal.addEventListener('abort', e => e.stopImmediatePropagation());
  const { a } = adapter({ suppressOnRefusal: true, lanes: ['complete'] }, () => {
    abort.abort();
    return answer;
  });
  await settle(a.complete(request('blocked-abort'), { signal: abort.signal, timeoutMs: 1000 }));
  expect(abort.signal.aborted).toBe(true);
  expect(a.cacheKeepalive!.getStatus()).toEqual([]);
});

it.each(['complete', 'stream'] as const)('default-off %s ignores keepalivePurpose accessors', async lane => {
  const { a, replays, events } = adapter({ lanes: [lane] }, () => answer, () => sdkStream([messageStart, ...rest]));
  const options = { get keepalivePurpose(): 'normal' { throw new Error('must not read'); } };
  if (lane === 'complete') await a.complete(request('system'), options);
  else await a.stream(request('system'), noCallbacks, options);
  await vi.advanceTimersByTimeAsync(100);
  expect(replays()).toHaveLength(1);
  expect(events.some(e => e.type === 'disabled')).toBe(false);
});
