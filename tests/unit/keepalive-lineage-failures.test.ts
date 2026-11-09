import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CacheKeepalive,
  lineageKey,
  type CacheKeepaliveConfig,
  type KeepaliveCall,
  type KeepaliveEvent,
} from '../../src/cache-keepalive.js';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { MembraneError } from '../../src/types/index.js';

const START = Date.parse('2026-11-09T00:00:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;

const hit = { usage: { cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } };
const miss = { usage: { cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };

function wire(model = 'claude-m', system = 'Resident system'): Record<string, unknown> {
  return {
    model, max_tokens: 1024, stream: true,
    thinking: { type: 'adaptive' },
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral', ttl: '1h' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
  };
}

function failure(retryAfterMs?: number, retryable = true): MembraneError {
  return new MembraneError({
    type: retryable ? 'rate_limit' : 'invalid_request',
    message: retryable ? 'Rate limited' : 'Bad request',
    retryable,
    retryAfterMs,
    httpStatus: retryable ? 429 : 400,
    rawError: undefined,
  });
}

type Sent = { at: number; model: string; system: string };
const systemOf = (payload: Record<string, unknown>) => (payload.system as Array<{ text: string }>)[0]!.text;

const keepalives: CacheKeepalive[] = [];
function setup(
  respond: (payload: Record<string, unknown>) => unknown,
  config: CacheKeepaliveConfig = {},
  observe?: (event: KeepaliveEvent, ka: CacheKeepalive) => void,
) {
  const sent: Sent[] = [];
  const events: KeepaliveEvent[] = [];
  const send = async (payload: Record<string, unknown>) => {
    sent.push({ at: Date.now() - START, model: String(payload.model), system: systemOf(payload) });
    return (await respond(payload)) as { usage?: Record<string, number> };
  };
  const ka: CacheKeepalive = new CacheKeepalive(send, {
    maxIdleMs: 24 * HOUR,
    onEvent: (event) => { events.push(event); observe?.(event, ka); },
    ...config,
  });
  keepalives.push(ka);
  return { ka, sent, events };
}

/** One lineage's events, as `error N` or `TYPE REASON`. */
function trail(events: KeepaliveEvent[], wireOf: Record<string, unknown>): string[] {
  const key = lineageKey(wireOf);
  return events
    .filter((event) => 'key' in event && event.key === key)
    .map((event) => event.type === 'error' ? `error ${event.consecutive}`
      : event.type === 'skipped' || event.type === 'ineffective' ? `${event.type} ${event.reason}` : event.type);
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(START); });
afterEach(() => {
  for (const ka of keepalives.splice(0)) ka.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('keepalive failures retire only their own lineage', () => {
  it.each([['no wait', undefined], ['a 1 ms wait', 1]] as const)(
    'with refreshAfterMs 0 and checkIntervalMs 1, retryable failures with %s retire their lineage at maxConsecutiveErrors while a healthy lineage keeps refreshing, and a new record of it is kept warm',
    async (_label, wait) => {
      let aFails = true;
      const a = wire('claude-a');
      const b = wire('claude-b');
      const { ka, sent, events } = setup((payload) => {
        if (payload.model === 'claude-a' && aFails) throw failure(wait);
        return hit;
      }, { refreshAfterMs: 0, checkIntervalMs: 1, maxConsecutiveErrors: 3 });
      ka.record(a, undefined, 'stream');
      ka.record(b, undefined, 'stream');
      await vi.advanceTimersByTimeAsync(50);

      expect(sent.filter((s) => s.model === 'claude-a')).toHaveLength(3);
      expect(trail(events, a)).toEqual(['error 1', 'error 2', 'error 3', 'skipped failure-cap']);
      expect(events.some((event) => event.type === 'disabled')).toBe(false);
      expect(ka.getStatus().map((s) => s.key)).toEqual([lineageKey(b)]);
      expect(sent.filter((s) => s.model === 'claude-b').length).toBeGreaterThan(10);

      aFails = false;
      ka.record(a, undefined, 'stream');
      await vi.advanceTimersByTimeAsync(5);
      expect(trail(events, a)).toContain('refreshed');
    },
  );

  it('counts every failure, retryable or not and with or without a wait, on one count that any successful response resets', async () => {
    const answers: Array<() => unknown> = [
      () => { throw failure(undefined, true); },
      () => { throw failure(undefined, false); },
      () => miss,
      () => { throw failure(1, true); },
      () => { throw failure(undefined, false); },
      () => { throw failure(undefined, true); },
    ];
    const a = wire();
    const { ka, sent, events } = setup(() => {
      const next = answers.shift();
      if (!next) throw new Error('no further poke expected');
      return next();
    }, { refreshAfterMs: 0, checkIntervalMs: 1, maxConsecutiveErrors: 3, maxIneffective: 2 });
    ka.record(a, undefined, 'stream');
    await vi.advanceTimersByTimeAsync(50);

    expect(sent).toHaveLength(6);
    expect(trail(events, a)).toEqual([
      'error 1', 'error 2', 'ineffective no-cache-read', 'error 1', 'error 2', 'error 3', 'skipped failure-cap',
    ]);
    expect(ka.getStatus()).toEqual([]);
  });

  it('a failed poke leaves the clocks alone, so a read at the next tick refreshes the entry before the cap', async () => {
    const answers: Array<() => unknown> = [() => { throw failure(); }, () => hit, () => hit];
    const a = wire();
    const { ka, sent, events } = setup(() => answers.shift()!(), {
      refreshAfterMs: 45 * MIN, checkIntervalMs: 5 * MIN, maxConsecutiveErrors: 3,
    });
    ka.record(a, undefined, 'stream');
    await vi.advanceTimersByTimeAsync(100 * MIN);

    expect(sent.map((s) => s.at)).toEqual([45 * MIN, 50 * MIN, 95 * MIN]);
    expect(trail(events, a)).toEqual(['error 1', 'refreshed', 'refreshed']);
  });
});

describe("a provider's stated wait holds the model's optional pokes", () => {
  it('holds every lineage of the failed poke\'s model, new and re-recorded ones too, until the wait ends, while another model goes on', async () => {
    let a1Failed = false;
    const a1 = wire('claude-m', 'A1');
    const a2 = wire('claude-m', 'A2');
    const b = wire('claude-n', 'B');
    const d = wire('claude-m', 'D');
    const { ka, sent } = setup((payload) => {
      if (systemOf(payload) === 'A1' && !a1Failed) {
        a1Failed = true;
        throw failure(15 * MIN);
      }
      return hit;
    }, { refreshAfterMs: 10 * MIN, checkIntervalMs: MIN, maxConsecutiveErrors: 3 });
    ka.record(a1, undefined, 'stream');
    ka.record(a2, undefined, 'stream');
    ka.record(b, undefined, 'stream');
    await vi.advanceTimersByTimeAsync(12 * MIN);
    ka.record(a2, undefined, 'stream');
    await vi.advanceTimersByTimeAsync(3 * MIN);
    ka.record(d, undefined, 'stream');
    await vi.advanceTimersByTimeAsync(10 * MIN);

    expect(sent.map((s) => `${s.at / MIN} ${s.system}`)).toEqual([
      '10 A1', '10 B', '20 B', '25 A1', '25 A2', '25 D',
    ]);
  });

  it.each([
    ["holds the model for the retryAfterMs a plain error from a host's own sender states", 15 * MIN, 25 * MIN],
    ['holds nothing for a retryAfterMs that is a string', String(15 * MIN), 10 * MIN],
  ] as const)('%s', async (_title, retryAfterMs, a2At) => {
    let a1Failed = false;
    const a1 = wire('claude-m', 'A1');
    const a2 = wire('claude-m', 'A2');
    const { ka, sent } = setup((payload) => {
      if (systemOf(payload) === 'A1' && !a1Failed) {
        a1Failed = true;
        throw Object.assign(new Error('Busy'), { retryAfterMs });
      }
      return hit;
    }, { refreshAfterMs: 10 * MIN, checkIntervalMs: MIN, maxConsecutiveErrors: 3 });
    ka.record(a1, undefined, 'stream');
    ka.record(a2, undefined, 'stream');
    await vi.advanceTimersByTimeAsync(25 * MIN);

    expect(sent.find((s) => s.system === 'A2')?.at).toBe(a2At);
  });

  it('retires a held lineage whose cache would expire before the wait ends, rather than send it cold', async () => {
    let a1Failed = false;
    const a1 = wire('claude-m', 'A1');
    const a2 = wire('claude-m', 'A2');
    const { ka, sent, events } = setup((payload) => {
      if (systemOf(payload) === 'A1' && !a1Failed) {
        a1Failed = true;
        throw failure(40 * MIN);
      }
      return hit;
    }, { refreshAfterMs: 30 * MIN, checkIntervalMs: 5 * MIN, maxConsecutiveErrors: 3 });
    ka.record(a1, undefined, 'stream');
    await vi.advanceTimersByTimeAsync(20 * MIN);
    ka.record(a2, undefined, 'stream');
    await vi.advanceTimersByTimeAsync(55 * MIN);

    expect(sent.map((s) => `${s.at / MIN} ${s.system}`)).toEqual(['30 A1', '70 A2']);
    expect(trail(events, a1)).toEqual(['error 1', 'skipped wait-past-expiry']);
  });
});

describe('the confirmed-warm fence', () => {
  it('sends a poke that starts a millisecond short of an hour after the last confirmed read', async () => {
    const { ka, sent } = setup(() => hit, { refreshAfterMs: HOUR - 1, checkIntervalMs: HOUR - 1 });
    ka.record(wire(), undefined, 'stream');
    await vi.advanceTimersByTimeAsync(HOUR - 1);
    expect(sent.map((s) => s.at)).toEqual([HOUR - 1]);
  });

  it('retires a lineage instead of sending it once its last confirmed read is a full hour old', async () => {
    const a = wire();
    const { ka, sent, events } = setup(() => hit, { refreshAfterMs: HOUR, checkIntervalMs: HOUR });
    ka.record(a, undefined, 'stream');
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(sent).toEqual([]);
    expect(trail(events, a)).toEqual(['skipped cache-expired']);
    expect(ka.getStatus()).toEqual([]);
  });

  it('an ineffective poke moves the eligibility clock as before but not the confirmed-warm one, which a read moves', async () => {
    const a = wire('claude-a');
    const b = wire('claude-b');
    const { ka, sent, events } = setup((payload) => payload.model === 'claude-a' ? miss : hit, {
      refreshAfterMs: 50 * MIN, checkIntervalMs: 5 * MIN, maxIneffective: 5,
    });
    ka.record(a, undefined, 'stream');
    ka.record(b, undefined, 'stream');
    await vi.advanceTimersByTimeAsync(100 * MIN);

    expect(sent.map((s) => `${s.at / MIN} ${s.model}`)).toEqual(['50 claude-a', '50 claude-b', '100 claude-b']);
    expect(trail(events, a)).toEqual(['ineffective no-cache-read', 'skipped cache-expired']);
  });

  it('checks the fence against the time of each send, not the start of a delayed tick', async () => {
    const a = wire('claude-a');
    const b = wire('claude-b');
    const { ka, sent, events } = setup(async (payload) => {
      if (payload.model === 'claude-a') await new Promise((resolve) => setTimeout(resolve, 6 * MIN));
      return hit;
    }, { refreshAfterMs: 55 * MIN, checkIntervalMs: 55 * MIN });
    ka.record(a, undefined, 'stream');
    ka.record(b, undefined, 'stream');
    await vi.advanceTimersByTimeAsync(62 * MIN);

    expect(sent.map((s) => `${s.at / MIN} ${s.model}`)).toEqual(['55 claude-a']);
    expect(trail(events, b)).toEqual(['skipped cache-expired']);
  });
});

describe('completions that arrive after the lineage moved on', () => {
  it("a poke that fails after a newer record of its lineage leaves the newer one's count alone, while its stated wait still holds the model", async () => {
    let rejectFirst: ((error: unknown) => void) | undefined;
    const a = wire('claude-m', 'A');
    const b = wire('claude-m', 'B');
    const { ka, sent, events } = setup((payload) => {
      if (systemOf(payload) === 'A' && !rejectFirst) {
        return new Promise((_resolve, reject) => { rejectFirst = reject; });
      }
      return hit;
    }, { refreshAfterMs: 10 * MIN, checkIntervalMs: MIN, maxConsecutiveErrors: 1 });
    ka.record(a, undefined, 'stream');
    await vi.advanceTimersByTimeAsync(5 * MIN);
    ka.record(b, undefined, 'stream');
    await vi.advanceTimersByTimeAsync(6 * MIN);
    ka.record(a, undefined, 'stream');
    await vi.advanceTimersByTimeAsync(MIN);
    rejectFirst!(failure(5 * MIN));
    await vi.advanceTimersByTimeAsync(10 * MIN);

    expect(sent.map((s) => `${s.at / MIN} ${s.system}`)).toEqual(['10 A', '17 B', '21 A']);
    expect(events.filter((event) => event.type === 'skipped' || event.type === 'disabled')).toEqual([]);
    expect(trail(events, a)).toEqual(['error 1', 'refreshed']);
    expect(ka.getStatus().map((s) => s.key).sort()).toEqual([lineageKey(a), lineageKey(b)].sort());
  });

  it('a record() made from an error event is kept: the cap retires only the lineage that reached it', async () => {
    let reentered = false;
    const a = wire();
    const { ka, sent, events } = setup(() => { throw failure(); }, {
      refreshAfterMs: 10 * MIN, checkIntervalMs: MIN, maxConsecutiveErrors: 2,
    }, (event, keepalive) => {
      if (event.type === 'error' && event.consecutive === 2 && !reentered) {
        reentered = true;
        keepalive.record(a, undefined, 'stream');
      }
    });
    ka.record(a, undefined, 'stream');
    await vi.advanceTimersByTimeAsync(30 * MIN);

    expect(sent.map((s) => s.at / MIN)).toEqual([10, 11, 21, 22]);
    expect(trail(events, a)).toEqual(['error 1', 'error 2', 'error 1', 'error 2', 'skipped failure-cap']);
    expect(ka.getStatus()).toEqual([]);
  });

  it('a stop() made from an error event or a receipt ends the service: nothing is sent again, and a later record() is ignored', async () => {
    for (const where of ['error event', 'receipt'] as const) {
      const a = wire();
      const t0 = Date.now();
      let ka!: CacheKeepalive;
      const sent: number[] = [];
      const events: KeepaliveEvent[] = [];
      ka = new CacheKeepalive(async () => {
        sent.push(Date.now() - t0);
        if (where === 'error event') throw failure();
        return hit;
      }, {
        refreshAfterMs: 10 * MIN, checkIntervalMs: MIN, maxConsecutiveErrors: 3,
        onEvent: (event) => { events.push(event); if (where === 'error event' && event.type === 'error') ka.stop(); },
        onCall: () => { if (where === 'receipt') ka.stop(); },
      });
      keepalives.push(ka);
      ka.record(a, undefined, 'stream');
      await vi.advanceTimersByTimeAsync(10 * MIN);
      ka.record(a, undefined, 'stream');
      await vi.advanceTimersByTimeAsync(2 * HOUR);

      expect(sent).toEqual([10 * MIN]);
      expect(ka.getStatus()).toEqual([]);
      expect(events.filter((event) => event.type === 'skipped' || event.type === 'disabled')).toEqual([]);
    }
  });

  it('a poke that completes after stop() leaves the service stopped', async () => {
    let resolveFirst: ((value: unknown) => void) | undefined;
    const a = wire();
    const { ka, sent } = setup(() => new Promise((resolve) => { resolveFirst = resolve; }), {
      refreshAfterMs: 10 * MIN, checkIntervalMs: MIN,
    });
    ka.record(a, undefined, 'stream');
    await vi.advanceTimersByTimeAsync(11 * MIN);
    ka.stop();
    resolveFirst!(hit);
    await vi.advanceTimersByTimeAsync(MIN);
    ka.record(a, undefined, 'stream');
    await vi.advanceTimersByTimeAsync(2 * HOUR);

    expect(sent).toHaveLength(1);
    expect(ka.getStatus()).toEqual([]);
  });
});

describe("the Anthropic adapter's keepalive sender", () => {
  it("hands the keepalive a normalized error carrying the provider's stated wait, which holds the model's next poke, after the SDK's own retries", async () => {
    const calls: KeepaliveCall[] = [];
    const pokes: number[] = [];
    const usage = {
      input_tokens: 12, output_tokens: 0, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0,
    };
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init: { body: string }) => {
      const body = JSON.parse(init.body);
      if (body.max_tokens === 0) {
        pokes.push(Date.now() - START);
        return new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited' } }), {
          status: 429, headers: { 'content-type': 'application/json', 'retry-after': '120' },
        });
      }
      return new Response(JSON.stringify({
        id: 'response', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5',
        content: [], stop_reason: 'max_tokens', stop_sequence: null, usage,
      }), { headers: { 'content-type': 'application/json' } });
    }));
    const adapter = new AnthropicAdapter({
      apiKey: 'test-key',
      cacheKeepalive: {
        lanes: ['complete'], refreshAfterMs: 100, checkIntervalMs: 100, maxIdleMs: HOUR, maxConsecutiveErrors: 3,
        onCall: (call) => { calls.push(call); },
      },
    });
    keepalives.push(adapter.cacheKeepalive!);
    const seed = wire('claude-sonnet-4-5');
    await adapter.complete({
      model: 'claude-sonnet-4-5', maxTokens: 1024,
      system: seed.system as never, messages: seed.messages as never,
      extra: { thinking: { type: 'adaptive' } },
    });
    await vi.advanceTimersByTimeAsync(2_500);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.outcome).toBe('error');
    const error = (call as { error: unknown }).error;
    expect(error).toBeInstanceOf(MembraneError);
    expect(error).toMatchObject({ type: 'rate_limit', httpStatus: 429, retryAfterMs: 120_000 });
    expect((error as MembraneError).rawError).toMatchObject({ status: 429 });
    expect(pokes).toHaveLength(3);

    const failedAt = call.startedAt + call.durationMs - START;
    await vi.advanceTimersByTimeAsync(failedAt + 120_000 - 1 - 2_500);
    expect(pokes).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pokes.length).toBeGreaterThan(3);
  });
});
