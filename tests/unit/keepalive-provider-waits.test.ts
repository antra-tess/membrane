import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheKeepalive, type CacheKeepaliveConfig, type KeepaliveEvent, type KeepaliveFailureClassification } from '../../src/cache-keepalive.js';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';

// A provider's stated wait binds background traffic too. The keepalive is
// autonomous: it replays recorded requests on its own timer, so a caller that
// honours a "retry after N" for its own calls (agent-framework's provider
// waits) cannot stop a poke. The keepalive therefore holds every lineage of a
// model while any call to that model has a stated wait outstanding.
// (room-225 #46648, #46976, #47170, #47195, #47272.)

const START = Date.parse('2026-10-07T00:00:00Z');
const MIN = 60_000;
const hit = { usage: { cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } };

function wire(model = 'claude-sonnet-4-5', system = 'Resident system'): Record<string, unknown> {
  return {
    model, max_tokens: 1024, stream: true,
    thinking: { type: 'adaptive' },
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral', ttl: '1h' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
  };
}

/** A failure the way the adapter classifies one. */
class Classified extends Error {
  constructor(message: string, readonly retryable: boolean, readonly retryAfterMs?: number) { super(message); }
}
const classify = (error: unknown): KeepaliveFailureClassification | undefined =>
  error instanceof Classified ? { retryable: error.retryable, retryAfterMs: error.retryAfterMs } : undefined;

const keepalives: CacheKeepalive[] = [];
function setup(send: (...args: any[]) => Promise<unknown>, config: CacheKeepaliveConfig = {}) {
  const events: KeepaliveEvent[] = [];
  const ka = new CacheKeepalive(send as never, {
    refreshAfterMs: 45 * MIN, checkIntervalMs: 5 * MIN, maxIdleMs: 7 * 24 * 60 * MIN,
    onEvent: (event) => events.push(event),
    ...config,
  }, classify);
  keepalives.push(ka);
  return { ka, events };
}
const sentModels = (send: ReturnType<typeof vi.fn>) => send.mock.calls.map((call) => (call[0] as { model: string }).model);

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(START); });
afterEach(() => {
  for (const ka of keepalives.splice(0)) ka.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('keepalive model holds', () => {
  it('a stated wait holds every lineage of that model, not just the one that failed; other models refresh', async () => {
    const send = vi.fn().mockResolvedValue(hit);
    const { ka, events } = setup(send);
    ka.record(wire('claude-a', 'one'), undefined, 'stream');
    ka.record(wire('claude-a', 'two'), undefined, 'stream');
    ka.record(wire('claude-b'), undefined, 'stream');
    ka.holdModel('claude-a', 120 * MIN, 'zz 429');
    expect(events.filter((e) => e.type === 'held')).toEqual([{ type: 'held', model: 'claude-a', until: START + 120 * MIN, reason: 'zz 429' }]);

    await vi.advanceTimersByTimeAsync(115 * MIN);
    expect(new Set(sentModels(send))).toEqual(new Set(['claude-b']));
    expect(events.some((e) => e.type === 'error' || e.type === 'disabled')).toBe(false);

    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(sentModels(send).filter((m) => m === 'claude-a')).toHaveLength(2);
  });

  it('holds reduce by maximum: a later, shorter wait never shortens one', async () => {
    const send = vi.fn().mockResolvedValue(hit);
    const { ka, events } = setup(send);
    ka.record(wire(), undefined, 'stream');
    ka.holdModel('claude-sonnet-4-5', 120 * MIN, 'long');
    ka.holdModel('claude-sonnet-4-5', 10 * MIN, 'short');
    expect(events.filter((e) => e.type === 'held')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(115 * MIN);
    expect(send).not.toHaveBeenCalled();
  });

  it('a wait that cannot be held as an instant holds until stop(); a value that is not a wait holds nothing', async () => {
    const send = vi.fn().mockResolvedValue(hit);
    const { ka, events } = setup(send);
    ka.record(wire('claude-a'), undefined, 'stream');
    ka.record(wire('claude-b'), undefined, 'stream');
    ka.record(wire('claude-c'), undefined, 'stream');
    ka.holdModel('claude-a', 1e20, 'past the last Date instant');
    ka.holdModel('claude-b', Number.POSITIVE_INFINITY, 'unbounded');
    for (const notAWait of [Number.NaN, -1, '60', undefined]) ka.holdModel('claude-c', notAWait, 'not a wait');
    expect(events.filter((e) => e.type === 'held').map((e) => [(e as { model: string }).model, (e as { until: number | null }).until]))
      .toEqual([['claude-a', null], ['claude-b', null]]);
    await vi.advanceTimersByTimeAsync(3 * 24 * 60 * MIN);
    expect(new Set(sentModels(send))).toEqual(new Set(['claude-c']));
  });

  it('a poke refused as retryable with a stated wait holds the model and is exempt from the breaker; the count it found is kept, not reset', async () => {
    const outcomes: Array<() => Promise<unknown>> = [
      () => Promise.reject(new Error('zz plain failure')),                       // counts: 1
      () => Promise.reject(new Classified('zz 429', true, 60 * MIN)),           // paced: stays 1
      () => Promise.reject(new Error('zz plain failure')),                       // counts: 2
      () => Promise.reject(new Error('zz plain failure')),                       // counts: 3 → disabled
    ];
    const send = vi.fn(() => (outcomes.shift() ?? (() => Promise.resolve(hit)))());
    const { ka, events } = setup(send, { maxConsecutiveErrors: 3 });
    ka.record(wire(), undefined, 'stream');
    await vi.advanceTimersByTimeAsync(24 * 60 * MIN);
    const errors = events.filter((e) => e.type === 'error') as Array<{ consecutive: number }>;
    expect(errors.map((e) => e.consecutive)).toEqual([1, 1, 2, 3]);
    expect(events.filter((e) => e.type === 'held')).toHaveLength(1);
    expect(events.some((e) => e.type === 'disabled')).toBe(true);
    expect(send).toHaveBeenCalledTimes(4);
  });

  it('a retryable refusal whose hint states no wait (negative, NaN) holds nothing and counts toward the breaker (#48365)', async () => {
    for (const hint of [-1, Number.NaN]) {
      const send = vi.fn(() => Promise.reject(new Classified('zz 429 with an unusable hint', true, hint)));
      const { ka, events } = setup(send, { maxConsecutiveErrors: 1 });
      ka.record(wire(), undefined, 'stream');
      await vi.advanceTimersByTimeAsync(6 * 60 * MIN);
      expect(send, String(hint)).toHaveBeenCalledTimes(1);
      expect(events.some((e) => e.type === 'held'), String(hint)).toBe(false);
      expect(events.some((e) => e.type === 'disabled'), String(hint)).toBe(true);
      ka.stop();
    }
  });

  it('a poke refused as NOT retryable still counts toward the breaker, whatever wait it states; the wait still holds the model', async () => {
    const send = vi.fn(() => Promise.reject(new Classified('zz 400 with a hint', false, 50 * MIN)));
    const { ka, events } = setup(send, { maxConsecutiveErrors: 3 });
    ka.record(wire(), undefined, 'stream');
    await vi.advanceTimersByTimeAsync(24 * 60 * MIN);
    expect((events.filter((e) => e.type === 'error') as Array<{ consecutive: number }>).map((e) => e.consecutive)).toEqual([1, 2, 3]);
    expect(events.some((e) => e.type === 'disabled')).toBe(true);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("another lineage of the same model already due in the same tick is skipped once a poke receives the wait", async () => {
    const send = vi.fn((payload: Record<string, unknown>) =>
      (payload.system as Array<{ text: string }>)[0]!.text === 'one'
        ? Promise.reject(new Classified('zz 429', true, 30 * MIN))
        : Promise.resolve(hit));
    const { ka } = setup(send);
    ka.record(wire('claude-a', 'one'), undefined, 'stream');
    ka.record(wire('claude-a', 'two'), undefined, 'stream');
    await vi.advanceTimersByTimeAsync(45 * MIN);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('the Anthropic adapter holds its keepalive on stated waits', () => {
  const ok = {
    id: 'response', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5',
    content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 },
  };
  const rateLimitedWith = (headers: Record<string, string>) => new Response(
    JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'zz slow down' } }),
    { status: 429, headers: { 'content-type': 'application/json', ...headers } },
  );
  const rateLimited = (retryAfterSeconds: string) => rateLimitedWith({ 'retry-after': retryAfterSeconds });
  const pokeAnswered = () => new Response(JSON.stringify({ ...ok, content: [], stop_reason: 'max_tokens' }), { headers: { 'content-type': 'application/json' } });
  const request = { model: 'claude-sonnet-4-5', maxTokens: 1024, system: wire().system, messages: wire().messages, extra: { thinking: { type: 'adaptive' } } } as never;

  function adapter(respond: (body: Record<string, unknown>) => Response, events: KeepaliveEvent[], lanes: CacheKeepaliveConfig['lanes'] = ['complete']) {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init: { body: string }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      bodies.push(body);
      return respond(body);
    }));
    const a = new AnthropicAdapter({
      apiKey: 'test-key',
      cacheKeepalive: { lanes, refreshAfterMs: 45 * MIN, checkIntervalMs: 5 * MIN, maxIdleMs: 24 * 60 * MIN, onEvent: (e) => events.push(e) },
    });
    keepalives.push(a.cacheKeepalive!);
    return { a, bodies };
  }

  it("a foreground call's stated wait holds the model's pokes until it passes", async () => {
    const events: KeepaliveEvent[] = [];
    let foreground = 0;
    const { a, bodies } = adapter((body) => {
      if (body.max_tokens === 0) return new Response(JSON.stringify({ ...ok, content: [], stop_reason: 'max_tokens' }), { headers: { 'content-type': 'application/json' } });
      foreground++;
      return foreground === 1 ? new Response(JSON.stringify(ok), { headers: { 'content-type': 'application/json' } }) : rateLimited('7200');
    }, events);
    await a.complete(request);                        // recorded: a lineage exists
    await expect(a.complete(request)).rejects.toMatchObject({ type: 'rate_limit', retryAfterMs: 7_200_000 });
    expect(events.filter((e) => e.type === 'held')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(115 * MIN);
    expect(bodies.filter((b) => b.max_tokens === 0)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(bodies.filter((b) => b.max_tokens === 0)).toHaveLength(1);
  });

  it("its own refused pokes with a stated wait never trip the breaker", async () => {
    const events: KeepaliveEvent[] = [];
    const { a, bodies } = adapter((body) => (body.max_tokens === 0
      ? rateLimited('600')
      : new Response(JSON.stringify(ok), { headers: { 'content-type': 'application/json' } })), events);
    await a.complete(request);
    await vi.advanceTimersByTimeAsync(12 * 60 * MIN);
    const pokes = bodies.filter((b) => b.max_tokens === 0).length;
    expect(pokes).toBeGreaterThan(3);
    expect(events.some((e) => e.type === 'disabled')).toBe(false);
    expect(new Set((events.filter((e) => e.type === 'error') as Array<{ consecutive: number }>).map((e) => e.consecutive))).toEqual(new Set([0]));
  });

  it("a foreground wait stated only in retry-after-ms holds the model's pokes, from complete() and from stream()", async () => {
    for (const lane of ['complete', 'stream'] as const) {
      const events: KeepaliveEvent[] = [];
      const { a, bodies } = adapter((body) => (body.max_tokens === 0 ? pokeAnswered() : rateLimitedWith({ 'retry-after-ms': '7200000' })), events, [lane]);
      const call = lane === 'complete' ? a.complete(request) : a.stream(request, { onChunk: () => {} });
      await expect(call, lane).rejects.toMatchObject({ type: 'rate_limit', retryAfterMs: 7_200_000 });
      expect(events.filter((e) => e.type === 'held'), lane).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(115 * MIN);
      expect(bodies.filter((b) => b.max_tokens === 0), lane).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(10 * MIN);
      expect(bodies.filter((b) => b.max_tokens === 0), lane).toHaveLength(1);
      a.cacheKeepalive!.stop();
    }
  });

  it("its own refused pokes with a wait stated only in retry-after-ms never trip the breaker", async () => {
    const events: KeepaliveEvent[] = [];
    const { a, bodies } = adapter((body) => (body.max_tokens === 0
      ? rateLimitedWith({ 'retry-after-ms': '600000' })
      : new Response(JSON.stringify(ok), { headers: { 'content-type': 'application/json' } })), events);
    await a.complete(request);
    await vi.advanceTimersByTimeAsync(12 * 60 * MIN);
    expect(bodies.filter((b) => b.max_tokens === 0).length).toBeGreaterThan(3);
    expect(events.filter((e) => e.type === 'held').length).toBeGreaterThan(3);
    expect(events.some((e) => e.type === 'disabled')).toBe(false);
  });
});
