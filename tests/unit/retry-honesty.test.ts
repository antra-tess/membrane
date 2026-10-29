import { afterEach, describe, it, expect, vi } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { MockAdapter } from '../../src/providers/mock.js';
import { MembraneError, serverError } from '../../src/types/errors.js';
import type { NormalizedRequest, NormalizedResponse } from '../../src/types/index.js';
import type { ProviderRequest, ProviderRequestOptions, ProviderResponse } from '../../src/types/provider.js';
import type { StreamCallbacks } from '../../src/types/streaming.js';

afterEach(() => {
  vi.useRealTimers();
});

class FailingAdapter extends MockAdapter {
  completeCalls = 0;
  streamCalls = 0;
  constructor(
    private failures: number,
    private makeError: () => Error,
    private emitBeforeFailure = false,
  ) {
    super();
  }

  override async complete(request: ProviderRequest, options?: ProviderRequestOptions): Promise<ProviderResponse> {
    this.completeCalls++;
    if (this.completeCalls <= this.failures) throw this.makeError();
    return super.complete(request, options);
  }

  override async stream(
    request: ProviderRequest,
    callbacks: StreamCallbacks,
    options?: ProviderRequestOptions,
  ): Promise<ProviderResponse> {
    this.streamCalls++;
    if (this.streamCalls <= this.failures) {
      if (this.emitBeforeFailure) callbacks.onChunk('zz-partial ');
      throw this.makeError();
    }
    return super.stream(request, callbacks, options);
  }
}

const zzRequest: NormalizedRequest = {
  messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz-prompt' }] }],
  config: { model: 'zz-model-1', maxTokens: 64 },
};

function rateLimit(retryAfterMs?: number, providerErrorCode?: string, retryable = true): MembraneError {
  return new MembraneError({
    type: 'rate_limit',
    message: 'zz-provider rate limit reached',
    retryable,
    retryAfterMs,
    httpStatus: 429,
    providerErrorCode,
    rawError: undefined,
  });
}

describe("membrane's retry wait honors retry-after (MAJOR-2)", () => {
  it('waits at least the server-stated window instead of the backoff', async () => {
    const adapter = new FailingAdapter(1, () => rateLimit(180));
    adapter.queueResponse('zz-recovered');
    const membrane = new Membrane(adapter, { retry: { maxRetries: 2, retryDelayMs: 1, maxRetryDelayMs: 30_000 } });

    const response = await acrossOneWait(membrane, adapter, 180);

    expect(response.content[0]).toMatchObject({ type: 'text', text: 'zz-recovered' });
  });

  it('gives the caller a stated wait longer than a minute and than maxRetryDelayMs instead of retrying inside it', async () => {
    const adapter = new FailingAdapter(1, () => rateLimit(60_001));
    adapter.queueResponse('zz-recovered');
    const membrane = new Membrane(adapter, { retry: { maxRetries: 2, retryDelayMs: 1, maxRetryDelayMs: 40 } });

    await expect(membrane.complete(zzRequest)).rejects.toMatchObject({
      type: 'rate_limit', retryAfterMs: 60_001,
    });
    expect(adapter.completeCalls).toBe(1);
  });

  it('waits the backoff when the stated wait is shorter (0)', async () => {
    const adapter = new FailingAdapter(1, () => rateLimit(0));
    adapter.queueResponse('zz-recovered');
    const membrane = new Membrane(adapter, { retry: { maxRetries: 2, retryDelayMs: 200, maxRetryDelayMs: 30_000 } });

    await acrossOneWait(membrane, adapter, 200);
  });

  it('keeps the plain backoff when no retry-after was sent', async () => {
    const adapter = new FailingAdapter(1, () => rateLimit(undefined));
    adapter.queueResponse('zz-recovered');
    const membrane = new Membrane(adapter, { retry: { maxRetries: 2, retryDelayMs: 1, maxRetryDelayMs: 30_000 } });

    const response = await membrane.complete(zzRequest);
    expect(response.details.timing.retryDelaysMs).toEqual([1]);
  });

  it('a NaN stated wait counts as none: the backoff stands', async () => {
    const adapter = new FailingAdapter(1, () => rateLimit(NaN));
    adapter.queueResponse('zz-recovered');
    const membrane = new Membrane(adapter, { retry: { retryDelayMs: 20, backoffMultiplier: 1 } });

    const response = await membrane.complete(zzRequest);
    expect(response.details.timing.retryDelaysMs).toEqual([20]);
  });

  it('a zero base delay stays zero when the backoff overflows, so a stated wait still stands', async () => {
    // 1e308 squared is Infinity, and 0 times Infinity is NaN.
    const adapter = new FailingAdapter(3, () => rateLimit(50));
    adapter.queueResponse('zz-recovered');
    const membrane = new Membrane(adapter, { retry: { retryDelayMs: 0, backoffMultiplier: 1e308 } });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const done = membrane.complete(zzRequest);
      await vi.runAllTimersAsync();
      const response = await done;
      expect(adapter.completeCalls).toBe(4);
      expect(response.details.timing.retryDelaysMs).toEqual([50, 50, 50]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('complete(): a call that succeeds at its first send lists no waits', async () => {
    const adapter = new FailingAdapter(0, () => rateLimit(1));
    adapter.queueResponse('zz-first');
    const response = await new Membrane(adapter).complete(zzRequest);
    expect(adapter.completeCalls).toBe(1);
    expect(response.details.timing.retryDelaysMs).toBeUndefined();
  });

  it('complete(): afterResponse sees the waits', async () => {
    const adapter = new FailingAdapter(1, () => serverError('zz internal', 503));
    adapter.queueResponse('zz-recovered');
    let seen: number[] | undefined;
    const membrane = new Membrane(adapter, {
      retry: { retryDelayMs: 1, backoffMultiplier: 1 },
      hooks: {
        afterResponse: (response) => {
          seen = response.details.timing.retryDelaysMs;
          return response;
        },
      },
    });

    await membrane.complete(zzRequest);
    expect(seen).toEqual([1]);
  });

  it('honors retry-after on the streaming retry path too', async () => {
    const adapter = new FailingAdapter(1, () => rateLimit(180));
    adapter.queueResponse('zz-recovered');
    const membrane = new Membrane(adapter, { retry: { maxRetries: 2, retryDelayMs: 1, maxRetryDelayMs: 30_000 } });

    await acrossOneWait(membrane, adapter, 180, 'stream');
  });
});

async function acrossOneWait(membrane: Membrane, adapter: FailingAdapter, waitMs: number, method: 'complete' | 'stream' = 'complete'): Promise<NormalizedResponse> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const done = method === 'complete' ? membrane.complete(zzRequest) : membrane.stream(zzRequest, { onChunk: () => {} });
    const sends = () => (method === 'complete' ? adapter.completeCalls : adapter.streamCalls);
    for (let hop = 0; hop < 50 && vi.getTimerCount() === 0; hop++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(vi.getTimerCount()).toBe(1);
    expect(sends()).toBe(1);
    await vi.advanceTimersByTimeAsync(waitMs - 1);
    expect(sends()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    for (let hop = 0; hop < 50 && sends() < 2; hop++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(sends()).toBe(2);
    await vi.runAllTimersAsync();
    return (await done) as NormalizedResponse;
  } finally {
    vi.useRealTimers();
  }
}

describe('a stated wait of up to a minute is waited out, whatever the schedule\'s backoff ceiling', () => {
  it('a 429 stating 45 s is waited out on the default schedule', async () => {
    const adapter = new FailingAdapter(1, () => rateLimit(45_000));
    adapter.queueResponse('zz-recovered');
    const response = await acrossOneWait(new Membrane(adapter), adapter, 45_000);
    expect(response.details.timing.retryDelaysMs).toEqual([45_000]);
  });

  it('so is one stating exactly a minute', async () => {
    const adapter = new FailingAdapter(1, () => rateLimit(60_000));
    adapter.queueResponse('zz-recovered');
    const response = await acrossOneWait(new Membrane(adapter), adapter, 60_000);
    expect(response.details.timing.retryDelaysMs).toEqual([60_000]);
  });

  it('a ceiling set above a minute waits stated waits out up to it', async () => {
    const adapter = new FailingAdapter(1, () => rateLimit(90_000));
    adapter.queueResponse('zz-recovered');
    const membrane = new Membrane(adapter, { retry: { maxRetryDelayMs: 120_000 } });
    const response = await acrossOneWait(membrane, adapter, 90_000);
    expect(response.details.timing.retryDelaysMs).toEqual([90_000]);

    const longer = new FailingAdapter(1, () => rateLimit(120_001));
    longer.queueResponse('zz-never');
    await expect(new Membrane(longer, { retry: { maxRetryDelayMs: 120_000 } }).complete(zzRequest))
      .rejects.toMatchObject({ type: 'rate_limit', retryAfterMs: 120_001 });
    expect(longer.completeCalls).toBe(1);
  });

  it('a wait past the platform timer\'s limit that is cancelled after its first step leaves no timer armed', async () => {
    const day = 24 * 60 * 60 * 1000;
    const adapter = new FailingAdapter(1, () => rateLimit(25 * day));
    adapter.queueResponse('zz-never');
    const membrane = new Membrane(adapter, { retry: { maxRetryDelayMs: 30 * day } });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const controller = new AbortController();
      const settled = membrane.complete(zzRequest, { signal: controller.signal }).then(() => 'resolved', () => 'rejected');
      for (let hop = 0; hop < 50 && vi.getTimerCount() === 0; hop++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(vi.getTimerCount()).toBe(1);
      const platformTimerLimitMs = 2_147_483_647;
      await vi.advanceTimersByTimeAsync(platformTimerLimitMs + 60 * 60 * 1000);
      expect(adapter.completeCalls).toBe(1);
      expect(vi.getTimerCount()).toBe(1);
      controller.abort();
      expect(await settled).toBe('rejected');
      expect(vi.getTimerCount()).toBe(0);
      expect(adapter.completeCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a stated wait past the platform timer\'s limit is waited out in full, not after 1 ms', async () => {
    // A timer longer than 2^31 - 1 ms (about 24.8 days) fires after 1 ms on
    // Node and in browsers, and vitest's fake timers do the same.
    const day = 24 * 60 * 60 * 1000;
    const adapter = new FailingAdapter(1, () => rateLimit(25 * day));
    adapter.queueResponse('zz-recovered');
    const membrane = new Membrane(adapter, { retry: { maxRetryDelayMs: 30 * day } });
    const response = await acrossOneWait(membrane, adapter, 25 * day);
    expect(response.details.timing.retryDelaysMs).toEqual([25 * day]);
  });
});

describe('the retry config: a field left out takes its default, and a value that can\'t bound a retry is refused', () => {
  const FAST = { retryDelayMs: 1, maxRetryDelayMs: 2, backoffMultiplier: 1 };

  it('a field given as undefined takes its default', async () => {
    const adapter = new FailingAdapter(10, () => serverError('zz internal', 503));
    adapter.queueResponse('zz-never');
    const membrane = new Membrane(adapter, { retry: { ...FAST, maxRetries: undefined } });
    await expect(membrane.complete(zzRequest)).rejects.toMatchObject({ type: 'server' });
    expect(adapter.completeCalls).toBe(3);
  });

  it('so does a field of the overloaded schedule', async () => {
    const adapter = new FailingAdapter(10, () => serverError('zz overloaded', 529));
    adapter.queueResponse('zz-never');
    const membrane = new Membrane(adapter, { retry: { overloaded: { ...FAST, maxRetries: undefined } } });
    await expect(membrane.complete(zzRequest)).rejects.toMatchObject({ httpStatus: 529 });
    expect(adapter.completeCalls).toBe(7);
  });

  it('a delay given as undefined takes its default, not a wait of about a millisecond', async () => {
    const adapter = new FailingAdapter(1, () => serverError('zz internal', 503));
    adapter.queueResponse('zz-recovered');
    const membrane = new Membrane(adapter, { retry: { retryDelayMs: undefined, maxRetryDelayMs: undefined } });
    const response = await acrossOneWait(membrane, adapter, 1000);
    expect(response.details.timing.retryDelaysMs).toEqual([1000]);
  });

  const fields = [
    'maxRetries', 'retryDelayMs', 'backoffMultiplier', 'maxRetryDelayMs',
    'overloaded.maxRetries', 'overloaded.retryDelayMs', 'overloaded.backoffMultiplier', 'overloaded.maxRetryDelayMs',
  ];
  const retryWith = (field: string, value: unknown) => {
    const [first, second] = field.split('.');
    return (second ? { [first!]: { [second]: value } } : { [first!]: value }) as never;
  };

  it.each(fields)('retry.%s = NaN is refused at construction, naming the field', (field) => {
    expect(() => new Membrane(new MockAdapter(), { retry: retryWith(field, NaN) }))
      .toThrow(new RangeError(`[membrane] retry.${field} must be a finite number of at least 0, got NaN`));
  });

  it.each(fields)('retry.%s = Infinity is refused at construction, naming the field', (field) => {
    expect(() => new Membrane(new MockAdapter(), { retry: retryWith(field, Infinity) }))
      .toThrow(new RangeError(`[membrane] retry.${field} must be a finite number of at least 0, got Infinity`));
  });

  it.each([[Infinity], [-1]])('retry.maxRetries = %s is refused at construction', (value) => {
    expect(() => new Membrane(new MockAdapter(), { retry: retryWith('maxRetries', value) })).toThrow(RangeError);
  });

  it.each([['3', 'string'], [null, 'null']])('retry.maxRetries = %j is refused as not a number', (value, shown) => {
    expect(() => new Membrane(new MockAdapter(), { retry: retryWith('maxRetries', value) }))
      .toThrow(new TypeError(`[membrane] retry.maxRetries must be a number, got ${shown}`));
  });

  it('0 is a bound: a 5xx is sent once', async () => {
    const adapter = new FailingAdapter(10, () => serverError('zz internal', 503));
    adapter.queueResponse('zz-never');
    const membrane = new Membrane(adapter, { retry: { maxRetries: 0, retryDelayMs: 0 } });
    await expect(membrane.complete(zzRequest)).rejects.toMatchObject({ type: 'server' });
    expect(adapter.completeCalls).toBe(1);
  });
});

describe('the 429 floor applies only to genuine rate limits (MINOR-8)', () => {
  it('does not spend five attempts on a non-retryable quota failure', async () => {
    const adapter = new FailingAdapter(Infinity, () => rateLimit(undefined, 'insufficient_quota', false));
    const membrane = new Membrane(adapter, { retry: { retryDelayMs: 1 } });

    await expect(membrane.complete(zzRequest)).rejects.toThrow('zz-provider rate limit reached');
    expect(adapter.completeCalls).toBe(1);
  });

  it('still forces the five-attempt floor on a genuine rate limit', async () => {
    const adapter = new FailingAdapter(Infinity, () => rateLimit(undefined, 'rate_limit_exceeded'));
    const membrane = new Membrane(adapter, { retry: { retryDelayMs: 1 } });

    await expect(membrane.complete(zzRequest)).rejects.toThrow('zz-provider rate limit reached');
    expect(adapter.completeCalls).toBe(5);
  });
});

describe('stream() retries a pre-emission 429 (MINOR-9)', () => {
  it('retries when the rate limit arrives instead of a stream', async () => {
    const adapter = new FailingAdapter(2, () => rateLimit(undefined, 'rate_limit_exceeded'));
    adapter.queueResponse('zz-recovered');
    const membrane = new Membrane(adapter, { retry: { retryDelayMs: 1 } });

    const result = await membrane.stream(zzRequest, { onChunk: () => {} });
    expect(adapter.streamCalls).toBe(3);
    expect('content' in result && result.content[0]).toMatchObject({ type: 'text', text: 'zz-recovered' });
  });

  it('does not retry once tokens have already reached the caller', async () => {
    const adapter = new FailingAdapter(Infinity, () => rateLimit(undefined, 'rate_limit_exceeded'), true);
    const membrane = new Membrane(adapter, { retry: { retryDelayMs: 1 } });

    await expect(membrane.stream(zzRequest, { onChunk: () => {} })).rejects.toThrow('zz-provider rate limit reached');
    expect(adapter.streamCalls).toBe(1);
  });

  it('does not retry a non-retryable quota 429 on the streaming path', async () => {
    const adapter = new FailingAdapter(Infinity, () => rateLimit(undefined, 'insufficient_quota', false));
    const membrane = new Membrane(adapter, { retry: { retryDelayMs: 1 } });

    await expect(membrane.stream(zzRequest, { onChunk: () => {} })).rejects.toThrow('zz-provider rate limit reached');
    expect(adapter.streamCalls).toBe(1);
  });
});
