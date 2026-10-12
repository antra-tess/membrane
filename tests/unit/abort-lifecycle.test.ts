import { MembraneNotReadyError, TimeoutAbortError } from '../../src/types/errors.js';
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

import { describe, it, expect, vi } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import type { BuildOptions, BuildResult } from '../../src/formatters/types.js';
import { MembraneError, serverError, isAbortedResponse } from '../../src/types/index.js';
import type { NormalizedMessage, NormalizedRequest, StreamEvent } from '../../src/types/index.js';
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
  calls = 0;
  /** Resolves once a provider call is under way. */
  readonly entered: Promise<void>;
  private markEntered!: () => void;

  constructor() {
    this.entered = new Promise<void>((resolve) => {
      this.markEntered = resolve;
    });
  }

  supportsModel(): boolean {
    return true;
  }

  private untilAborted(options?: ProviderRequestOptions): Promise<never> {
    this.calls++;
    this.markEntered();
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

/**
 * Every round stops on a stop sequence inside a block the model opened, so
 * the XML loop resumes round after round until something stops it.
 */
class ResumingXmlAdapter implements ProviderAdapter {
  readonly name = 'zz-resuming-xml';
  calls = 0;

  supportsModel(): boolean {
    return true;
  }

  async complete(): Promise<ProviderResponse> {
    throw new Error('not used');
  }

  async stream(request: ProviderRequest, callbacks: StreamCallbacks): Promise<ProviderResponse> {
    const round = this.calls++;
    const text = round === 0
      ? '<function_calls>\n<invoke name="zz_never">'
      : `zz round ${round} keeps making real progress, comfortably past the stall threshold`;
    callbacks.onChunk(text);
    return {
      content: [{ type: 'text', text }] as never,
      stopReason: 'stop_sequence' as never,
      stopSequence: '\nUser:',
      usage: { inputTokens: 10, outputTokens: 5 },
      model: request.model,
      rawRequest: request,
      raw: {},
    };
  }
}

/** A formatter whose build reports an unfinished tool cycle. */
class ZzNotReadyFormatter extends NativeFormatter {
  buildMessages(messages: NormalizedMessage[], options: BuildOptions): BuildResult {
    return { ...super.buildMessages(messages, options), ready: false };
  }
}

const REQUEST: NormalizedRequest = {
  messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz hello' }] }],
  config: { model: 'zz-model', maxTokens: 100 },
};

/**
 * The XML path, selected explicitly: on the default formatter, a request
 * without `toolMode` resolves native (resolveToolMode), so REQUEST alone
 * never reaches streamWithXmlTools or runXmlToolsYielding.
 */
const XML_REQUEST: NormalizedRequest = { ...REQUEST, toolMode: 'xml' };

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
    // One attempt ran, so the abort landed in the sleep after it.
    expect(adapter.calls).toBe(1);
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
    expect((error as MembraneError).retryable).toBe(false);
    expect(adapter.calls).toBe(1);
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
      const adapter = new OverloadedAdapter();
      const result = await new Membrane(adapter, SLOW_BACKOFF).stream(REQUEST, { signal: controller.signal });
      expect(isAbortedResponse(result)).toBe(true);
      expect((result as { reason: string }).reason).toBe('user');
      expect(adapter.calls).toBe(1);
    });

    it(`complete() rejects with an abort MembraneError for ${label}, keeping the reason`, async () => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(reason), 10);
      const adapter = new OverloadedAdapter();
      const error = await new Membrane(adapter, SLOW_BACKOFF)
        .complete(REQUEST, { signal: controller.signal })
        .then(() => undefined, (e: unknown) => e);
      expect(error).toBeInstanceOf(MembraneError);
      expect((error as MembraneError).type).toBe('abort');
      expect((error as MembraneError).retryable).toBe(false);
      expect(adapter.calls).toBe(1);
      const raw = (error as MembraneError).rawError;
      if (typeof reason === 'string') expect(raw).toBe(reason);
      else expect(raw).toMatchObject({ message: 'aborted by caller' });
    });
  }
});

describe('abort reason reflects the cause', () => {
  it('reports a request timeout as timeout, not as a user cancellation (XML path)', async () => {
    const result = await new Membrane(new TimingOutAdapter()).stream(XML_REQUEST, {});
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
    for (const request of [XML_REQUEST, NATIVE_REQUEST]) {
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

/** A caller's signal aborted at 10ms with a string reason, as agent-framework's abortInference(reason) aborts when its caller gives one. */
function abortedWithString(): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort('cancelled by agent'), 10);
  return controller.signal;
}

describe("a caller's own signal is a cancellation on every path, whatever it was aborted with", () => {
  // The caller's signal is authoritative. fetch rejects with the signal's
  // reason: AbortSignal.timeout() gives a TimeoutError, and abort(reason)
  // gives the reason itself (agent-framework passes its caller's reason, a
  // string, when one is given). Judging either by its type would be
  // classification by name, one layer up from classification by text.
  it('premise: the fake rejects as fetch does, with a TimeoutError named for the caller’s own deadline', async () => {
    const signal = AbortSignal.timeout(10);
    const reason = await new SignalReasonAdapter().complete({} as ProviderRequest, { signal }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(reason).toBeInstanceOf(DOMException);
    expect((reason as DOMException).name).toBe('TimeoutError');
  });

  for (const [why, signal] of [
    ['a deadline (AbortSignal.timeout)', () => AbortSignal.timeout(10)],
    ['a string reason', abortedWithString],
  ] as const) {
    for (const [label, request] of [['XML', XML_REQUEST], ['native', NATIVE_REQUEST]] as const) {
      it(`stream() returns AbortedResponse{reason:'user'} for ${why} (${label} path)`, async () => {
        const result = await new Membrane(new SignalReasonAdapter()).stream(request, { signal: signal() });
        expect(isAbortedResponse(result)).toBe(true);
        expect((result as { reason: string }).reason).toBe('user');
      });

      it(`streamYielding() emits one aborted with reason 'user' for ${why} (${label} path)`, async () => {
        const events: StreamEvent[] = [];
        for await (const event of new Membrane(new SignalReasonAdapter()).streamYielding(request, { signal: signal() })) {
          events.push(event);
        }
        const aborted = events.filter((e) => e.type === 'aborted');
        expect(aborted).toHaveLength(1);
        expect((aborted[0] as { reason: string }).reason).toBe('user');
      });
    }

    it(`complete() rejects with an abort MembraneError for ${why}`, async () => {
      const error = await new Membrane(new SignalReasonAdapter())
        .complete(REQUEST, { signal: signal() })
        .then(() => undefined, (e: unknown) => e);
      expect(error).toBeInstanceOf(MembraneError);
      expect((error as MembraneError).type).toBe('abort');
      expect((error as MembraneError).retryable).toBe(false);
    });
  }
});

describe('a cancelled yielding stream reports one abort', () => {
  // cancel() emits aborted itself, and then the work it cancelled fails: a
  // pending tool wait rejects with a plain Error, and an in-flight provider
  // call rejects with its signal's AbortError. The catch must not report the
  // same cancellation again.
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
    // The deadline found the stream waiting on its tools: the abort follows
    // the tool calls, with nothing between them.
    expect(events.map((e) => e.type).slice(-2)).toEqual(['tool-calls', 'aborted']);
    expect(aborted).toHaveLength(1);
    expect((aborted[0] as { reason: string }).reason).toBe('user');
  });

  for (const [label, request] of [['XML', XML_REQUEST], ['native', NATIVE_REQUEST]] as const) {
    it(`streamYielding() emits exactly one aborted when the consumer cancels mid-request (${label} path)`, async () => {
      const adapter = new SignalReasonAdapter();
      const stream = new Membrane(adapter).streamYielding(request, {});
      // Cancel once the provider call is under way, so its rejection follows.
      void adapter.entered.then(() => stream.cancel());
      const events: StreamEvent[] = [];
      // A consumer that takes its time with each event, as an agent loop
      // does, is still reading when the provider's rejection arrives.
      for await (const event of stream) {
        events.push(event);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const aborted = events.filter((e) => e.type === 'aborted');
      expect(aborted).toHaveLength(1);
      expect((aborted[0] as { reason: string }).reason).toBe('user');
      expect(events.some((e) => e.type === 'error')).toBe(false);
      expect(adapter.calls).toBe(1);
    });
  }

  it('streamYielding() emits exactly one aborted when the consumer cancels right after providing tool results (native path)', async () => {
    const adapter = new ToolRoundAdapter();
    const stream = new Membrane(adapter).streamYielding(NATIVE_REQUEST, {});
    const events: StreamEvent[] = [];
    for await (const event of stream) {
      events.push(event);
      if (event.type === 'tool-calls') {
        stream.provideToolResults(event.calls.map((call) => ({ toolUseId: call.id, content: 'zz ok' })));
        stream.cancel();
      }
      // Still reading when the loop comes round again after the results.
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(events.filter((e) => e.type === 'aborted')).toHaveLength(1);
    expect(adapter.calls).toBe(1);
  });

  it('streamYielding() emits exactly one aborted when the consumer cancels between rounds (XML path)', async () => {
    const adapter = new ResumingXmlAdapter();
    const stream = new Membrane(adapter).streamYielding(XML_REQUEST, {});
    const events: StreamEvent[] = [];
    let cancelled = false;
    for await (const event of stream) {
      events.push(event);
      if (event.type === 'tokens' && !cancelled) {
        cancelled = true;
        stream.cancel();
      }
    }
    expect(cancelled).toBe(true);
    expect(events.filter((e) => e.type === 'aborted')).toHaveLength(1);
  });
});

describe('a caller signal that fired before streamYielding() was called', () => {
  // An AbortSignal dispatches 'abort' once; a listener added afterwards never
  // hears it.
  for (const [why, signal] of [
    ['abort(reason)', async () => AbortSignal.abort('zz cancelled early')],
    ['an expired AbortSignal.timeout()', async () => {
      const expired = AbortSignal.timeout(1);
      await new Promise((resolve) => setTimeout(resolve, 20));
      return expired;
    }],
  ] as const) {
    for (const [label, request] of [['XML', XML_REQUEST], ['native', NATIVE_REQUEST]] as const) {
      it(`emits one aborted with reason 'user' and calls no provider: ${why} (${label} path)`, async () => {
        const adapter = new SignalReasonAdapter();
        const events: StreamEvent[] = [];
        for await (const event of new Membrane(adapter).streamYielding(request, { signal: await signal() })) {
          events.push(event);
        }
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ type: 'aborted', reason: 'user' });
        expect(adapter.calls).toBe(0);
      });
    }
  }
});

describe('stream() with streaming: false reports a cancellation as its streaming paths do', () => {
  const NON_STREAMING: NormalizedRequest = { ...REQUEST, streaming: false };

  it("returns AbortedResponse{reason:'user'} when the caller's signal fires", async () => {
    const adapter = new SignalReasonAdapter();
    const result = await new Membrane(adapter).stream(NON_STREAMING, { signal: AbortSignal.timeout(10) });
    expect(isAbortedResponse(result)).toBe(true);
    expect((result as { reason: string }).reason).toBe('user');
    expect(adapter.calls).toBe(1);
  });

  it("returns AbortedResponse{reason:'timeout'} for the adapter's own deadline", async () => {
    const result = await new Membrane(new TimingOutAdapter()).stream(NON_STREAMING, {});
    expect(isAbortedResponse(result)).toBe(true);
    expect((result as { reason: string }).reason).toBe('timeout');
  });

  it('still throws a failure that is not a cancellation', async () => {
    const membrane = new Membrane(new OverloadedAdapter(), { retry: { overloaded: { maxRetries: 0 } } });
    await expect(membrane.stream(NON_STREAMING, {})).rejects.toMatchObject({ type: 'server', httpStatus: 529 });
  });
});

describe("complete() judges the caller's signal before a refused build", () => {
  it('rejects with an abort when the caller has cancelled, keeping the refusal as evidence', async () => {
    const adapter = new SignalReasonAdapter();
    const error = await new Membrane(adapter)
      .complete(REQUEST, { signal: AbortSignal.abort('zz cancelled'), formatter: new ZzNotReadyFormatter() })
      .then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(MembraneError);
    expect((error as MembraneError).type).toBe('abort');
    expect((error as MembraneError).retryable).toBe(false);
    expect((error as MembraneError).rawError).toMatchObject({ name: 'MembraneNotReadyError' });
    expect(adapter.calls).toBe(0);
  });

  it('passes the refusal through as it is when the caller has not cancelled', async () => {
    const error = await new Membrane(new SignalReasonAdapter())
      .complete(REQUEST, { formatter: new ZzNotReadyFormatter() })
      .then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(MembraneNotReadyError);
  });
});

describe('retry sleeps leave no listener on the caller signal', () => {
  it('removes each sleep listener when its timer fires', async () => {
    let calls = 0;
    const adapter: ProviderAdapter = {
      name: 'zz-rate-limited-twice',
      supportsModel: () => true,
      async complete(): Promise<ProviderResponse> {
        calls++;
        if (calls <= 2) {
          throw new MembraneError({ type: 'rate_limit', message: 'zz slow down', retryable: true, httpStatus: 429, rawError: undefined });
        }
        return {
          content: [{ type: 'text', text: 'zz done' }] as never,
          stopReason: 'end_turn' as never,
          usage: { inputTokens: 1, outputTokens: 1 },
          raw: {},
        };
      },
      async stream(): Promise<ProviderResponse> {
        throw new Error('not used');
      },
    };
    const signal = new AbortController().signal;
    const added = vi.spyOn(signal, 'addEventListener');
    const removed = vi.spyOn(signal, 'removeEventListener');
    const response = await new Membrane(adapter, { retry: { retryDelayMs: 1, maxRetryDelayMs: 1 } }).complete(REQUEST, { signal });
    expect(response.stopReason).toBe('end_turn');
    const listeners = (spy: typeof added) => spy.mock.calls.filter(([type]) => type === 'abort').map(([, listener]) => listener);
    expect(listeners(added)).toHaveLength(2);
    expect(listeners(removed)).toEqual(listeners(added));
  });
});
