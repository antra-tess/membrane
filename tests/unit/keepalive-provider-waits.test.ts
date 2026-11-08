import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { CacheKeepalive, type CacheKeepaliveConfig, type KeepaliveEvent } from '../../src/cache-keepalive.js';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';

const START = Date.parse('2026-11-08T00:00:00Z');
const timing = { refreshAfterMs: 1_000, checkIntervalMs: 100, maxIdleMs: 1_000_000 };
const hour = { type: 'ephemeral', ttl: '1h' };
const accepted = { usage: { cache_read_input_tokens: 1_000, cache_creation_input_tokens: 0 } };

function wire(model: string, system: string) {
  return {
    model, max_tokens: 1024,
    system: [{ type: 'text', text: system, cache_control: hour }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
  };
}

class Refusal extends Error {
  constructor(readonly retryable: boolean, readonly retryAfterMs?: number) {
    super(retryable ? 'overloaded' : 'refused');
  }
}
const classify = (error: unknown) =>
  error instanceof Refusal ? { retryable: error.retryable, retryAfterMs: error.retryAfterMs } : undefined;

const keepalives: CacheKeepalive[] = [];
function setup(answer: (lineage: string, at: number) => unknown, config: CacheKeepaliveConfig = {}) {
  const pokes: Array<{ lineage: string; at: number }> = [];
  const events: KeepaliveEvent[] = [];
  const ka = new CacheKeepalive(async (w) => {
    const at = Date.now() - START;
    const lineage = `${w.model}/${(w.system as Array<{ text: string }>)[0]!.text}`;
    pokes.push({ lineage, at });
    const result = answer(lineage, at);
    if (result instanceof Error) throw result;
    return result as typeof accepted;
  }, { ...timing, onEvent: (e) => { events.push(e); }, ...config }, classify);
  keepalives.push(ka);
  const holds = () => events.flatMap((e) => e.type === 'held' ? [{ model: e.model, until: e.until - START }] : []);
  return { ka, pokes, events, holds };
}

const adapters: AnthropicAdapter[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(START); });
afterEach(() => {
  for (const ka of keepalives.splice(0)) ka.stop();
  for (const a of adapters.splice(0)) a.cacheKeepalive?.stop();
  vi.useRealTimers();
});

describe('the keepalive and a provider\'s stated wait', () => {
  it.each([true, false])('a wait stated on a refused poke holds every lineage of its model until it passes, and no other model (retryable: %s)', async (retryable) => {
    const { ka, pokes } = setup((lineage, at) => lineage === 'model-a/one' && at === 1_000 ? new Refusal(retryable, 5_000) : accepted);
    ka.record(wire('model-a', 'one'), undefined, 'stream');
    ka.record(wire('model-a', 'two'), undefined, 'stream');
    ka.record(wire('model-b', 'one'), undefined, 'stream');
    await vi.advanceTimersByTimeAsync(5_900);
    expect(pokes.filter((p) => p.lineage.startsWith('model-a'))).toEqual([{ lineage: 'model-a/one', at: 1_000 }]);
    expect(pokes.filter((p) => p.lineage.startsWith('model-b')).map((p) => p.at)).toEqual([1_000, 2_000, 3_000, 4_000, 5_000]);
    await vi.advanceTimersByTimeAsync(100);
    expect(pokes.filter((p) => p.at === 6_000).map((p) => p.lineage)).toEqual(['model-a/one', 'model-a/two', 'model-b/one']);
  });

  it('a poke refused as retryable keeps its lineage\'s age, so it is poked again as soon as its hold passes', async () => {
    const { ka, pokes, holds } = setup((_lineage, at) => at === 1_000 ? new Refusal(true) : accepted);
    ka.record(wire('model-a', 'one'), undefined, 'stream');
    await vi.advanceTimersByTimeAsync(1_100);
    expect(holds()).toEqual([{ model: 'model-a', until: 1_100 }]);
    expect(pokes.map((p) => p.at)).toEqual([1_000, 1_100]);
  });

  it.each([3, 0])('each retryable refusal in a run doubles the hold, from checkIntervalMs up to refreshAfterMs (maxConsecutiveErrors: %s)', async (maxConsecutiveErrors) => {
    const { ka, pokes, events, holds } = setup(() => new Refusal(true), { maxConsecutiveErrors });
    ka.record(wire('model-a', 'one'), undefined, 'stream');
    await vi.advanceTimersByTimeAsync(4_500);
    expect(pokes.map((p) => p.at)).toEqual([1_000, 1_100, 1_300, 1_700, 2_500, 3_500, 4_500]);
    expect(holds().map((h) => h.until)).toEqual([1_100, 1_300, 1_700, 2_500, 3_500, 4_500, 5_500]);
    expect(events.filter((e) => e.type === 'disabled')).toEqual([]);
  });

  it('an accepted poke ends its model\'s run of refusals', async () => {
    const { ka, pokes, holds } = setup((lineage, at) => lineage === 'model-a/one' && at === 1_100 ? accepted : new Refusal(true));
    ka.record(wire('model-a', 'one'), undefined, 'stream');
    ka.record(wire('model-a', 'two'), undefined, 'stream');
    await vi.advanceTimersByTimeAsync(1_100);
    expect(pokes).toEqual([
      { lineage: 'model-a/one', at: 1_000 },
      { lineage: 'model-a/one', at: 1_100 },
      { lineage: 'model-a/two', at: 1_100 },
    ]);
    expect(holds().map((h) => h.until)).toEqual([1_100, 1_200]);
  });

  it('a retryable refusal long after the end of its run\'s last hold starts a new run', async () => {
    const { ka, pokes, holds } = setup(() => new Refusal(true));
    ka.record(wire('model-a', 'one'), undefined, 'stream');
    await vi.advanceTimersByTimeAsync(1_050);
    ka.record(wire('model-a', 'one'), undefined, 'stream');
    await vi.advanceTimersByTimeAsync(1_050);
    expect(pokes.map((p) => p.at)).toEqual([1_000, 2_100]);
    expect(holds().map((h) => h.until)).toEqual([1_100, 2_200]);
  });

  it('a refusal that is slow to come back carries its run on, so the backoff still doubles', async () => {
    const { ka, pokes, holds } = setup(() => new Promise((_resolve, reject) => { setTimeout(() => reject(new Refusal(true)), 250); }));
    ka.record(wire('model-a', 'one'), undefined, 'stream');
    await vi.advanceTimersByTimeAsync(2_900);
    expect(pokes.map((p) => p.at)).toEqual([1_000, 1_400, 1_900, 2_600]);
    expect(holds().map((h) => h.until)).toEqual([1_350, 1_850, 2_550, 3_650]);
  });

  it('a hold from a foreground wait carries the run on, so the next refusal doubles the backoff', async () => {
    const { ka, pokes, holds } = setup(() => new Refusal(true));
    ka.record(wire('model-a', 'one'), undefined, 'stream');
    await vi.advanceTimersByTimeAsync(1_050);
    ka.holdModel('model-a', 4_950, 'foreground');
    await vi.advanceTimersByTimeAsync(4_950);
    expect(pokes.map((p) => p.at)).toEqual([1_000, 6_000]);
    expect(holds().map((h) => h.until)).toEqual([1_100, 6_000, 6_200]);
  });

  it('a hold set long after a run of refusals ended doesn\'t carry that run on', async () => {
    const { ka, pokes, holds } = setup(() => new Refusal(true));
    ka.record(wire('model-a', 'one'), undefined, 'stream');
    await vi.advanceTimersByTimeAsync(1_050);
    ka.record(wire('model-a', 'one'), undefined, 'stream');
    await vi.advanceTimersByTimeAsync(950);
    ka.holdModel('model-a', 1_000, 'foreground');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pokes.map((p) => p.at)).toEqual([1_000, 3_000]);
    expect(holds().map((h) => h.until)).toEqual([1_100, 3_000, 3_100]);
  });

  it('a classifier that throws leaves the failure counted, as with none', async () => {
    const events: KeepaliveEvent[] = [];
    const ka = new CacheKeepalive(async () => { throw new Refusal(true); }, { ...timing, onEvent: (e) => { events.push(e); } }, () => {
      throw new Error('classifier broke');
    });
    keepalives.push(ka);
    ka.record(wire('model-a', 'one'), undefined, 'stream');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(events).toEqual([{ type: 'error', key: expect.any(String), error: 'overloaded', consecutive: 1 }]);
  });

  it('a retryable refusal neither counts toward maxConsecutiveErrors nor resets the count, and other failures still stop the keepalive', async () => {
    let n = 0;
    const { ka, pokes, events } = setup(() => (++n === 2 ? new Refusal(true) : new Refusal(false)));
    ka.record(wire('model-a', 'one'), undefined, 'stream');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(pokes.map((p) => p.at)).toEqual([1_000, 2_000, 2_100, 3_100]);
    expect(events.flatMap((e) => e.type === 'error' ? [e.consecutive] : [])).toEqual([1, 1, 2, 3]);
    expect(events.filter((e) => e.type === 'disabled')).toHaveLength(1);
  });

  it('a retryable refusal whose hold comes to 0 counts, so the keepalive still stops', async () => {
    const { ka, pokes, events, holds } = setup(() => new Refusal(true), { refreshAfterMs: 0 });
    ka.record(wire('model-a', 'one'), undefined, 'stream');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(holds()).toEqual([]);
    expect(pokes).toHaveLength(3);
    expect(events.flatMap((e) => e.type === 'error' ? [e.consecutive] : [])).toEqual([1, 2, 3]);
    expect(events.at(-1)?.type).toBe('disabled');
  });

  it('a hold is announced when it begins or grows, and a later, shorter wait doesn\'t shorten it', async () => {
    const { ka, pokes, holds } = setup(() => accepted);
    ka.record(wire('model-a', 'one'), undefined, 'stream');
    ka.holdModel('model-a', 5_000, 'first');
    ka.holdModel('model-a', 1_000, 'shorter');
    await vi.advanceTimersByTimeAsync(3_000);
    ka.holdModel('model-a', 4_000, 'longer');
    await vi.advanceTimersByTimeAsync(4_000);
    expect(holds()).toEqual([{ model: 'model-a', until: 5_000 }, { model: 'model-a', until: 7_000 }]);
    expect(pokes.map((p) => p.at)).toEqual([7_000]);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, undefined])('a wait of %s holds nothing', async (wait) => {
    const { ka, pokes, events } = setup(() => accepted);
    ka.record(wire('model-a', 'one'), undefined, 'stream');
    ka.holdModel('model-a', wait, 'no wait');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(events.filter((e) => e.type === 'held')).toEqual([]);
    expect(pokes.map((p) => p.at)).toEqual([1_000]);
  });

  it('an option given as undefined takes its default', async () => {
    const send = vi.fn(async () => { throw new Refusal(true); });
    const events: KeepaliveEvent[] = [];
    const ka = new CacheKeepalive(send, {
      enabled: undefined, refreshAfterMs: undefined, checkIntervalMs: undefined, onEvent: (e) => { events.push(e); },
    }, classify);
    keepalives.push(ka);
    ka.record(wire('model-a', 'one'), undefined, 'stream');
    await vi.advanceTimersByTimeAsync(45 * 60_000 - 1);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(events.flatMap((e) => e.type === 'held' ? [e.until - START] : [])).toEqual([50 * 60_000]);
  });
});

describe('the Anthropic adapter feeds its keepalive the waits its calls are given', () => {
  const request = {
    model: 'claude-sonnet-4-5', maxTokens: 1024,
    system: [{ type: 'text', text: 'Resident system', cache_control: hour }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello', cache_control: hour }] }],
  } as any;
  const answer = {
    id: 'msg', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 0 },
  };
  const rateLimited = (headers: Record<string, string>) => new Anthropic.RateLimitError(
    429, { type: 'error', error: { type: 'rate_limit_error', message: 'Slow down' } }, 'Slow down', new Headers(headers),
  );

  it.each([
    ['complete', { 'retry-after': '5' }],
    ['stream', { 'retry-after': '5' }],
    ['complete', { 'retry-after': '5', 'x-should-retry': 'false' }],
  ] as const)('a wait stated on a failed %s call holds its model\'s pokes until it passes (%o)', async (lane, headers) => {
    const adapter = new AnthropicAdapter({ apiKey: 'sk-test', cacheKeepalive: { ...timing, lanes: ['complete', 'stream'] } });
    adapters.push(adapter);
    let fail = false;
    const pokes: number[] = [];
    const client: any = {
      messages: {
        create: vi.fn(async (wire: any) => {
          if (wire.max_tokens === 0) {
            pokes.push(Date.now() - START);
            return { ...answer, content: [], stop_reason: 'max_tokens' };
          }
          if (fail) throw rateLimited(headers);
          return answer;
        }),
        stream: vi.fn(async () => { throw rateLimited(headers); }),
      },
    };
    client.withOptions = () => client;
    (adapter as any).client = client;
    await adapter.complete(request);
    await vi.advanceTimersByTimeAsync(500);
    fail = true;
    const call = lane === 'complete' ? adapter.complete(request) : adapter.stream(request, { onChunk: () => {} } as any);
    await expect(call).rejects.toMatchObject({ retryAfterMs: 5_000 });
    await vi.advanceTimersByTimeAsync(4_900);
    expect(pokes).toEqual([]);
    await vi.advanceTimersByTimeAsync(100);
    expect(pokes).toEqual([5_500]);
  });
});
