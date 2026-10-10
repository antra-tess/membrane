/**
 * Retry honesty: what the server said, and what membrane waits.
 *
 * `ErrorInfo.retryAfterMs` existed, was surfaced on MembraneError, and was
 * populated by five adapters — but calculateRetryDelay never received the
 * error, so a 429 saying "wait 60s" was answered with five attempts inside
 * ~15s, burning the whole budget inside the server's stated window.
 *
 * The companion asymmetry: complete() forced five attempts on any 429 while
 * stream() retried none of them, though a 429 arriving INSTEAD of a stream is
 * exactly as transparent to retry as the 529 membrane already retries there.
 */

import { describe, it, expect } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { MockAdapter } from '../../src/providers/mock.js';
import { MembraneError } from '../../src/types/errors.js';
import type { NormalizedRequest } from '../../src/types/index.js';
import type { ProviderRequest, ProviderRequestOptions, ProviderResponse } from '../../src/types/provider.js';
import type { StreamCallbacks } from '../../src/types/streaming.js';

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

describe('calculateRetryDelay honors retry-after (MAJOR-2)', () => {
  it('waits at least the server-stated window instead of the backoff', async () => {
    const adapter = new FailingAdapter(1, () => rateLimit(180));
    adapter.queueResponse('zz-recovered');
    const membrane = new Membrane(adapter, { retry: { maxRetries: 2, retryDelayMs: 1, maxRetryDelayMs: 30_000 } });

    const startedAt = Date.now();
    const response = await membrane.complete(zzRequest);
    const elapsedMs = Date.now() - startedAt;

    expect(adapter.completeCalls).toBe(2);
    expect(response.content[0]).toMatchObject({ type: 'text', text: 'zz-recovered' });
    expect(elapsedMs).toBeGreaterThanOrEqual(150);
  });

  it('still clamps to maxRetryDelayMs when the server asks for longer', async () => {
    const adapter = new FailingAdapter(1, () => rateLimit(60_000));
    adapter.queueResponse('zz-recovered');
    const membrane = new Membrane(adapter, { retry: { maxRetries: 2, retryDelayMs: 1, maxRetryDelayMs: 40 } });

    const startedAt = Date.now();
    await membrane.complete(zzRequest);
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(2_000);
  });

  it('keeps the plain backoff when no retry-after was sent', async () => {
    const adapter = new FailingAdapter(1, () => rateLimit(undefined));
    adapter.queueResponse('zz-recovered');
    const membrane = new Membrane(adapter, { retry: { maxRetries: 2, retryDelayMs: 1, maxRetryDelayMs: 30_000 } });

    const startedAt = Date.now();
    await membrane.complete(zzRequest);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('honors retry-after on the streaming retry path too', async () => {
    const adapter = new FailingAdapter(1, () => rateLimit(180));
    adapter.queueResponse('zz-recovered');
    const membrane = new Membrane(adapter, { retry: { maxRetries: 2, retryDelayMs: 1, maxRetryDelayMs: 30_000 } });

    const startedAt = Date.now();
    await membrane.stream(zzRequest, { onChunk: () => {} });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(150);
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
