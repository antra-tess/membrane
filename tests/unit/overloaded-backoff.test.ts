/**
 * Overloaded (529) backoff policy: capacity errors always retry on their own
 * long, jittered schedule — in complete() via the shared retry loop, and in
 * stream() via the pre-emission wrapper (Connectome issue #25).
 */

import { describe, it, expect } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { MockAdapter } from '../../src/providers/mock.js';
import { classifyError, isOverloadedError, serverError, rateLimitError } from '../../src/types/errors.js';
import type { NormalizedRequest } from '../../src/types/index.js';
import type { ProviderRequest, ProviderRequestOptions, ProviderResponse } from '../../src/types/provider.js';
import type { StreamCallbacks } from '../../src/types/streaming.js';

/** Fails the first `failures` calls with the given error factory, then
 *  delegates to MockAdapter. `emitBeforeFailure` streams one chunk before
 *  throwing, to exercise the post-emission no-retry rule. */
class FlakyAdapter extends MockAdapter {
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
      if (this.emitBeforeFailure) callbacks.onChunk('partial ');
      throw this.makeError();
    }
    return super.stream(request, callbacks, options);
  }
}

const overloaded529 = () => serverError('Overloaded', 529);

const REQUEST: NormalizedRequest = {
  messages: [{ participant: 'User', content: [{ type: 'text', text: 'hi' }] }],
  config: { model: 'test', maxTokens: 100 },
};

/** Millisecond-scale overloaded schedule so retry tests stay fast. */
const FAST_OVERLOADED = { retry: { overloaded: { retryDelayMs: 1, maxRetryDelayMs: 2 } } };

describe('isOverloadedError', () => {
  it('matches a structured 529', () => {
    expect(isOverloadedError(classifyError(overloaded529()))).toBe(true);
  });

  it('matches the message-classified fallback paths', () => {
    expect(isOverloadedError(classifyError(new Error('529 overloaded_error: Overloaded')))).toBe(true);
    expect(isOverloadedError(classifyError(new Error('upstream returned 529')))).toBe(true);
  });

  it('never matches non-retryable errors, whatever the message says', () => {
    expect(isOverloadedError({ type: 'invalid_request', message: 'overloaded', retryable: false })).toBe(false);
  });

  it('does not match rate limits or plain server errors', () => {
    expect(isOverloadedError(classifyError(rateLimitError('too many requests')))).toBe(false);
    expect(isOverloadedError(classifyError(serverError('Internal server error', 500)))).toBe(false);
  });
});

describe('complete() overloaded retries', () => {
  it('retries through 529s even with default maxRetries of 0', async () => {
    const adapter = new FlakyAdapter(2, overloaded529);
    adapter.queueResponse('recovered');
    const membrane = new Membrane(adapter, FAST_OVERLOADED);
    const response = await membrane.complete(REQUEST);
    expect(adapter.completeCalls).toBe(3);
    expect(response.content[0]).toMatchObject({ type: 'text', text: 'recovered' });
  });

  it('still does not retry plain 500s when maxRetries is 0', async () => {
    const adapter = new FlakyAdapter(1, () => serverError('Internal server error', 500));
    const membrane = new Membrane(adapter, FAST_OVERLOADED);
    await expect(membrane.complete(REQUEST)).rejects.toThrow('Internal server error');
    expect(adapter.completeCalls).toBe(1);
  });

  it('gives up after overloaded.maxRetries total attempts', async () => {
    const adapter = new FlakyAdapter(Infinity, overloaded529);
    const membrane = new Membrane(adapter, {
      retry: { overloaded: { maxRetries: 2, retryDelayMs: 1, maxRetryDelayMs: 2 } },
    });
    await expect(membrane.complete(REQUEST)).rejects.toThrow('Overloaded');
    // maxRetries bounds TOTAL attempts, matching the base/429 semantics.
    expect(adapter.completeCalls).toBe(2);
  });

  it('stream() shares the same attempt bound', async () => {
    const adapter = new FlakyAdapter(Infinity, overloaded529);
    const membrane = new Membrane(adapter, {
      retry: { overloaded: { maxRetries: 2, retryDelayMs: 1, maxRetryDelayMs: 2 } },
    });
    await expect(membrane.stream(REQUEST, {})).rejects.toThrow('Overloaded');
    expect(adapter.streamCalls).toBe(2);
  });

  it('overloaded.maxRetries: 0 opts out entirely', async () => {
    const adapter = new FlakyAdapter(1, overloaded529);
    const membrane = new Membrane(adapter, { retry: { overloaded: { maxRetries: 0 } } });
    await expect(membrane.complete(REQUEST)).rejects.toThrow('Overloaded');
    expect(adapter.completeCalls).toBe(1);
  });

  it('opt-out with positive base retries falls back to base policy, not the long schedule', async () => {
    const adapter = new FlakyAdapter(Infinity, overloaded529);
    const membrane = new Membrane(adapter, {
      retry: { maxRetries: 2, retryDelayMs: 1, maxRetryDelayMs: 2, overloaded: { maxRetries: 0 } },
    });
    await expect(membrane.complete(REQUEST)).rejects.toThrow('Overloaded');
    // With the dedicated policy disabled, the 529 is still a retryable
    // server error under the BASE config (pre-policy behavior), so the
    // base bound of 2 attempts applies — neither zero nor the 529 floor.
    expect(adapter.completeCalls).toBe(2);
  });

  it('runs the onError hook before each overloaded retry and honors abort', async () => {
    const adapter = new FlakyAdapter(Infinity, overloaded529);
    const hookAttempts: number[] = [];
    const membrane = new Membrane(adapter, {
      retry: { overloaded: { retryDelayMs: 1, maxRetryDelayMs: 2 } },
      hooks: {
        onError: (_info, attempt) => {
          hookAttempts.push(attempt);
          return attempt >= 2 ? 'abort' : 'retry';
        },
      },
    });
    await expect(membrane.complete(REQUEST)).rejects.toThrow('Overloaded');
    expect(hookAttempts).toEqual([1, 2]);
    expect(adapter.completeCalls).toBe(2); // stopped by the hook, not the bound
  });
});

describe('stream() overloaded retries', () => {
  it('retries a 529 that arrives before any output', async () => {
    const adapter = new FlakyAdapter(2, overloaded529);
    adapter.queueResponse('recovered');
    const membrane = new Membrane(adapter, FAST_OVERLOADED);
    const chunks: string[] = [];
    const result = await membrane.stream(REQUEST, { onChunk: (text) => { chunks.push(text); } });
    expect(adapter.streamCalls).toBe(3);
    expect('content' in result && result.content[0]).toMatchObject({ type: 'text', text: 'recovered' });
    // Output was delivered exactly once — the failed attempts emitted nothing.
    expect(chunks.join('')).toBe('recovered');
  });

  it('does NOT retry once output has been emitted', async () => {
    const adapter = new FlakyAdapter(1, overloaded529, /* emitBeforeFailure */ true);
    const membrane = new Membrane(adapter, FAST_OVERLOADED);
    const chunks: string[] = [];
    await expect(
      membrane.stream(REQUEST, { onChunk: (text) => { chunks.push(text); } }),
    ).rejects.toThrow('Overloaded');
    expect(adapter.streamCalls).toBe(1);
    expect(chunks.join('')).toBe('partial '); // no replayed content
  });

  it('does not retry non-overloaded stream errors', async () => {
    const adapter = new FlakyAdapter(1, () => serverError('Internal server error', 500));
    const membrane = new Membrane(adapter, FAST_OVERLOADED);
    await expect(membrane.stream(REQUEST, {})).rejects.toThrow('Internal server error');
    expect(adapter.streamCalls).toBe(1);
  });

  it('opt-out disables stream retries even with positive base retries', async () => {
    const adapter = new FlakyAdapter(Infinity, overloaded529);
    const membrane = new Membrane(adapter, {
      retry: { maxRetries: 3, retryDelayMs: 1, maxRetryDelayMs: 2, overloaded: { maxRetries: 0 } },
    });
    await expect(membrane.stream(REQUEST, {})).rejects.toThrow('Overloaded');
    // Streaming had no retry before this policy; disabling the policy
    // restores exactly that, whatever the base config says.
    expect(adapter.streamCalls).toBe(1);
  });

  it('consults the onError hook before each stream retry and honors abort', async () => {
    const adapter = new FlakyAdapter(Infinity, overloaded529);
    const hookAttempts: number[] = [];
    const membrane = new Membrane(adapter, {
      retry: { overloaded: { retryDelayMs: 1, maxRetryDelayMs: 2 } },
      hooks: {
        onError: (_info, attempt) => {
          hookAttempts.push(attempt);
          return attempt >= 2 ? 'abort' : 'retry';
        },
      },
    });
    await expect(membrane.stream(REQUEST, {})).rejects.toThrow('Overloaded');
    expect(hookAttempts).toEqual([1, 2]);
    expect(adapter.streamCalls).toBe(2); // stopped by the hook, not the bound
  });
});
