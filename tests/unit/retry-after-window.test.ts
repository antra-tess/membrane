/**
 * A provider's stated wait is a lower bound, inside one call as well as
 * across calls.
 *
 * The in-call retry loop may only retry after the provider's `retry-after`.
 * A wait that fits the schedule's `maxRetryDelayMs` is honored exactly. A
 * longer one, or one that is not a usable number, ends the call with the
 * classified error and its `retryAfterMs` intact, so the caller, which owns
 * pacing across calls, can wait it out. Before this, the wait was clamped to
 * `maxRetryDelayMs`, so a 120 s retry-after was retried after 30 s.
 *
 * The wait itself can exceed what one timer represents (2^31-1 ms): a
 * configured cap above that is taken in steps, still abort-aware.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { MockAdapter } from '../../src/providers/mock.js';
import { MembraneError, authError } from '../../src/types/errors.js';
import type { RetryConfigInput } from '../../src/types/config.js';
import type { NormalizedRequest } from '../../src/types/index.js';
import type { ProviderRequest, ProviderRequestOptions, ProviderResponse } from '../../src/types/provider.js';
import type { StreamCallbacks } from '../../src/types/streaming.js';

class FailingAdapter extends MockAdapter {
  calls = 0;
  constructor(private failures: number, private makeError: () => Error) {
    super();
  }
  override async complete(request: ProviderRequest, options?: ProviderRequestOptions): Promise<ProviderResponse> {
    this.calls++;
    if (this.calls <= this.failures) throw this.makeError();
    return super.complete(request, options);
  }
  override async stream(request: ProviderRequest, callbacks: StreamCallbacks, options?: ProviderRequestOptions): Promise<ProviderResponse> {
    this.calls++;
    if (this.calls <= this.failures) throw this.makeError();
    return super.stream(request, callbacks, options);
  }
}

const zzRequest: NormalizedRequest = {
  messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz-prompt' }] }],
  config: { model: 'zz-model-1', maxTokens: 64 },
};

const limited = (retryAfterMs: number | undefined, httpStatus = 429) => () => new MembraneError({
  type: httpStatus === 429 ? 'rate_limit' : 'server',
  message: `zz-provider ${httpStatus}`,
  retryable: true,
  retryAfterMs,
  httpStatus,
  rawError: undefined,
});

/** A Membrane whose waits are recorded instead of taken. */
function recording(adapter: MockAdapter, retry: ConstructorParameters<typeof Membrane>[1] extends infer C ? C extends { retry?: infer R } ? R : never : never) {
  const membrane = new Membrane(adapter, { retry });
  const waits: number[] = [];
  (membrane as unknown as { sleep(ms: number): Promise<void> }).sleep = async (ms: number) => { waits.push(ms); };
  return { membrane, waits };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('complete(): the provider wait is a lower bound', () => {
  it('ends the call with the wait intact when retry-after exceeds the in-call budget', async () => {
    const adapter = new FailingAdapter(1, limited(120_000));
    adapter.queueResponse('zz-recovered');
    const { membrane, waits } = recording(adapter, { maxRetries: 3, retryDelayMs: 1_000, maxRetryDelayMs: 30_000 });
    const error = await membrane.complete(zzRequest).then(() => undefined, (e: MembraneError) => e);
    expect(error).toBeInstanceOf(MembraneError);
    expect(error).toMatchObject({ type: 'rate_limit', retryAfterMs: 120_000, retryable: true });
    expect(adapter.calls).toBe(1);
    expect(waits).toEqual([]);
  });

  it('waits exactly the stated time when it fits the budget', async () => {
    const adapter = new FailingAdapter(1, limited(20_000));
    adapter.queueResponse('zz-recovered');
    const { membrane, waits } = recording(adapter, { maxRetries: 3, retryDelayMs: 1_000, maxRetryDelayMs: 30_000 });
    const response = await membrane.complete(zzRequest);
    expect(response.content[0]).toMatchObject({ type: 'text', text: 'zz-recovered' });
    expect(adapter.calls).toBe(2);
    expect(waits).toEqual([20_000]);
  });

  it('keeps the local backoff when it is longer than the stated wait', async () => {
    const adapter = new FailingAdapter(2, limited(10));
    adapter.queueResponse('zz-recovered');
    const { membrane, waits } = recording(adapter, { maxRetries: 3, retryDelayMs: 1_000, maxRetryDelayMs: 30_000 });
    await membrane.complete(zzRequest);
    expect(waits).toEqual([1_000, 2_000]);
  });

  it('treats an unusable stated wait as one it cannot honor in the call', async () => {
    for (const unusable of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const adapter = new FailingAdapter(1, limited(unusable));
      adapter.queueResponse('zz-recovered');
      const { membrane, waits } = recording(adapter, { maxRetries: 3, retryDelayMs: 1_000, maxRetryDelayMs: 30_000 });
      const error = await membrane.complete(zzRequest).then(() => undefined, (e: MembraneError) => e);
      expect(error?.type).toBe('rate_limit');
      expect(adapter.calls).toBe(1);
      expect(waits).toEqual([]);
    }
  });

  it('applies the overload schedule budget to a 529 retry-after', async () => {
    const tooLong = new FailingAdapter(1, limited(400_000, 529));
    tooLong.queueResponse('zz-recovered');
    const first = recording(tooLong, { overloaded: { maxRetries: 7, retryDelayMs: 10_000, backoffMultiplier: 2, maxRetryDelayMs: 300_000 } });
    await expect(first.membrane.complete(zzRequest)).rejects.toMatchObject({ type: 'server', retryAfterMs: 400_000 });
    expect(tooLong.calls).toBe(1);
    expect(first.waits).toEqual([]);

    const fits = new FailingAdapter(1, limited(200_000, 529));
    fits.queueResponse('zz-recovered');
    const second = recording(fits, { overloaded: { maxRetries: 7, retryDelayMs: 10_000, backoffMultiplier: 2, maxRetryDelayMs: 300_000 } });
    await second.membrane.complete(zzRequest);
    expect(fits.calls).toBe(2);
    expect(second.waits).toEqual([200_000]);
  });

  it('takes a configured wait beyond the timer limit in full', async () => {
    const adapter = new FailingAdapter(1, limited(2_500_000_000));
    adapter.queueResponse('zz-recovered');
    const { membrane, waits } = recording(adapter, { maxRetries: 3, retryDelayMs: 1_000, maxRetryDelayMs: 3_000_000_000 });
    await membrane.complete(zzRequest);
    expect(waits).toEqual([2_500_000_000]);
  });
});

describe('stream(): the pre-emission retry follows the same bound', () => {
  it('ends the call with the wait intact when retry-after exceeds the budget', async () => {
    const adapter = new FailingAdapter(1, limited(120_000));
    adapter.queueResponse('zz-recovered');
    const { membrane, waits } = recording(adapter, { maxRetries: 3, retryDelayMs: 1_000, maxRetryDelayMs: 30_000 });
    await expect(membrane.stream(zzRequest, { onChunk: () => {} })).rejects.toMatchObject({ type: 'rate_limit', retryAfterMs: 120_000 });
    expect(adapter.calls).toBe(1);
    expect(waits).toEqual([]);
  });

  it('waits exactly the stated time when it fits the budget', async () => {
    const adapter = new FailingAdapter(1, limited(20_000));
    adapter.queueResponse('zz-recovered');
    const { membrane, waits } = recording(adapter, { maxRetries: 3, retryDelayMs: 1_000, maxRetryDelayMs: 30_000 });
    await membrane.stream(zzRequest, { onChunk: () => {} });
    expect(adapter.calls).toBe(2);
    expect(waits).toEqual([20_000]);
  });
});

describe('sleep() past the timer limit', () => {
  const sleepOf = (membrane: Membrane) =>
    (membrane as unknown as { sleep(ms: number, signal?: AbortSignal): Promise<void> }).sleep.bind(membrane);

  it('steps through a wait longer than one timer can hold, never asking for more', async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, 'setTimeout');
    const sleep = sleepOf(new Membrane(new MockAdapter()));
    let done = false;
    const pending = sleep(5_000_000_000).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(4_999_999_000);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;
    expect(done).toBe(true);
    const asked = spy.mock.calls.map((call) => call[1] as number);
    expect(asked.every((ms) => ms <= 2_147_483_647)).toBe(true);
    expect(asked.reduce((sum, ms) => sum + ms, 0)).toBe(5_000_000_000);
  });

  it('stays abort-aware across steps', async () => {
    vi.useFakeTimers();
    const sleep = sleepOf(new Membrane(new MockAdapter()));
    const controller = new AbortController();
    const pending = sleep(5_000_000_000, controller.signal);
    await vi.advanceTimersByTimeAsync(3_000_000_000);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('resolves at once for a zero or negative wait', async () => {
    const sleep = sleepOf(new Membrane(new MockAdapter()));
    await expect(sleep(0)).resolves.toBeUndefined();
    await expect(sleep(-5)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The same contract through the real Anthropic adapter and SDK. The SDK sits
// beneath Membrane's retry loop and, left at its defaults, retried 408, 409,
// 429, 5xx and connection failures twice on its own before Membrane saw an
// error. It honored a stated wait only below 60 s, replacing a longer one
// with a backoff of about a second, and it knew nothing of Membrane's budget.
// These cases script fetch, run every wait on a fake clock, and assert what
// went over the network and when, rather than counting adapter calls.
// ---------------------------------------------------------------------------

const claudeRequest: NormalizedRequest = {
  messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz-prompt' }] }],
  config: { model: 'claude-sonnet-4-6', maxTokens: 64 },
};
const claudeMessage = {
  id: 'msg_zz', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
  content: [{ type: 'text', text: 'zz-recovered' }], stop_reason: 'end_turn', stop_sequence: null,
  usage: { input_tokens: 3, output_tokens: 2 },
};
const errorTypes: Record<number, string> = { 429: 'rate_limit_error', 500: 'api_error', 529: 'overloaded_error' };
const refused = (status: number, headers: Record<string, string> = {}) => () => new Response(
  JSON.stringify({ type: 'error', error: { type: errorTypes[status], message: `zz-refused ${status}` } }),
  { status, headers: { 'content-type': 'application/json', ...headers } },
);
const completed = () => new Response(JSON.stringify(claudeMessage), { headers: { 'content-type': 'application/json' } });
const streamed = () => new Response([
  { type: 'message_start', message: { ...claudeMessage, content: [], stop_reason: null } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'zz-recovered' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
  { type: 'message_stop' },
].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
const unreachable = () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) }); };

/**
 * Script the network: each attempt is answered by the next entry, the last
 * one repeating. Returns the fake-clock time of every attempt, from the start.
 */
function network(script: Array<() => Response>): number[] {
  const sent: number[] = [];
  const start = Date.now();
  vi.stubGlobal('fetch', vi.fn(async () => {
    sent.push(Date.now() - start);
    return script[Math.min(sent.length, script.length) - 1]!();
  }));
  return sent;
}

/** A real Membrane over the real Anthropic adapter; build it after scripting fetch. */
const overClaude = (retry?: RetryConfigInput) => new Membrane(
  new AnthropicAdapter({ apiKey: 'zz-key', cacheKeepalive: { enabled: false } }),
  { retry },
);

/** Run a call to its end on the fake clock, every timer it sets elapsing. */
async function settle<T>(call: Promise<T>): Promise<{ value?: T; error?: unknown }> {
  const outcome = call.then((value) => ({ value }), (error: unknown) => ({ error }));
  await vi.runAllTimersAsync();
  return outcome;
}

describe('through the real Anthropic adapter: no retry beneath Membrane', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('complete(): a wait beyond the budget goes out once, and the call ends with it intact', async () => {
    const sent = network([refused(429, { 'retry-after': '120' }), completed]);
    const { error } = await settle(overClaude().complete(claudeRequest));
    expect(error).toMatchObject({ type: 'rate_limit', retryAfterMs: 120_000 });
    expect(sent).toEqual([0]);
  });

  it('complete(): a wait under 60 s but beyond the budget ends the call too, instead of being slept through', async () => {
    const sent = network([refused(429, { 'retry-after': '45' }), completed]);
    const { error } = await settle(overClaude().complete(claudeRequest));
    expect(error).toMatchObject({ type: 'rate_limit', retryAfterMs: 45_000 });
    expect(sent).toEqual([0]);
  });

  it('complete(): a fitting wait is exactly the time between attempts (control)', async () => {
    const sent = network([refused(429, { 'retry-after': '20' }), completed]);
    const { value } = await settle(overClaude().complete(claudeRequest));
    expect(value?.content[0]).toMatchObject({ type: 'text', text: 'zz-recovered' });
    expect(sent).toEqual([0, 20_000]);
  });

  it('complete(): a persisting rate limit makes the five documented attempts, each after max(backoff, wait)', async () => {
    const sent = network([refused(429, { 'retry-after': '2' })]);
    const { error } = await settle(overClaude().complete(claudeRequest));
    expect(error).toMatchObject({ type: 'rate_limit', retryAfterMs: 2_000 });
    expect(sent).toEqual([0, 2_000, 4_000, 8_000, 16_000]);
  });

  it('complete(): a persisting 529 makes the seven attempts of the overload schedule', async () => {
    // Pin the overload schedule's jitter at its floor, half of each delay.
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const sent = network([refused(529)]);
    const { error } = await settle(overClaude().complete(claudeRequest));
    expect(error).toMatchObject({ type: 'server', httpStatus: 529 });
    expect(sent).toEqual([0, 5_000, 15_000, 35_000, 75_000, 155_000, 305_000]);
  });

  it('complete(): a 500 under the default policy goes out once, as on every fetch adapter', async () => {
    const sent = network([refused(500), completed]);
    const { error } = await settle(overClaude().complete(claudeRequest));
    expect(error).toMatchObject({ type: 'server', httpStatus: 500, retryable: true });
    expect(sent).toEqual([0]);
  });

  it('complete(): a connection failure reaches the caller once, as a retryable network error', async () => {
    const sent = network([unreachable]);
    const { error } = await settle(overClaude().complete(claudeRequest));
    expect(error).toBeInstanceOf(MembraneError);
    expect(error).toMatchObject({ type: 'network', retryable: true });
    expect(sent).toEqual([0]);
  });

  it('complete(): an enabled retry policy retries a connection failure on its own schedule', async () => {
    const sent = network([unreachable, completed]);
    const { value } = await settle(overClaude({ maxRetries: 2, retryDelayMs: 1_000 }).complete(claudeRequest));
    expect(value?.content[0]).toMatchObject({ type: 'text', text: 'zz-recovered' });
    expect(sent).toEqual([0, 1_000]);
  });

  it('complete(): a credential resolver failure is still the error the caller gets, with nothing sent', async () => {
    const sent = network([completed]);
    const failure = authError('zz-login required');
    const membrane = new Membrane(new AnthropicAdapter({
      credentials: () => { throw failure; },
      cacheKeepalive: { enabled: false },
    }), { retry: { maxRetries: 2, retryDelayMs: 1_000 } });
    const { error } = await settle(membrane.complete(claudeRequest));
    expect(error).toMatchObject({ type: 'auth', retryable: false, message: 'zz-login required' });
    expect(sent).toEqual([]);
  });

  it('stream(): a connection failure goes out once even under an enabled policy, which retries only rate limits and overloads before output', async () => {
    const sent = network([unreachable, streamed]);
    const { error } = await settle(overClaude({ maxRetries: 2, retryDelayMs: 1_000 }).stream(claudeRequest, { onChunk: () => {} }));
    expect(error).toMatchObject({ type: 'network', retryable: true });
    expect(sent).toEqual([0]);
  });

  it('stream(): a wait beyond the budget goes out once, and the call ends with it intact', async () => {
    const sent = network([refused(429, { 'retry-after': '120' }), streamed]);
    const { error } = await settle(overClaude().stream(claudeRequest, { onChunk: () => {} }));
    expect(error).toMatchObject({ type: 'rate_limit', retryAfterMs: 120_000 });
    expect(sent).toEqual([0]);
  });

  it('stream(): a fitting wait is exactly the time between attempts (control)', async () => {
    const sent = network([refused(429, { 'retry-after': '20' }), streamed]);
    const chunks: string[] = [];
    const { value } = await settle(overClaude().stream(claudeRequest, { onChunk: (chunk) => { chunks.push(chunk); } }));
    expect(value?.content[0]).toMatchObject({ type: 'text', text: 'zz-recovered' });
    expect(chunks.join('')).toBe('zz-recovered');
    expect(sent).toEqual([0, 20_000]);
  });
});

// ---------------------------------------------------------------------------
// A wait stated in `retry-after-ms`. The SDK read that header before
// `retry-after` when it retried; with its retries off, the adapter's own
// reader is the only one, so it reads both, in the SDK's order.
// ---------------------------------------------------------------------------

describe('through the real Anthropic adapter: a wait stated in retry-after-ms', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('complete(): a fitting wait is exactly the time between attempts', async () => {
    const sent = network([refused(429, { 'retry-after-ms': '20000' }), completed]);
    const { value } = await settle(overClaude().complete(claudeRequest));
    expect(value?.content[0]).toMatchObject({ type: 'text', text: 'zz-recovered' });
    expect(sent).toEqual([0, 20_000]);
  });

  it('complete(): a wait beyond the budget goes out once, and the call ends with it intact', async () => {
    const sent = network([refused(429, { 'retry-after-ms': '120000' }), completed]);
    const { error } = await settle(overClaude().complete(claudeRequest));
    expect(error).toMatchObject({ type: 'rate_limit', retryAfterMs: 120_000 });
    expect(sent).toEqual([0]);
  });

  it('stream(): a fitting wait is exactly the time between attempts', async () => {
    const sent = network([refused(429, { 'retry-after-ms': '20000' }), streamed]);
    const { value } = await settle(overClaude().stream(claudeRequest, { onChunk: () => {} }));
    expect(value?.content[0]).toMatchObject({ type: 'text', text: 'zz-recovered' });
    expect(sent).toEqual([0, 20_000]);
  });

  it('stream(): a wait beyond the budget goes out once, and the call ends with it intact', async () => {
    const sent = network([refused(429, { 'retry-after-ms': '120000' }), streamed]);
    const { error } = await settle(overClaude().stream(claudeRequest, { onChunk: () => {} }));
    expect(error).toMatchObject({ type: 'rate_limit', retryAfterMs: 120_000 });
    expect(sent).toEqual([0]);
  });

  it('a fractional wait is carried in whole milliseconds, rounded as the other readers round it', async () => {
    network([refused(429, { 'retry-after-ms': '120000.6' })]);
    const { error } = await settle(overClaude().complete(claudeRequest));
    expect(error).toMatchObject({ type: 'rate_limit', retryAfterMs: 120_001 });
  });

  it('retry-after-ms takes precedence over retry-after', async () => {
    const sent = network([refused(429, { 'retry-after-ms': '20000', 'retry-after': '120' }), completed]);
    const { value } = await settle(overClaude().complete(claudeRequest));
    expect(value?.content[0]).toMatchObject({ type: 'text', text: 'zz-recovered' });
    expect(sent).toEqual([0, 20_000]);
  });

  it('a retry-after-ms of zero is a stated wait of zero, not a reason to read retry-after', async () => {
    const sent = network([refused(429, { 'retry-after-ms': '0', 'retry-after': '120' }), completed]);
    const { value } = await settle(overClaude().complete(claudeRequest));
    expect(value?.content[0]).toMatchObject({ type: 'text', text: 'zz-recovered' });
    // The schedule's own first backoff, which a zero wait does not lengthen.
    expect(sent).toEqual([0, 1_000]);
  });

  it('a retry-after-ms that is not a non-negative finite number leaves retry-after to state the wait (control)', async () => {
    for (const unusable of ['zz-soon', '-5', 'Infinity', '']) {
      const sent = network([refused(429, { 'retry-after-ms': unusable, 'retry-after': '20' }), completed]);
      const { value } = await settle(overClaude().complete(claudeRequest));
      expect(value?.content[0], unusable).toMatchObject({ type: 'text', text: 'zz-recovered' });
      expect(sent, unusable).toEqual([0, 20_000]);
    }
  });
});
