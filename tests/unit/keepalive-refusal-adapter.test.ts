/**
 * The real SDK can surface request rejection at the first iterator event, or
 * transport failure after earlier events (distinct from semantic refusal),
 * after messages.stream() has returned. The provider's cache clock
 * starts at a request's send.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APIUserAbortError } from '@anthropic-ai/sdk';
import { Membrane } from '../../src/membrane.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { AnthropicXmlFormatter } from '../../src/formatters/anthropic-xml.js';
import { AnthropicAdapter } from '../../src/index.js';
import { lineageKey, type CacheKeepaliveConfig, type KeepaliveDiagnostic, type KeepaliveEvent, type KeepaliveSuppression } from '../../src/cache-keepalive.js';

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
  const events: (KeepaliveEvent | KeepaliveSuppression | KeepaliveDiagnostic)[] = [];
  const a = new AnthropicAdapter({ apiKey: 'sk-test', cacheKeepalive: { ...timing, ...config, onSuppressed: e => { events.push(e); }, onDiagnostic: e => { events.push(e); }, onEvent: e => { events.push(e); } } });
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

    it.each(['refusal', 'end_turn'])('captures a changing terminal accessor once (%s)', async firstReason => {
      let changing = false;
      let reads = 0;
      const terminal = () => changing ? {
        get stop_reason() {
          return ++reads === 1 ? firstReason : firstReason === 'refusal' ? 'end_turn' : 'refusal';
        },
      } : { stop_reason: 'end_turn' };
      const { a, events, replays } = adapter({ suppressOnRefusal: true, lanes: [lane] },
        () => Object.defineProperties({ ...answer }, {
          ...Object.getOwnPropertyDescriptors(terminal()),
          _request_id: { value: 'req-changing', enumerable: false },
        }),
        () => sdkStream([messageStart, { type: 'message_delta', delta: terminal(), usage: readUsage }]));
      const run = () => lane === 'complete' ? a.complete(request('changing-terminal'))
        : a.stream(request('changing-terminal'), noCallbacks);
      await run();
      expect(a.cacheKeepalive!.getStatus()).toHaveLength(1);
      changing = true;
      const response = await run();
      if (lane === 'complete') {
        expect(response.requestId).toBe('req-changing');
        expect((response.raw as any).request_id).toBe('req-changing');
      }
      expect(response.stopReason).toBe(firstReason);
      expect(response.providerStopReason).toBe(firstReason);
      expect((response.raw as any).stop_reason).toBe(firstReason);
      expect(reads).toBe(1);
      expect(events.some(e => e.type === 'suppressed')).toBe(firstReason === 'refusal');
      expect(a.cacheKeepalive!.getStatus()).toHaveLength(firstReason === 'refusal' ? 0 : 1);
      await vi.advanceTimersByTimeAsync(100);
      expect(replays()).toHaveLength(firstReason === 'refusal' ? 0 : 1);
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
      let first = false;
      let reason = 'end_turn';
      const { a } = adapter({ suppressOnRefusal: true, lanes: [lane] },
        () => { if (first) { first = false; return gate.promise; } return { ...answer, stop_reason: reason }; },
        () => { if (first) { first = false; return heldStream(gate.promise, [messageStart, ...rest]); }
          return sdkStream([messageStart, { type: 'message_delta', delta: { stop_reason: reason }, usage: readUsage }]); });
      const run = () => lane === 'complete' ? a.complete(request('race')) : a.stream(request('race'), noCallbacks);
      await run();
      expect(a.cacheKeepalive!.getStatus()).toHaveLength(1);
      first = true;
      const old = run();
      reason = 'refusal';
      await run();
      gate.release(answer);
      await old;
      expect(a.cacheKeepalive!.getStatus()).toHaveLength(0);
    });
  });
}

for (const lane of ['complete', 'stream'] as const) {
  it(`legacy ${lane} resolved refusal continues scheduling by default`, async () => {
    const { a, replays } = adapter({ lanes: [lane] }, () => ({ ...answer, stop_reason: 'refusal' }),
      () => sdkStream([messageStart, { type: 'message_delta', delta: { stop_reason: 'refusal' }, usage: readUsage }]));
    const response = lane === 'complete' ? await a.complete(request('legacy'))
      : await a.stream(request('legacy'), noCallbacks);
    expect(response.stopReason).toBe('refusal');
    expect(a.cacheKeepalive!.getStatus()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(replays()).toHaveLength(1);
  });
}

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

for (const lane of ['complete', 'stream'] as const) {
  for (const reason of ['end_turn', 'refusal']) {
    it(`${lane}: finish failure after mutation stops keepalive without breaking foreground`, async () => {
      let terminal = 'end_turn';
      const { a, replays, events } = adapter({ suppressOnRefusal: true, lanes: [lane] },
        () => ({ ...answer, stop_reason: terminal }),
        () => sdkStream([messageStart, { type: 'message_delta', delta: { stop_reason: terminal }, usage: readUsage }]));
      const run = () => lane === 'complete' ? a.complete(request('safe')) : a.stream(request('safe'), noCallbacks);
      await run(); expect(a.cacheKeepalive!.getStatus()).toHaveLength(1);
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const finish = a.cacheKeepalive!.finish.bind(a.cacheKeepalive!);
      vi.spyOn(a.cacheKeepalive!, 'finish').mockImplementation((...args) => { finish(...args); throw new Error('observer'); });
      terminal = reason;
      expect((await run()).stopReason).toBe(reason);
      expect(a.cacheKeepalive!.getStatus()).toEqual([]);
      expect(events).toContainEqual({ type: 'disabled', reason: 'keepalive finish bookkeeping failed; permanently stopped for this adapter; create a new adapter to restart keepalive' });
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('permanently stopped'));
      terminal = 'end_turn'; await run();
      await vi.advanceTimersByTimeAsync(100);
      expect(a.cacheKeepalive!.getStatus()).toEqual([]);
      expect(replays()).toEqual([]);
    });
  }
}

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
  expect(a.cacheKeepalive!.getStatus()).toHaveLength(1);
  response = { ...answer, stop_reason: 'refusal', usage: undefined };
  expect(await settle(a.complete(request('parse')))).toBeDefined();
  expect(a.cacheKeepalive!.getStatus()).toEqual([]);
});

it('opt-in complete deadline still aborts the SDK and cannot rearm', async () => {
  const { a, client } = adapter({ suppressOnRefusal: true, lanes: ['complete'] }, () => ({ ...answer, stop_reason: 'refusal' }));
  await a.complete(request('deadline'));
  const entry = held();
  let sdkSignal!: AbortSignal;
  client.messages.create.mockImplementation((_wire: any, options: any) => new Promise((_resolve, reject) => {
    sdkSignal = options.signal;
    options.signal.addEventListener('abort', () => reject(new APIUserAbortError()), { once: true });
    entry.release(undefined);
  }));
  const result = settle(a.complete(request('deadline'), { timeoutMs: 20 }));
  await entry.promise;
  expect(client.messages.create).toHaveBeenCalledTimes(2);
  expect(sdkSignal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(20);
  expect(sdkSignal.aborted).toBe(true);
  expect((await result as any).type).toBe('timeout');
  expect(a.cacheKeepalive!.getStatus()).toEqual([]);
  expect(client.messages.create).toHaveBeenCalledTimes(2);
  expect(client.messages.create.mock.calls[1][1].signal).toBe(sdkSignal);
  expect(client.messages.create.mock.calls[1][0]).not.toHaveProperty('keepalivePurpose');
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
      expect(events.some(e => e.type === 'skipped')).toBe(false);
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
  expect(a.cacheKeepalive!.getStatus()).toHaveLength(1);
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
  expect(a.cacheKeepalive!.getStatus()).toHaveLength(1);
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  let suppressedAtPrefix = false;
  const prefix = vi.spyOn(a.cacheKeepalive!, 'prefix').mockImplementation(() => {
    suppressedAtPrefix = events.some(e => e.type === 'suppressed') && a.cacheKeepalive!.getStatus().length === 0;
    throw new Error('prefix');
  });
  reason = 'refusal';
  expect((await a.complete(request('prefix-error'))).stopReason).toBe('refusal');
  expect(prefix).toHaveBeenCalledTimes(1);
  expect(suppressedAtPrefix).toBe(true);
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
      Object.defineProperty(w.system, 'toJSON', { value() {
        if (++serializations === 1) throw new Error('custom serialization');
        return [...original];
      } });
    } });
    expect(result.stopReason).toBe('refusal');
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('keepalive is now permanently stopped for this adapter'));
    expect(events).toEqual([{ type: 'disabled', reason: 'keepalive begin bookkeeping failed; permanently stopped for this adapter; create a new adapter to restart keepalive' }]);
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


it('normal stream qualifies before input-transformation response assembly throws', async () => {
  const { a, replays } = adapter({ suppressOnRefusal: true },
    () => ({ ...answer, stop_reason: 'max_tokens' }),
    () => sdkStream([
      { ...messageStart, message: { ...messageStart.message, input_transformations: [
        { get type() { throw new Error('assembly failed'); } },
      ] } },
      ...rest,
    ]));
  await expect(a.stream(request('assembly-failure'), noCallbacks)).rejects.toThrow('assembly failed');
  expect(a.cacheKeepalive!.getStatus()).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(100);
  expect(replays()).toHaveLength(1);
});

it.each([false, true])('stream keeper honors onRequest replacements (suppression: %s)', async suppressOnRefusal => {
  const { a, client, replays } = adapter({ suppressOnRefusal }, () => answer,
    () => sdkStream([messageStart, ...rest]));
  await a.stream(request('actual'), noCallbacks, {
    onRequest: (wire: any) => {
      wire.system = [{ type: 'text', text: 'observer replacement', cache_control: { type: 'ephemeral', ttl: '1h' } }];
      wire.messages = [{ role: 'user', content: 'redacted' }];
      wire.model = 'observer-model';
    },
  });
  // Observer replacement changes bookkeeping in both modes, not the SDK wire.
  expect(client.messages.stream.mock.calls[0][0].system[0].text).toBe('actual');
  expect(client.messages.stream.mock.calls[0][0].messages[0].content).not.toBe('redacted');
  await vi.advanceTimersByTimeAsync(100);
  expect(replays()).toHaveLength(1);
  expect(replays()[0].model).toBe('observer-model');
  expect(replays()[0].system[0].text).toBe('observer replacement');
  expect(replays()[0].messages).toEqual([{ role: 'user', content: 'redacted' }]);
});

it('stream checks caller abort when combined-signal propagation is blocked', async () => {
  const abort = new AbortController();
  abort.signal.addEventListener('abort', e => e.stopImmediatePropagation());
  const { a } = adapter({ suppressOnRefusal: true }, () => answer,
    () => sdkStream([messageStart, ...rest]));
  await settle(a.stream(request('blocked-abort'), { onChunk: () => abort.abort() } as any,
    { signal: abort.signal, timeoutMs: 1000 }));
  expect(abort.signal.aborted).toBe(true);
  expect(a.cacheKeepalive!.getStatus()).toEqual([]);
});

// The purpose declaration must survive both Membrane streaming implementations.

for (const route of ['complete', 'stream', 'streamYielding'] as const) {
  for (const toolMode of ['native', 'xml'] as const) {
    it(`Membrane ${route}/${toolMode} forwards maintenance without rearming refusal`, async () => {
      let reason = 'end_turn';
      const { a } = adapter({ suppressOnRefusal: true, lanes: ['complete', 'stream'] },
        () => ({ ...answer, stop_reason: reason }),
        () => sdkStream([messageStart, { type: 'message_delta', delta: { stop_reason: reason }, usage: readUsage }]));
      const entry = vi.spyOn(a, route === 'complete' ? 'complete' : 'stream');
      const membrane = new Membrane(a, { formatter: toolMode === 'native' ? new NativeFormatter() : new AnthropicXmlFormatter() });
      const req = {
        messages: [{ participant: 'User', content: [{ type: 'text' as const, text: 'hi' }] }],
        system: 'purpose boundary', config: { model: 'claude-opus-4-1', maxTokens: 1024 },
        promptCaching: true, cacheTtl: '1h' as const, toolMode,
      };
      const run = async (keepalivePurpose?: 'maintenance') => {
        const options = { ...(keepalivePurpose ? { keepalivePurpose } : {}), refusalRetries: 0 };
        if (route === 'complete') await membrane.complete(req, options);
        else if (route === 'stream') await membrane.stream(req, { ...options, onChunk: () => {} });
        else for await (const event of membrane.streamYielding(req, options)) {
          expect(event.type).not.toBe('error');
        }
      };
      await run(); expect(a.cacheKeepalive!.getStatus()).toHaveLength(1);
      reason = 'refusal'; await run(); expect(a.cacheKeepalive!.getStatus()).toEqual([]);
      reason = 'max_tokens'; await run('maintenance');
      const args = entry.mock.calls.at(-1)!;
      expect(args[route === 'complete' ? 1 : 2]).toMatchObject({ keepalivePurpose: 'maintenance' });
      expect(a.cacheKeepalive!.getStatus()).toEqual([]);
      await run(); expect(a.cacheKeepalive!.getStatus()).toHaveLength(1);
    });
  }
}


it.each([false, true])('public adapter reports outcome-cap eviction (existing snapshot: %s)', async qualified => {
  const gates = Array.from({ length: 5 }, () => held());
  let holding = false;
  let next = 0;
  const { a, events, replays } = adapter({ suppressOnRefusal: true, lanes: ['complete'] },
    w => w.max_tokens === 0 ? { ...answer, stop_reason: 'max_tokens' }
      : holding ? gates[next++]!.promise : answer);
  const key = lineageKey({ model: request('key-0').model, system: request('key-0').system });
  if (qualified) {
    await a.complete(request('key-0'));
    expect(a.cacheKeepalive!.getStatus().map(s => s.key)).toEqual([key]);
  }
  holding = true;
  const pending = gates.map((_, i) => a.complete(request(`key-${i}`)));
  expect(next).toBe(5);
  expect(events).toEqual([{
    type: 'diagnostic', key, reason: 'outcome-lru-eviction: maxLineages cap exceeded',
  }]);
  expect(a.cacheKeepalive!.getStatus()).toEqual([]);
  // Both success qualification and refusal observation lose the evicted identity.
  gates.forEach((gate, i) => gate.release({ ...answer, stop_reason: i === 0 ? 'refusal' : 'end_turn' }));
  await Promise.all(pending);
  expect(a.cacheKeepalive!.getStatus()).toHaveLength(4);
  expect(a.cacheKeepalive!.getStatus().some(s => s.key === key)).toBe(false);
  expect(events).toHaveLength(1); // No misleading skipped or suppression event.
  await vi.advanceTimersByTimeAsync(100);
  expect(replays()).toHaveLength(4); // Diagnostic did not disable the keeper.
});


it.each([{}, { suppressOnRefusal: false }])('public adapter default-off cap eviction stays silent (%j)', async config => {
  const { a, events, replays } = adapter({ ...config, lanes: ['complete'] }, () => answer);
  for (let i = 0; i < 5; i++) await a.complete(request(`key-${i}`));
  expect(a.cacheKeepalive!.getStatus()).toHaveLength(4);
  expect(events).toEqual([]);
  await vi.advanceTimersByTimeAsync(100);
  expect(replays()).toHaveLength(4);
});

it.each([undefined, false, true])('side traffic preserves the primary stream (suppression: %s)', async suppressOnRefusal => {
  const { a, events, replays } = adapter({ suppressOnRefusal },
    () => ({ ...answer, stop_reason: 'max_tokens' }),
    () => sdkStream([messageStart, ...rest]));
  await a.stream(request('primary'), noCallbacks);
  const keys = a.cacheKeepalive!.getStatus().map(s => s.key);
  expect(keys).toHaveLength(1);
  for (let i = 0; i < 5; i++) {
    await a.complete(request(`excluded-${i}`));
    const ineligible = request(`ineligible-${i}`);
    ineligible.thinking = { type: 'enabled', budget_tokens: 1024 };
    await a.stream(ineligible, noCallbacks);
  }
  expect(a.cacheKeepalive!.getStatus().map(s => s.key)).toEqual(keys);
  expect(events).toEqual([]);
  await vi.advanceTimersByTimeAsync(100);
  expect(replays()).toHaveLength(1);
  expect(replays()[0].system).toEqual(request('primary').system);
});

it.each(['throw', 'abort'] as const)('buffered local-stop suffix %s happens after adapter qualification', async action => {
  const { a, replays } = adapter({ suppressOnRefusal: true },
    () => ({ ...answer, stop_reason: 'max_tokens' }),
    () => sdkStream([messageStart, ...rest.map(event => event.type === 'content_block_delta'
      ? { ...event, delta: { type: 'text_delta', text: 'ab' } } : event)]));
  const membrane = new Membrane(a, { formatter: new NativeFormatter() });
  const controller = new AbortController();
  const failure = new Error('buffered application callback');
  const chunks: string[] = [];
  const onChunk = vi.fn((chunk: string) => {
    chunks.push(chunk);
    // This fresh identity has already qualified before Membrane releases 'ab'.
    expect(a.cacheKeepalive!.getStatus()).toHaveLength(1);
    if (action === 'throw') throw failure;
    controller.abort(failure);
  });
  expect(a.cacheKeepalive!.getStatus()).toEqual([]);
  const invocation = membrane.stream({
    messages: [{ participant: 'User', content: [{ type: 'text', text: 'hi' }] }],
    system: 'buffered callback boundary', config: { model: 'claude-opus-4-1', maxTokens: 1024 },
    promptCaching: true, cacheTtl: '1h', toolMode: 'native', stopSequences: ['abc'],
  }, { onChunk, signal: controller.signal, refusalRetries: 0 });
  if (action === 'throw') await expect(invocation).rejects.toThrow('buffered application callback');
  else await expect(invocation).resolves.toMatchObject({ stopReason: 'end_turn' });
  expect(onChunk).toHaveBeenCalled();
  expect(chunks.join('')).toBe('ab');
  expect(controller.signal.aborted).toBe(action === 'abort');
  expect(a.cacheKeepalive!.getStatus()).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(100);
  expect(replays()).toHaveLength(1);
});

it.each(['complete', 'stream'] as const)('Membrane %s suppresses refusal before a throwing usage getter', async lane => {
  let refusing = false;
  const usage = vi.fn(() => { throw new Error('unrelated usage getter'); });
  const { a, replays } = adapter({ suppressOnRefusal: true, lanes: [lane] },
    () => refusing ? Object.defineProperty({ ...answer, stop_reason: 'refusal' }, 'usage', { enumerable: true, get: usage }) : answer,
    () => sdkStream([messageStart, refusing
      ? Object.defineProperty({ type: 'message_delta', delta: { stop_reason: 'refusal' } }, 'usage', { enumerable: true, get: usage })
      : rest[3]]));
  const membrane = new Membrane(a, { formatter: new NativeFormatter() });
  const req = {
    messages: [{ participant: 'User', content: [{ type: 'text' as const, text: 'hi' }] }],
    system: 'throwing usage boundary', config: { model: 'claude-opus-4-1', maxTokens: 1024 },
    promptCaching: true, cacheTtl: '1h' as const, toolMode: 'native' as const,
  };
  const run = () => lane === 'complete' ? membrane.complete(req, { refusalRetries: 0 })
    : membrane.stream(req, { onChunk: () => {}, refusalRetries: 0 });
  await run();
  expect(a.cacheKeepalive!.getStatus()).toHaveLength(1);
  refusing = true;
  await expect(run()).rejects.toThrow('unrelated usage getter');
  expect(usage).toHaveBeenCalled();
  expect(a.cacheKeepalive!.getStatus()).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(100);
  expect(replays()).toHaveLength(0);
});

it.each([false, true])('complete raw preserves absent terminal metadata (suppression %s)', async suppressOnRefusal => {
  const { stop_reason, ...missing } = answer;
  const { a } = adapter({ suppressOnRefusal, lanes: ['complete'] }, () => missing);
  const result = await a.complete(request('missing terminal'));
  expect(Object.hasOwn(result.raw as object, 'stop_reason')).toBe(false);
});

for (const lane of ['complete', 'stream'] as const) {
  it.each(['ownKeys', 'getPrototypeOf'] as const)(`Membrane ${lane} suppresses refusal before a throwing %s capture trap`, async trap => {
    let refusing = false;
    let reads = 0;
    const failure = new Error(`terminal ${trap} trap`);
    const terminal = () => new Proxy(lane === 'complete' ? { ...answer, stop_reason: 'refusal' } : { stop_reason: 'refusal' }, {
      get(target, key, receiver) {
        if (key === 'stop_reason') reads++;
        return Reflect.get(target, key, receiver);
      },
      [trap]() { throw failure; },
    });
    const { a, replays, events } = adapter({ suppressOnRefusal: true, lanes: [lane] },
      () => refusing ? terminal() : answer,
      () => sdkStream([messageStart, { type: 'message_delta', delta: refusing ? terminal() : { stop_reason: 'end_turn' }, usage: readUsage }]));
    const membrane = new Membrane(a, { formatter: new NativeFormatter() });
    const req = {
      messages: [{ participant: 'User', content: [{ type: 'text' as const, text: 'hi' }] }],
      system: 'throwing capture trap', config: { model: 'claude-opus-4-1', maxTokens: 1024 },
      promptCaching: true, cacheTtl: '1h' as const, toolMode: 'native' as const,
    };
    const run = () => lane === 'complete' ? membrane.complete(req, { refusalRetries: 0 })
      : membrane.stream(req, { onChunk: () => {}, refusalRetries: 0 });
    await run();
    expect(a.cacheKeepalive!.getStatus()).toHaveLength(1);
    refusing = true;
    await expect(run()).rejects.toThrow(failure.message);
    expect(reads).toBe(1);
    expect(events.filter(e => e.type === 'suppressed')).toEqual([
      expect.objectContaining({ source: 'foreground' }),
    ]);
    expect(a.cacheKeepalive!.getStatus()).toEqual([]);
    await vi.advanceTimersByTimeAsync(300);
    expect(replays()).toEqual([]);
  });
}

it.each(['complete', 'stream'] as const)('Membrane %s reports unknown foreground terminals on fresh and refused keys', async lane => {
  let reason: string | undefined;
  const { a, events, replays } = adapter({ suppressOnRefusal: true, lanes: [lane] },
    () => ({ ...answer, stop_reason: reason }),
    () => sdkStream([messageStart, { type: 'message_delta', delta: { stop_reason: reason }, usage: readUsage }]));
  const membrane = new Membrane(a, { formatter: new NativeFormatter() });
  const req = {
    messages: [{ participant: 'User', content: [{ type: 'text' as const, text: 'hi' }] }],
    system: 'unknown foreground', config: { model: 'claude-opus-4-1', maxTokens: 1024 },
    promptCaching: true, cacheTtl: '1h' as const, toolMode: 'native' as const,
  };
  const run = () => lane === 'complete' ? membrane.complete(req, { refusalRetries: 0 })
    : membrane.stream(req, { onChunk: () => {}, refusalRetries: 0 });
  expect((await run()).stopReason).toBe('end_turn');
  expect(a.cacheKeepalive!.getStatus()).toEqual([]);
  reason = 'refusal'; await run();
  reason = undefined;
  expect((await run()).stopReason).toBe('end_turn');
  expect(a.cacheKeepalive!.getStatus()).toEqual([]);
  expect(events.filter(e => e.type === 'diagnostic')).toEqual([
    expect.objectContaining({ reason: 'unknown-foreground-terminal: completion cannot qualify or rearm keepalive' }),
    expect.objectContaining({ reason: 'unknown-foreground-terminal: completion cannot qualify or rearm keepalive' }),
  ]);
  expect(events.some(e => e.type === 'error')).toBe(false);
  await vi.advanceTimersByTimeAsync(100);
  expect(replays()).toEqual([]);
});

for (const lane of ['complete', 'stream'] as const) {
  it.each(['throw', 'false'] as const)(`${lane}: terminal capture ignores a %s has trap`, async mode => {
    let refusing = false;
    let reads = 0;
    const has = vi.fn(() => {
      if (mode === 'throw') throw new Error('has trap must not run');
      return false;
    });
    const terminal = () => new Proxy(lane === 'complete' ? { ...answer } : {}, {
      has,
      get(target, key, receiver) {
        if (key === 'stop_reason') { reads++; return 'refusal'; }
        return Reflect.get(target, key, receiver);
      },
    });
    const { a, replays, events } = adapter({ suppressOnRefusal: true, lanes: [lane] },
      () => refusing ? terminal() : answer,
      () => sdkStream([messageStart, { type: 'message_delta', delta: refusing ? terminal() : { stop_reason: 'end_turn' }, usage: readUsage }]));
    const run = () => lane === 'complete' ? a.complete(request('has-trap'))
      : a.stream(request('has-trap'), noCallbacks);
    await run();
    expect(a.cacheKeepalive!.getStatus()).toHaveLength(1);
    refusing = true;
    const result = await run();
    expect(result.stopReason).toBe('refusal');
    expect((result.raw as any).stop_reason).toBe('refusal');
    expect(reads).toBe(1);
    expect(has).not.toHaveBeenCalled();
    expect(events.filter(e => e.type === 'suppressed')).toHaveLength(1);
    expect(a.cacheKeepalive!.getStatus()).toEqual([]);
    await vi.advanceTimersByTimeAsync(300);
    expect(replays()).toEqual([]);
  });
}

it('opt-in message_start updates a qualified replay even when the stream later fails', async () => {
  let fail = false;
  const failure = new Error('transport failed after message_start');
  const { a, replays } = adapter({ suppressOnRefusal: true },
    () => ({ ...answer, stop_reason: 'max_tokens' }),
    () => fail ? sdkStream([messageStart], failure) : sdkStream([messageStart, ...rest]));
  await a.stream(request('prefix-observation'), noCallbacks);
  expect(a.cacheKeepalive!.getStatus()).toHaveLength(1);
  fail = true;
  await expect(a.stream(request('prefix-observation', 2), noCallbacks)).rejects.toThrow(failure.message);
  await vi.advanceTimersByTimeAsync(100);
  expect(replays()).toHaveLength(1);
  expect(replays()[0].messages).toHaveLength(2);
  expect(replays()[0].messages[1].content[0].text).toBe('turn 1');
});

it.each(['complete', 'stream'] as const)('%s freezes inherited initially-undefined terminal getters', async lane => {
  let changing = false;
  let reads = 0;
  const terminal = () => {
    const value: any = lane === 'complete' ? { ...answer } : {};
    delete value.stop_reason;
    return Object.setPrototypeOf(value, { get stop_reason() {
      return ++reads === 1 ? undefined : 'refusal';
    } });
  };
  const { a, events, replays } = adapter({ suppressOnRefusal: true, lanes: [lane] },
    () => changing ? terminal() : answer,
    () => sdkStream([messageStart, { type: 'message_delta', delta: changing ? terminal() : { stop_reason: 'end_turn' }, usage: readUsage }]));
  const run = () => lane === 'complete' ? a.complete(request('inherited')) : a.stream(request('inherited'), noCallbacks);
  await run();
  expect(a.cacheKeepalive!.getStatus()).toHaveLength(1);
  changing = true;
  const result = await run();
  expect(reads).toBe(1);
  expect(result.stopReason).not.toBe('refusal');
  expect(events).toContainEqual(expect.objectContaining({ type: 'diagnostic', reason: 'unknown-foreground-terminal: completion cannot qualify or rearm keepalive' }));
  // An unknown terminal keeps an already-qualified identity, but public parsing
  // must agree with bookkeeping rather than inventing a later refusal.
  expect(a.cacheKeepalive!.getStatus()).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(100);
  expect(replays()).toHaveLength(1);
});
