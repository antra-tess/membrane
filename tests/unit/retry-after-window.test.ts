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

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { MockAdapter } from '../../src/providers/mock.js';
import { MembraneError } from '../../src/types/errors.js';
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
