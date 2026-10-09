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

/**
 * Rejects the way fetch does when the caller's signal fires: with the
 * signal's own reason. For `AbortSignal.timeout()` that is a DOMException
 * named `TimeoutError`, not `AbortError`.
 */
class SignalReasonAdapter implements ProviderAdapter {
  readonly name = 'zz-signal-reason';

  supportsModel(): boolean {
    return true;
  }

  private untilAborted(options?: ProviderRequestOptions): Promise<never> {
    return new Promise((_resolve, reject) => {
      const signal = options?.signal;
      if (!signal) return;
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }

  async complete(_request: ProviderRequest, options?: ProviderRequestOptions): Promise<ProviderResponse> {
    return this.untilAborted(options);
  }

  async stream(_request: ProviderRequest, _callbacks: StreamCallbacks, options?: ProviderRequestOptions): Promise<ProviderResponse> {
    return this.untilAborted(options);
  }
}

/** One native tool round, then (if asked) a final answer. */
class ToolRoundAdapter implements ProviderAdapter {
  readonly name = 'zz-tool-round';
  calls = 0;

  supportsModel(): boolean {
    return true;
  }

  async complete(): Promise<ProviderResponse> {
    throw new Error('not used');
  }

  async stream(_request: ProviderRequest, callbacks: StreamCallbacks): Promise<ProviderResponse> {
    this.calls++;
    if (this.calls === 1) {
      callbacks.onChunk('zz checking');
      return {
        content: [{ type: 'text', text: 'zz checking' }, { type: 'tool_use', id: 'zz-tu-1', name: 'zz_noop', input: {} }] as never,
        stopReason: 'tool_use' as never,
        usage: { inputTokens: 10, outputTokens: 5 },
        raw: {},
      };
    }
    callbacks.onChunk('zz done');
    return { content: [{ type: 'text', text: 'zz done' }] as never, stopReason: 'end_turn' as never, usage: { inputTokens: 10, outputTokens: 5 }, raw: {} };
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

describe("a caller's own deadline is a cancellation on every path, whatever the error is named", () => {
  // The caller's signal is authoritative: AbortSignal.timeout() fires with a
  // TimeoutError, and naming that a provider timeout would be classification
  // by name, one layer up from classification by text.
  it('rejects in flight with a TimeoutError named for the caller’s own deadline', async () => {
    const signal = AbortSignal.timeout(10);
    const reason = await new SignalReasonAdapter().complete({} as ProviderRequest, { signal }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(reason).toBeInstanceOf(DOMException);
    expect((reason as DOMException).name).toBe('TimeoutError');
  });

  for (const [label, request] of [['XML', REQUEST], ['native', NATIVE_REQUEST]] as const) {
    it(`stream() returns AbortedResponse{reason:'user'} (${label} path)`, async () => {
      const result = await new Membrane(new SignalReasonAdapter()).stream(request, { signal: AbortSignal.timeout(10) });
      expect(isAbortedResponse(result)).toBe(true);
      expect((result as { reason: string }).reason).toBe('user');
    });

    it(`streamYielding() emits aborted with reason 'user' (${label} path)`, async () => {
      const events: StreamEvent[] = [];
      for await (const event of new Membrane(new SignalReasonAdapter()).streamYielding(request, { signal: AbortSignal.timeout(10) })) {
        events.push(event);
      }
      const aborted = events.find((e) => e.type === 'aborted');
      expect(aborted).toBeDefined();
      expect((aborted as { reason: string }).reason).toBe('user');
    });
  }

  it('complete() rejects with an abort MembraneError', async () => {
    const error = await new Membrane(new SignalReasonAdapter())
      .complete(REQUEST, { signal: AbortSignal.timeout(10) })
      .then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(MembraneError);
    expect((error as MembraneError).type).toBe('abort');
    expect((error as MembraneError).retryable).toBe(false);
  });
});

describe('a cancel while the stream waits for tool results reports one abort', () => {
  // cancel() emits aborted itself and rejects the pending tool wait with a
  // plain Error; the catch must not report the same cancellation again.
  it('streamYielding() emits exactly one aborted when the consumer cancels at the tool wait', async () => {
    const stream = new Membrane(new ToolRoundAdapter()).streamYielding(NATIVE_REQUEST, {});
    const events: StreamEvent[] = [];
    for await (const event of stream) {
      events.push(event);
      if (event.type === 'tool-calls') setTimeout(() => stream.cancel(), 10);
    }
    const aborted = events.filter((e) => e.type === 'aborted');
    expect(events.map((e) => e.type)).toContain('tool-calls');
    expect(aborted).toHaveLength(1);
    expect((aborted[0] as { reason: string }).reason).toBe('user');
  });

  it("streamYielding() emits exactly one aborted when the caller's own deadline fires at the tool wait", async () => {
    const stream = new Membrane(new ToolRoundAdapter()).streamYielding(NATIVE_REQUEST, { signal: AbortSignal.timeout(30) });
    const events: StreamEvent[] = [];
    for await (const event of stream) events.push(event);
    const aborted = events.filter((e) => e.type === 'aborted');
    expect(aborted).toHaveLength(1);
    expect((aborted[0] as { reason: string }).reason).toBe('user');
  });
});
