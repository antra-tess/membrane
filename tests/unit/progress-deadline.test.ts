/**
 * The progress deadline (`progressTimeoutMs`, agent-framework #268).
 *
 * After antra-tess/membrane#94 a body carrying only SSE keepalives renews the
 * Anthropic idle watchdog, so a connection that stays up while the model sends
 * nothing never ends. The progress deadline is renewed only by parsed provider
 * events (`ProviderRequestOptions.onProgress`), one per provider call, so tool
 * waits between calls never count. On expiry the call aborts with the deadline
 * mark and becomes a TimeoutAbortError on every path.
 *
 * Timings are scaled fixture inputs: a deadline of PROGRESS_MS, events or
 * keepalives every TICK_MS, and runs of 4x the deadline, wide enough that a
 * loaded machine doesn't turn them into races.
 */
import { getEventListeners } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { OpenAICompatibleAdapter } from '../../src/providers/openai-compatible.js';
import { OpenAIAdapter } from '../../src/providers/openai.js';
import { GeminiAdapter } from '../../src/providers/gemini.js';
import { OpenAICompletionsAdapter } from '../../src/providers/openai-completions.js';
import { OpenRouterAdapter } from '../../src/providers/openrouter.js';
import { OpenAIResponsesAPIAdapter } from '../../src/providers/openai-responses-api.js';
import { BedrockAdapter } from '../../src/providers/bedrock.js';
import { MockAdapter } from '../../src/providers/mock.js';
import { rawSseResponse } from '../helpers/sse-fixtures.js';
import { chunkFrame, streamBody } from '../helpers/bedrock-event-stream.js';
import { createCombinedSignal, createProgressDeadline, isDeadlineAbort, deadlineTimeoutError } from '../../src/providers/utils.js';
import { TimeoutAbortError, isAbortedResponse } from '../../src/types/index.js';
import type { NormalizedRequest, StreamEvent } from '../../src/types/index.js';
import type { ProviderAdapter, ProviderRequest, ProviderRequestOptions, ProviderResponse } from '../../src/types/provider.js';
import type { StreamCallbacks } from '../../src/types/streaming.js';

const PROGRESS_MS = 300;
const TICK_MS = 30;
const LIVE_MS = 4 * PROGRESS_MS;

const REQUEST: NormalizedRequest = {
  messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz hello' }] }],
  config: { model: 'claude-sonnet-4-6', maxTokens: 100 },
};
/** The prefill (XML tool) path; plain requests default to the native path. */
const XML_REQUEST: NormalizedRequest = { ...REQUEST, toolMode: 'xml' };
const NATIVE_REQUEST: NormalizedRequest = {
  ...REQUEST,
  toolMode: 'native',
  tools: [{ name: 'zz_probe', description: 'zz probe', inputSchema: { type: 'object', properties: { fld1: { type: 'string' } } } }],
};

// ---------------------------------------------------------------------------
// A live response body the test scripts over time; records transport teardown.
// ---------------------------------------------------------------------------

interface Io {
  emit(text: string): void;
  sleep(ms: number): Promise<void>;
  close(): void;
  isDone(): boolean;
  untilDone(): Promise<void>;
}
const torn: boolean[] = [];

function liveResponse(init: RequestInit | undefined, script: (io: Io) => Promise<void>): Response {
  const encoder = new TextEncoder();
  const index = torn.push(false) - 1;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let done = false;
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const stop = (error?: Error): void => {
    if (done) return;
    done = true;
    release();
    try { if (error) controller.error(error); else controller.close(); } catch { /* already settled */ }
  };
  const body = new ReadableStream<Uint8Array>({
    start(c) { controller = c; },
    cancel() { torn[index] = true; done = true; release(); },
  });
  // The platform's fetch rejects a body read with the signal's own reason
  // (pinned against a real server in adapter-timeout-identity.test.ts).
  init?.signal?.addEventListener('abort', () => {
    torn[index] = true;
    stop(init.signal!.reason as Error);
  }, { once: true });
  void script({
    emit: (text) => { if (!done) { try { controller.enqueue(encoder.encode(text)); } catch { /* closed */ } } },
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    close: () => stop(),
    isDone: () => done,
    untilDone: () => released,
  }).catch(() => {});
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_fixture' } });
}

function stubFetch(respond: (init: RequestInit, call: number) => Response | Promise<Response>): RequestInit[] {
  const calls: RequestInit[] = [];
  vi.stubGlobal('fetch', async (_input: unknown, init: RequestInit) => {
    calls.push(init);
    return respond(init, calls.length - 1);
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  torn.length = 0;
});

// Anthropic SSE, through the real SDK parser (which drops `ping` events).
const message = {
  id: 'msg_test', type: 'message', role: 'assistant', model: REQUEST.config.model,
  content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 },
};
const frame = (event: string, data: object): string => `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`;
const ping = (): string => frame('ping', {});
const messageStart = (): string => frame('message_start', { message });
const textAnswer = (text: string): string[] => [
  frame('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
  frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }),
  frame('content_block_stop', { index: 0 }),
  frame('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }),
  frame('message_stop', {}),
];
const anthropic = (): AnthropicAdapter => new AnthropicAdapter({ apiKey: 'sk-test', cacheKeepalive: { enabled: false } });

async function keepalives(io: Io, emit: () => string, ms: number): Promise<void> {
  for (let elapsed = 0; elapsed < ms && !io.isDone(); elapsed += TICK_MS) {
    io.emit(emit());
    await io.sleep(TICK_MS);
  }
}

async function collect(stream: AsyncIterable<StreamEvent>, onEvent?: (event: StreamEvent) => void): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
    onEvent?.(event);
  }
  return events;
}

// ---------------------------------------------------------------------------

describe('createProgressDeadline', () => {
  it('aborts with the deadline mark, naming itself and when the call began, when nothing renews it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-14T12:00:00.000Z'));
    const deadline = createProgressDeadline(undefined, 1000);
    vi.advanceTimersByTime(999);
    expect(deadline.signal!.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(deadline.signal!.aborted).toBe(true);
    expect(isDeadlineAbort(deadline.signal!.reason)).toBe(true);
    const error = deadlineTimeoutError(deadline.signal!.reason);
    expect(error).toBeInstanceOf(TimeoutAbortError);
    expect(error.type).toBe('timeout');
    expect(error.message).toBe(
      'No provider progress within 1000ms: the call began at 2026-10-14T12:00:00.000Z, provider events: 0',
    );
    deadline.cleanup();
  });

  it('says in its message how many events the call had and when the last came', () => {
    // A log that keeps only the message can tell a call that stopped partway
    // from one that never produced an event (the case above).
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-14T12:00:00.000Z'));
    const deadline = createProgressDeadline(undefined, 1000);
    vi.advanceTimersByTime(200);
    deadline.renew!();
    vi.advanceTimersByTime(300);
    deadline.renew!();
    vi.advanceTimersByTime(1000);
    expect(deadline.signal!.aborted).toBe(true);
    expect(deadlineTimeoutError(deadline.signal!.reason).message).toBe(
      'No provider progress within 1000ms: the call began at 2026-10-14T12:00:00.000Z, ' +
      'provider events: 2, the last at 2026-10-14T12:00:00.500Z',
    );
    deadline.cleanup();
  });

  it('stays open while renewed, and expires a full period after the last renewal', () => {
    vi.useFakeTimers();
    const deadline = createProgressDeadline(undefined, 1000);
    for (let i = 0; i < 12; i++) {
      vi.advanceTimersByTime(400);
      deadline.renew!();
    }
    expect(deadline.signal!.aborted).toBe(false);
    vi.advanceTimersByTime(999);
    expect(deadline.signal!.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(deadline.signal!.aborted).toBe(true);
    deadline.cleanup();
  });

  it("passes the caller's cancellation through unmarked, and stops after cleanup", () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const cancelled = createProgressDeadline(caller.signal, 1000);
    const reason = new Error('caller');
    caller.abort(reason);
    expect(cancelled.signal!.reason).toBe(reason);
    expect(isDeadlineAbort(cancelled.signal!.reason)).toBe(false);
    cancelled.cleanup();

    const cleaned = createProgressDeadline(undefined, 1000);
    cleaned.cleanup();
    vi.advanceTimersByTime(5000);
    expect(cleaned.signal!.aborted).toBe(false);
  });

  it("is aborted at once, unmarked, when the caller's signal already was", () => {
    const caller = new AbortController();
    const reason = new Error('caller');
    caller.abort(reason);
    const deadline = createProgressDeadline(caller.signal, 1000);
    expect(deadline.signal!.aborted).toBe(true);
    expect(deadline.signal!.reason).toBe(reason);
    expect(isDeadlineAbort(deadline.signal!.reason)).toBe(false);
    deadline.cleanup();
  });

  it("lets go of the caller's signal at cleanup", () => {
    // A resident's signal outlives many calls: each call's listener must go
    // with its call.
    const caller = new AbortController();
    const deadline = createProgressDeadline(caller.signal, 1000);
    expect(getEventListeners(caller.signal, 'abort')).toHaveLength(1);
    deadline.cleanup();
    expect(getEventListeners(caller.signal, 'abort')).toHaveLength(0);
    caller.abort(new Error('caller'));
    expect(deadline.signal!.aborted).toBe(false);
  });

  it('measures silence on the monotonic clock, so a step of the system clock moves no expiry', () => {
    // vitest's fake timers move performance.now() and Date together;
    // setSystemTime moves Date alone, as an NTP step or a VM restore does.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-14T12:00:00.000Z'));
    const forward = createProgressDeadline(undefined, 1000);
    vi.advanceTimersByTime(500);
    forward.renew!();
    vi.setSystemTime(new Date('2026-10-14T13:00:00.000Z'));
    vi.advanceTimersByTime(999);
    expect(forward.signal!.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(forward.signal!.aborted).toBe(true);
    // The message's times are the wall clock's: the renewal came before the step.
    expect(deadlineTimeoutError(forward.signal!.reason).message).toBe(
      'No provider progress within 1000ms: the call began at 2026-10-14T12:00:00.000Z, ' +
      'provider events: 1, the last at 2026-10-14T12:00:00.500Z',
    );
    forward.cleanup();

    const backward = createProgressDeadline(undefined, 1000);
    vi.setSystemTime(new Date('2026-10-14T11:00:00.000Z'));
    vi.advanceTimersByTime(1000);
    expect(backward.signal!.aborted).toBe(true);
    backward.cleanup();
  });

  it('without a timeout passes the caller signal through and offers no renew', () => {
    const caller = new AbortController();
    const off = createProgressDeadline(caller.signal, undefined);
    expect(off.signal).toBe(caller.signal);
    expect(off.renew).toBeUndefined();
    off.cleanup();
  });
});

// Node runs a timer whose delay is over 2³¹−1 ms, Infinity included, after 1 ms.
describe('deadlines past the platform timer limit', () => {
  const PAST_LIMIT_MS = 3_000_000_000;

  it('a progress deadline of Infinity never expires, and does not re-arm every millisecond', async () => {
    const armed = vi.spyOn(globalThis, 'setTimeout');
    const deadline = createProgressDeadline(undefined, Infinity);
    await new Promise((r) => setTimeout(r, 20));
    expect(deadline.signal!.aborted).toBe(false);
    expect(armed.mock.calls.length).toBeLessThan(5);
    deadline.cleanup();
  });

  it('a progress deadline past the limit expires on time', () => {
    vi.useFakeTimers();
    const armed = vi.spyOn(globalThis, 'setTimeout');
    const deadline = createProgressDeadline(undefined, PAST_LIMIT_MS);
    // A deadline re-armed every millisecond would make the long advance below spin for hours.
    vi.advanceTimersByTime(10);
    expect(armed).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(PAST_LIMIT_MS - 11);
    expect(deadline.signal!.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(deadline.signal!.aborted).toBe(true);
    expect(deadlineTimeoutError(deadline.signal!.reason).message).toMatch(
      new RegExp(`^No provider progress within ${PAST_LIMIT_MS}ms: the call began at \\S+, provider events: 0$`),
    );
    deadline.cleanup();
  });

  it('cleanup partway through a long wait cancels the step that is pending', () => {
    vi.useFakeTimers();
    const armed = vi.spyOn(globalThis, 'setTimeout');
    const deadline = createProgressDeadline(undefined, PAST_LIMIT_MS);
    const combined = createCombinedSignal(undefined, PAST_LIMIT_MS);
    // A deadline re-armed every millisecond would make the long advance below spin for hours.
    vi.advanceTimersByTime(10);
    expect(armed).toHaveBeenCalledTimes(2);
    // Past the first step: each helper has armed its second.
    vi.advanceTimersByTime(2 ** 31 - 10);
    expect(vi.getTimerCount()).toBe(2);
    deadline.cleanup();
    combined.cleanup!();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(PAST_LIMIT_MS);
    expect(deadline.signal!.aborted).toBe(false);
    expect(combined.signal!.aborted).toBe(false);
  });

  it('createCombinedSignal never aborts on a timeout of Infinity', async () => {
    const combined = createCombinedSignal(undefined, Infinity);
    await new Promise((r) => setTimeout(r, 20));
    expect(combined.signal!.aborted).toBe(false);
    combined.cleanup!();
  });

  it('createCombinedSignal aborts a timeout past the limit on time, not at the limit', () => {
    vi.useFakeTimers();
    const combined = createCombinedSignal(undefined, PAST_LIMIT_MS);
    vi.advanceTimersByTime(2 ** 31);
    expect(combined.signal!.aborted).toBe(false);
    vi.advanceTimersByTime(PAST_LIMIT_MS - 2 ** 31 - 1);
    expect(combined.signal!.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(combined.signal!.aborted).toBe(true);
    expect(isDeadlineAbort(combined.signal!.reason)).toBe(true);
    combined.cleanup!();
  });
});

describe('Membrane core: one renewable deadline per provider call', () => {
  class RecordingAdapter extends MockAdapter {
    readonly seen: Array<ProviderRequestOptions | undefined> = [];
    override async stream(request: ProviderRequest, callbacks: StreamCallbacks, options?: ProviderRequestOptions): Promise<ProviderResponse> {
      this.seen.push(options);
      return super.stream(request, callbacks, options);
    }
    override async complete(request: ProviderRequest, options?: ProviderRequestOptions): Promise<ProviderResponse> {
      this.seen.push(options);
      return super.complete(request, options);
    }
  }

  it('gives the adapter onProgress and a deadline signal only when progressTimeoutMs is set', async () => {
    const on = new RecordingAdapter();
    await new Membrane(on).stream(XML_REQUEST, { progressTimeoutMs: 60_000 });
    await new Membrane(on).stream(NATIVE_REQUEST, { progressTimeoutMs: 60_000 });
    await new Membrane(on).complete(REQUEST, { progressTimeoutMs: 60_000 });
    for await (const _ of new Membrane(on).streamYielding(XML_REQUEST, { progressTimeoutMs: 60_000 })) { /* drain */ }
    for await (const _ of new Membrane(on).streamYielding(NATIVE_REQUEST, { progressTimeoutMs: 60_000 })) { /* drain */ }
    expect(on.seen).toHaveLength(5);
    for (const options of on.seen) {
      expect(typeof options?.onProgress).toBe('function');
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      // Core keeps the option to itself.
      expect(options !== undefined && 'progressTimeoutMs' in options).toBe(false);
    }

    const off = new RecordingAdapter();
    const caller = new AbortController();
    await new Membrane(off).stream(REQUEST, { signal: caller.signal });
    await new Membrane(off).complete(REQUEST, { signal: caller.signal });
    for await (const _ of new Membrane(off).streamYielding(REQUEST, { signal: caller.signal })) { /* drain */ }
    expect(off.seen).toHaveLength(3);
    for (const options of off.seen) {
      expect(options?.onProgress).toBeUndefined();
      expect(options !== undefined && 'progressTimeoutMs' in options).toBe(false);
    }
    expect(off.seen[0]?.signal).toBe(caller.signal);
    expect(off.seen[1]?.signal).toBe(caller.signal);
  });

  it('gives each refusal re-issue a deadline of its own, and lets go of the caller as each call returns', async () => {
    // Each attempt is silent for three quarters of the deadline, so one
    // deadline shared by both attempts would expire during the second.
    vi.useFakeTimers();
    class RefusesOnce implements ProviderAdapter {
      readonly name = 'zz-refuses-once';
      calls = 0;
      readonly signals: AbortSignal[] = [];
      supportsModel(): boolean { return true; }
      private async attempt(request: ProviderRequest, options?: ProviderRequestOptions): Promise<ProviderResponse> {
        const refusing = this.calls++ % 2 === 0;
        const signal = options!.signal!;
        this.signals.push(signal);
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 750);
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(isDeadlineAbort(signal.reason) ? deadlineTimeoutError(signal.reason) : signal.reason);
          }, { once: true });
        });
        return {
          content: [{ type: 'text', text: refusing ? 'zz refused' : 'zz answer' }],
          stopReason: refusing ? 'refusal' : 'end_turn',
          usage: { inputTokens: 10, outputTokens: 2 },
          model: request.model,
          rawRequest: request,
          raw: {},
        } as unknown as ProviderResponse;
      }
      async complete(request: ProviderRequest, options?: ProviderRequestOptions): Promise<ProviderResponse> {
        return this.attempt(request, options);
      }
      async stream(request: ProviderRequest, _callbacks: StreamCallbacks, options?: ProviderRequestOptions): Promise<ProviderResponse> {
        return this.attempt(request, options);
      }
    }

    const caller = new AbortController();
    const viaComplete = new RefusesOnce();
    const completed = new Membrane(viaComplete).complete(REQUEST, { progressTimeoutMs: 1000, refusalRetries: 1, signal: caller.signal });
    await vi.advanceTimersByTimeAsync(1600);
    const response = await completed;
    expect(viaComplete.calls).toBe(2);
    expect(response.content).toEqual([{ type: 'text', text: 'zz answer' }]);
    expect(viaComplete.signals[0]).not.toBe(viaComplete.signals[1]);
    expect(getEventListeners(caller.signal, 'abort')).toHaveLength(0);

    const viaStream = new RefusesOnce();
    const events: StreamEvent[] = [];
    const collecting = collect(new Membrane(viaStream).streamYielding(NATIVE_REQUEST, { progressTimeoutMs: 1000, refusalRetries: 1 }), (e) => events.push(e));
    await vi.advanceTimersByTimeAsync(1600);
    await collecting;
    expect(viaStream.calls).toBe(2);
    expect(events.filter((e) => e.type === 'aborted')).toEqual([]);
    expect(events.some((e) => e.type === 'complete')).toBe(true);
    expect(viaStream.signals[0]).not.toBe(viaStream.signals[1]);

    // stream() has no refusal re-issue; its one call lets go of the caller too.
    const once = new RefusesOnce();
    once.calls = 1;
    const streamed = new Membrane(once).stream(REQUEST, { progressTimeoutMs: 1000, signal: caller.signal });
    await vi.advanceTimersByTimeAsync(800);
    expect(isAbortedResponse(await streamed)).toBe(false);
    expect(getEventListeners(caller.signal, 'abort')).toHaveLength(0);
  });

  it('keeps a mock stream alive while its chunks come faster than the deadline', async () => {
    const steady = new MockAdapter({ defaultResponse: 'zz one two three four', streamChunkSize: 3, streamChunkDelayMs: PROGRESS_MS / 6 });
    const result = await new Membrane(steady).stream(REQUEST, { progressTimeoutMs: PROGRESS_MS });
    expect(isAbortedResponse(result)).toBe(false);
  });

  it('ends a mock stream whose chunks come slower than the deadline, as a timeout', async () => {
    const slow = new MockAdapter({ defaultResponse: 'zz one two three', streamChunkSize: 4, streamChunkDelayMs: 4 * PROGRESS_MS });
    const result = await new Membrane(slow).stream(REQUEST, { progressTimeoutMs: PROGRESS_MS });
    expect(isAbortedResponse(result)).toBe(true);
    expect((result as { reason: string }).reason).toBe('timeout');
  });
});

describe('Anthropic: the deadline follows SDK events, not keepalives', () => {
  it('ends a stream that carries only pings after message_start, as a timeout', async () => {
    stubFetch((init) => liveResponse(init, async (io) => {
      io.emit(messageStart());
      await keepalives(io, ping, 20 * LIVE_MS);
    }));
    const result = await new Membrane(anthropic()).stream(REQUEST, { progressTimeoutMs: PROGRESS_MS });
    // An aborted response with reason 'timeout' comes only from the deadline's
    // mark: the idle watchdog throws a retryable timeout instead.
    expect(isAbortedResponse(result)).toBe(true);
    expect((result as { reason: string }).reason).toBe('timeout');
    expect(torn[0]).toBe(true);
  });

  it('keeps a long tool-input stream alive though it fires no callback, and a tool wait never counts', async () => {
    stubFetch((init, call) => liveResponse(init, async (io) => {
      io.emit(messageStart());
      if (call === 0) {
        io.emit(frame('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_zz1', name: 'zz_probe', input: {} } }));
        io.emit(frame('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"fld1":"' } }));
        await keepalives(io, () => frame('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: 'x' } }), LIVE_MS);
        io.emit(frame('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '"}' } }));
        io.emit(frame('content_block_stop', { index: 0 }));
        io.emit(frame('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 40 } }));
        io.emit(frame('message_stop', {}));
      } else {
        for (const part of textAnswer('zz done')) io.emit(part);
      }
      io.close();
    }));
    const stream = new Membrane(anthropic()).streamYielding(NATIVE_REQUEST, { progressTimeoutMs: PROGRESS_MS });
    const events = await collect(stream, (event) => {
      if (event.type !== 'tool-calls') return;
      // A tool that takes several deadlines to run: time outside a provider call.
      setTimeout(() => stream.provideToolResults([{ toolUseId: event.calls[0]!.id, content: 'zz ok' }]), 3 * PROGRESS_MS);
    });
    expect(events.filter((e) => e.type === 'aborted')).toEqual([]);
    expect(events.some((e) => e.type === 'tool-calls')).toBe(true);
    expect(events.some((e) => e.type === 'complete')).toBe(true);
  });

  it('reports a stalled yielding round as aborted with reason timeout', async () => {
    stubFetch((init) => liveResponse(init, async (io) => {
      io.emit(messageStart());
      await keepalives(io, ping, 20 * LIVE_MS);
    }));
    const events = await collect(new Membrane(anthropic()).streamYielding(REQUEST, { progressTimeoutMs: PROGRESS_MS }));
    const aborted = events.filter((e) => e.type === 'aborted');
    expect(aborted).toHaveLength(1);
    expect((aborted[0] as { reason: string }).reason).toBe('timeout');
  });

  it('bounds a non-streaming call whose response never comes, and names the deadline', async () => {
    stubFetch((init) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    const error = await new Membrane(anthropic())
      .complete(REQUEST, { progressTimeoutMs: PROGRESS_MS })
      .then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(TimeoutAbortError);
    expect((error as TimeoutAbortError).message).toMatch(
      new RegExp(`^No provider progress within ${PROGRESS_MS}ms: the call began at \\S+, provider events: 0$`),
    );
  });
});

describe('every streaming adapter reports progress once per parsed event', () => {
  // The end-to-end cases above drive two adapters through Membrane. The call
  // lives in each adapter's own parser, so the family fact is pinned here:
  // three events that parse count; comments, keepalives and data that doesn't
  // parse don't, and neither does `data: null` on the adapters that drop it.
  // Each body then ends without a terminal event, which is fine: only the
  // count matters.
  const sseBody = [
    ': comment\n\n',
    'data: {"zz":1}\n\n',
    ': keepalive\n\n',
    'data: {"zz":2}\n\n',
    'data: not json\n\n',
    'data: {"zz":3}\n\n',
  ];
  const dropsNull = new Set(['openai', 'gemini', 'openai-completions', 'openai-compatible', 'openrouter']);
  const adapters: Array<[string, () => { stream: (...args: never[]) => Promise<unknown> }]> = [
    ['openai', () => new OpenAIAdapter({ apiKey: 'zz-not-a-key' })],
    ['gemini', () => new GeminiAdapter({ apiKey: 'zz-not-a-key' })],
    ['openai-completions', () => new OpenAICompletionsAdapter({ baseURL: 'http://zz-host.invalid/v1', apiKey: 'zz-not-a-key' })],
    ['openai-compatible', () => new OpenAICompatibleAdapter({ baseURL: 'http://zz-host.invalid/v1', apiKey: 'zz-not-a-key' })],
    ['openrouter', () => new OpenRouterAdapter({ apiKey: 'zz-not-a-key' })],
    ['openai-responses-api', () => new OpenAIResponsesAPIAdapter({ apiKey: 'zz-not-a-key' })],
  ] as never;

  for (const [name, build] of adapters) {
    it(`${name}: three data frames, three reports`, async () => {
      stubFetch(() => rawSseResponse(dropsNull.has(name) ? [...sseBody, 'data: null\n\n'] : sseBody));
      let progress = 0;
      const adapter = build() as unknown as {
        stream: (request: unknown, callbacks: unknown, options: ProviderRequestOptions) => Promise<unknown>;
      };
      await adapter
        .stream(
          { model: 'zz-model', messages: [{ role: 'user', content: 'zz hello' }], maxTokens: 16 },
          { onChunk: () => {} },
          { onProgress: () => { progress++; } },
        )
        .catch(() => undefined);
      expect(progress).toBe(3);
    });
  }

  it('bedrock: decoded events count, pings and an event that decodes to null do not', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubFetch(() => new Response(streamBody([
      chunkFrame({ type: 'message_start', message: { usage: { input_tokens: 3 } } }),
      chunkFrame({ type: 'ping' }),
      chunkFrame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      chunkFrame({ type: 'ping' }),
      chunkFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'zz' } }),
      chunkFrame(null),
    ]), { status: 200 }));
    let progress = 0;
    await new BedrockAdapter({ accessKeyId: 'zz-not-a-key-id', secretAccessKey: 'zz-not-a-secret', region: 'zz-region-1' })
      .stream(
        { model: 'anthropic.claude-sonnet-4-6', messages: [{ role: 'user', content: 'zz hello' }], maxTokens: 16 } as never,
        { onChunk: () => {} },
        { onProgress: () => { progress++; } },
      )
      .catch(() => undefined);
    expect(progress).toBe(3);
  });
});

describe('SSE adapters: data frames renew the deadline, comments do not', () => {
  const sse = (): OpenAICompatibleAdapter =>
    new OpenAICompatibleAdapter({ baseURL: 'http://zz-host.invalid/v1', apiKey: 'zz-not-a-key' });
  const data = (payload: object): string => `data: ${JSON.stringify(payload)}\n\n`;
  const delta = (content: string): string => data({ choices: [{ index: 0, delta: { content } }] });
  const finish = (): string[] => [data({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }), 'data: [DONE]\n\n'];

  it('ends a stream that sends only comments after its first frame, as a timeout', async () => {
    stubFetch((init) => liveResponse(init, async (io) => {
      io.emit(delta('zz'));
      await keepalives(io, () => ': keepalive\n\n', 20 * LIVE_MS);
    }));
    const result = await new Membrane(sse()).stream(REQUEST, { progressTimeoutMs: PROGRESS_MS });
    expect(isAbortedResponse(result)).toBe(true);
    expect((result as { reason: string }).reason).toBe('timeout');
    expect(torn[0]).toBe(true);
  });

  it('keeps a slow stream of data frames alive past the deadline', async () => {
    stubFetch((init) => liveResponse(init, async (io) => {
      await keepalives(io, () => delta('z'), LIVE_MS);
      for (const part of finish()) io.emit(part);
      io.close();
    }));
    const result = await new Membrane(sse()).stream(REQUEST, { progressTimeoutMs: PROGRESS_MS });
    expect(isAbortedResponse(result)).toBe(false);
  });
});
