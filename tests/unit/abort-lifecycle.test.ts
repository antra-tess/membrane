import { TimeoutAbortError } from '../../src/types/errors.js';
/**
 * Abort lifecycle honesty (A3 MAJOR-7 and the reason: 'user' hardcoding).
 *
 * Two defects on an otherwise sound abort core:
 *  - an abort landing during the overloaded (529) backoff sleep rejected out
 *    of the retry loop instead of being handled, so whether a cancellation is
 *    a return value or a throw depended on which millisecond it landed in;
 *  - all four catch sites reported reason: 'user' regardless of cause, so an
 *    adapter-side request timeout was told to the caller as a human
 *    cancellation.
 */

import { describe, it, expect } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { MembraneError, serverError, isAbortedResponse } from '../../src/types/index.js';
import type { NormalizedRequest, StreamEvent } from '../../src/types/index.js';
import type {
  ProviderAdapter,
  ProviderRequest,
  ProviderRequestOptions,
  ProviderResponse,
} from '../../src/types/provider.js';
import type { StreamCallbacks } from '../../src/types/streaming.js';

/** Always 529s, so the turn spends its life in the backoff window. */
class OverloadedAdapter implements ProviderAdapter {
  readonly name = 'zz-overloaded';
  calls = 0;

  supportsModel(): boolean {
    return true;
  }

  async complete(): Promise<ProviderResponse> {
    this.calls++;
    throw serverError('Overloaded', 529);
  }

  async stream(): Promise<ProviderResponse> {
    this.calls++;
    throw serverError('Overloaded', 529);
  }
}

/** Mirrors the typed timeout an adapter returns after its deadline expires. */
class TimingOutAdapter implements ProviderAdapter {
  readonly name = 'zz-timing-out';

  supportsModel(): boolean {
    return true;
  }

  async complete(): Promise<ProviderResponse> {
    throw new TimeoutAbortError('Request timed out');
  }

  async stream(_request: ProviderRequest, _callbacks: StreamCallbacks, _options?: ProviderRequestOptions): Promise<ProviderResponse> {
    throw new TimeoutAbortError('Request timed out');
  }
}

const REQUEST: NormalizedRequest = {
  messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz hello' }] }],
  config: { model: 'zz-model', maxTokens: 100 },
};

const NATIVE_REQUEST: NormalizedRequest = {
  ...REQUEST,
  toolMode: 'native',
  tools: [{ name: 'zz_noop', description: 'zz no-op', inputSchema: { type: 'object', properties: {} } }],
};

/** Long enough that an abort 10ms in lands inside the sleep. */
const SLOW_BACKOFF = {
  retry: { overloaded: { maxRetries: 5, retryDelayMs: 400, maxRetryDelayMs: 400 } },
};

describe('abort during the overloaded backoff window', () => {
  it('stream() returns an AbortedResponse, as its docstring promises', async () => {
    const adapter = new OverloadedAdapter();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);

    const result = await new Membrane(adapter, SLOW_BACKOFF).stream(REQUEST, {
      signal: controller.signal,
    });

    expect(isAbortedResponse(result)).toBe(true);
    expect((result as { reason: string }).reason).toBe('user');
  });

  it('complete() rejects with a MembraneError, like every other failure', async () => {
    const adapter = new OverloadedAdapter();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);

    const error = await new Membrane(adapter, SLOW_BACKOFF)
      .complete(REQUEST, { signal: controller.signal })
      .then(
        () => undefined,
        (e: unknown) => e,
      );

    expect(error).toBeInstanceOf(MembraneError);
    expect((error as MembraneError).type).toBe('abort');
  });
});

describe('abort during a retry sleep, whatever the signal was aborted with', () => {
  // AbortController.abort(reason) rejects the sleep with that reason itself:
  // a plain Error or a string is still the caller's cancellation.
  for (const [label, reason] of [
    ['a plain Error', new Error('aborted by caller')],
    ['a string', 'stream error'],
  ] as const) {
    it(`stream() returns an AbortedResponse{reason:'user'} for ${label}`, async () => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(reason), 10);
      const result = await new Membrane(new OverloadedAdapter(), SLOW_BACKOFF).stream(REQUEST, { signal: controller.signal });
      expect(isAbortedResponse(result)).toBe(true);
      expect((result as { reason: string }).reason).toBe('user');
    });

    it(`complete() rejects with an abort MembraneError for ${label}, keeping the reason`, async () => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(reason), 10);
      const error = await new Membrane(new OverloadedAdapter(), SLOW_BACKOFF)
        .complete(REQUEST, { signal: controller.signal })
        .then(() => undefined, (e: unknown) => e);
      expect(error).toBeInstanceOf(MembraneError);
      expect((error as MembraneError).type).toBe('abort');
      const raw = (error as MembraneError).rawError;
      if (typeof reason === 'string') expect(raw).toBe(reason);
      else expect(raw).toMatchObject({ message: 'aborted by caller' });
    });
  }
});

describe('abort reason reflects the cause', () => {
  it('reports a request timeout as timeout, not as a user cancellation (XML path)', async () => {
    const result = await new Membrane(new TimingOutAdapter()).stream(REQUEST, {});
    expect(isAbortedResponse(result)).toBe(true);
    expect((result as { reason: string }).reason).toBe('timeout');
  });

  it('reports a request timeout as timeout on the native path', async () => {
    const result = await new Membrane(new TimingOutAdapter()).stream(NATIVE_REQUEST, {});
    expect(isAbortedResponse(result)).toBe(true);
    expect((result as { reason: string }).reason).toBe('timeout');
  });

  it('still reports a caller cancellation as user', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await new Membrane(new TimingOutAdapter()).stream(REQUEST, {
      signal: controller.signal,
    });
    expect(isAbortedResponse(result)).toBe(true);
    expect((result as { reason: string }).reason).toBe('user');
  });

  it('reports timeout on the yielding paths too', async () => {
    for (const request of [REQUEST, NATIVE_REQUEST]) {
      const events: StreamEvent[] = [];
      for await (const event of new Membrane(new TimingOutAdapter()).streamYielding(request)) {
        events.push(event);
      }
      const aborted = events.find((e) => e.type === 'aborted');
      expect(aborted).toBeDefined();
      expect((aborted as { reason: string }).reason).toBe('timeout');
    }
  });
});
