/**
 * The deadlines Membrane core keeps per provider call when `progressTimeoutMs`
 * is left unset (createCallDeadline): bounds per phase on an adapter that
 * reports them, the bound for an answer that can arrive whole everywhere
 * else, the output budget they're sized from, and the liveness bound
 * (`idleTimeoutMs`). The flat bound a positive `progressTimeoutMs` gives is
 * pinned in progress-deadline.test.ts, and the liveness bound through a live
 * Anthropic body in anthropic-stream-idle.test.ts.
 *
 * The bounds are the real ones (400 s, 180 s, 35 tokens a second), on fake
 * timers, which move performance.now() and Date together.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { BedrockAdapter } from '../../src/providers/bedrock.js';
import { GeminiAdapter } from '../../src/providers/gemini.js';
import { OpenAIAdapter } from '../../src/providers/openai.js';
import { OpenAICompatibleAdapter } from '../../src/providers/openai-compatible.js';
import { OpenAICompletionsAdapter } from '../../src/providers/openai-completions.js';
import { OpenAIResponsesAPIAdapter } from '../../src/providers/openai-responses-api.js';
import { OpenRouterAdapter } from '../../src/providers/openrouter.js';
import { rawSseResponse } from '../helpers/sse-fixtures.js';
import { chunkFrame, streamBody } from '../helpers/bedrock-event-stream.js';
import { createCallDeadline, deadlineTimeoutError, isDeadlineAbort } from '../../src/providers/utils.js';
import { TimeoutAbortError, isAbortedResponse } from '../../src/types/index.js';
import type { NormalizedRequest, ProgressSeen, SendReport } from '../../src/types/index.js';
import type { ProviderAdapter, ProviderRequest, ProviderRequestOptions, ProviderResponse, StreamCallbacks } from '../../src/types/provider.js';

const S = 1000;
const BEGAN = '2026-10-22T12:00:00.000Z';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** The deadline's message once it has run out, or undefined while it's open. */
function expired(deadline: { signal?: AbortSignal }): string | undefined {
  const signal = deadline.signal!;
  if (!signal.aborted) return undefined;
  expect(isDeadlineAbort(signal.reason)).toBe(true);
  return deadlineTimeoutError(signal.reason).message;
}

/** A call's deadlines on fake timers, its adapter reporting at the send that the stream reports its phases unless `phases` is false. */
function start({ phases = true, ...options }: Parameters<typeof createCallDeadline>[1] & { phases?: boolean } = {}) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(BEGAN));
  const deadline = createCallDeadline(undefined, options);
  if (phases) deadline.reportSend({ reportsPhases: true });
  return deadline;
}

describe('bounds per phase, on an adapter that reports them', () => {
  it('ends a call with no content 400 s after the send, whatever other events and transport reports come first', () => {
    const deadline = start({ idleTimeoutMs: Infinity });
    // Pings every 20 s, and message_start at 120 s: none of them is content.
    for (let t = 20; t <= 380; t += 20) {
      vi.advanceTimersByTime(20 * S);
      deadline.report('alive');
      if (t === 120) deadline.report();
    }
    vi.advanceTimersByTime(19 * S);
    expect(expired(deadline)).toBeUndefined();
    vi.advanceTimersByTime(1 * S);
    expect(expired(deadline)).toBe(
      'No content within 400s of the send: the call began at 2026-10-22T12:00:00.000Z, provider events: 1, the last at 2026-10-22T12:02:00.000Z',
    );
    deadline.cleanup();
  });

  it('after content, ends a call 180 s after its last event', () => {
    const deadline = start();
    vi.advanceTimersByTime(300 * S);
    deadline.report('content');
    vi.advanceTimersByTime(170 * S);
    deadline.report();
    vi.advanceTimersByTime(179 * S);
    expect(expired(deadline)).toBeUndefined();
    vi.advanceTimersByTime(1 * S);
    expect(expired(deadline)).toMatch(/^No provider event within 180s: the call began at 2026-10-22T12:00:00\.000Z, provider events: 2, the last at 2026-10-22T12:07:50\.000Z$/);
    deadline.cleanup();
  });

  it('allows a silent think before content its whole budget at 35 tokens a second, from its start', () => {
    // max_tokens 32,000 at 35 a second: ceil(914.3) = 915 s, past the 400 s.
    const deadline = start({ maxTokens: 32_000 });
    vi.advanceTimersByTime(100 * S);
    deadline.report(); // message_start
    deadline.report('think');
    vi.advanceTimersByTime(914 * S);
    expect(expired(deadline)).toBeUndefined();
    vi.advanceTimersByTime(1 * S);
    expect(expired(deadline)).toMatch(/^No content within 915s of a silent think's start \(max_tokens 32000 at 35 tokens a second\): /);
    deadline.cleanup();
  });

  it("ends a call with a short think's allowance at the 400 s, which both must outlast", () => {
    // 4,096 tokens: 118 s from 100 s runs out at 218 s, inside the 400 s.
    const deadline = start({ maxTokens: 4096 });
    vi.advanceTimersByTime(100 * S);
    deadline.report('think');
    vi.advanceTimersByTime(299 * S);
    expect(expired(deadline)).toBeUndefined();
    vi.advanceTimersByTime(1 * S);
    expect(expired(deadline)).toMatch(/^No content within 400s of the send: /);
    deadline.cleanup();
  });

  it("after content, allows a silent think's start the larger of 180 s and its allowance, and the next event 180 s again", () => {
    const deadline = start({ maxTokens: 32_000 });
    vi.advanceTimersByTime(10 * S);
    deadline.report('content');
    vi.advanceTimersByTime(10 * S);
    deadline.report('think');
    vi.advanceTimersByTime(914 * S);
    expect(expired(deadline)).toBeUndefined();
    deadline.report('content');
    vi.advanceTimersByTime(179 * S);
    expect(expired(deadline)).toBeUndefined();
    vi.advanceTimersByTime(1 * S);
    expect(expired(deadline)).toMatch(/^No provider event within 180s: /);
    deadline.cleanup();

    const short = start({ maxTokens: 4096 });
    short.report('content');
    short.report('think');
    vi.advanceTimersByTime(179 * S);
    expect(expired(short)).toBeUndefined();
    vi.advanceTimersByTime(1 * S);
    expect(expired(short)).toMatch(/^No provider event within 180s: /);
    short.cleanup();
  });

  it("returns to 180 s at any event after a mid-stream think's start, not only at content", () => {
    const deadline = start({ maxTokens: 32_000 });
    deadline.report('content');
    deadline.report('think');
    vi.advanceTimersByTime(30 * S);
    deadline.report(); // the think's block stops
    vi.advanceTimersByTime(179 * S);
    expect(expired(deadline)).toBeUndefined();
    vi.advanceTimersByTime(1 * S);
    expect(expired(deadline)).toMatch(/^No provider event within 180s: /);
    deadline.cleanup();
  });

  it("names a mid-stream think's allowance when that's the bound that ran out", () => {
    const deadline = start({ maxTokens: 32_000 });
    deadline.report('content');
    deadline.report('think');
    vi.advanceTimersByTime(915 * S);
    expect(expired(deadline)).toMatch(/^No provider event within 915s of a silent think's start \(max_tokens 32000 at 35 tokens a second\): /);
    deadline.cleanup();
  });

  it('brings the expiry closer when content follows a long think', () => {
    const deadline = start({ maxTokens: 32_000 });
    deadline.report('think');
    vi.advanceTimersByTime(50 * S);
    deadline.report('content');
    vi.advanceTimersByTime(180 * S);
    expect(expired(deadline)).toMatch(/^No provider event within 180s: /);
    deadline.cleanup();
  });
});

describe('a block start before content', () => {
  it("leaves the 400 s from the send in place: a tool call's input can take a while to follow its start", () => {
    const deadline = start();
    vi.advanceTimersByTime(60 * S);
    deadline.report(); // a tool_use block's start
    vi.advanceTimersByTime(339 * S);
    expect(expired(deadline)).toBeUndefined();
    deadline.report('content'); // its first input delta
    vi.advanceTimersByTime(179 * S);
    expect(expired(deadline)).toBeUndefined();
    vi.advanceTimersByTime(1 * S);
    expect(expired(deadline)).toMatch(/^No provider event within 180s/);
    deadline.cleanup();
  });
});

describe('the report at the send', () => {
  it("takes the phases only from a report before any event, and stays on the whole-answer bound otherwise", () => {
    const late = start({ phases: false });
    late.report(); // message_start
    late.reportSend({ reportsPhases: true });
    vi.advanceTimersByTime(517 * S);
    expect(expired(late)).toBeUndefined();
    vi.advanceTimersByTime(1 * S);
    expect(expired(late)).toMatch(/^No provider event within 518s/);
    late.cleanup();

    const declined = start({ phases: false });
    declined.reportSend({ reportsPhases: false, maxTokens: 4096 });
    vi.advanceTimersByTime(400 * S);
    expect(expired(declined)).toBeUndefined();
    declined.cleanup();
  });
});

describe('the one timer', () => {
  it('arms no new timer for a report that leaves the expiry where it was or later', () => {
    // Before content, plain events leave the expiry where it is (400 s from the send).
    const before = start({ idleTimeoutMs: 0 });
    let armed = vi.spyOn(globalThis, 'setTimeout');
    for (let i = 0; i < 100; i++) before.report();
    expect(armed).toHaveBeenCalledTimes(0);
    before.cleanup();
    armed.mockRestore();
    // After content, each report moves it later.
    const deadline = start();
    deadline.report('alive');
    deadline.report('content');
    armed = vi.spyOn(globalThis, 'setTimeout');
    for (let i = 0; i < 1000; i++) {
      vi.advanceTimersByTime(10);
      deadline.report(i % 2 ? 'content' : 'alive');
    }
    expect(armed).toHaveBeenCalledTimes(0);
    deadline.cleanup();
  });

  it('arms no timer at all for a flat bound of Infinity with the liveness bound off', () => {
    const deadline = start({ progressTimeoutMs: Infinity, idleTimeoutMs: 0 });
    deadline.report('content');
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10 * 3600 * S);
    expect(expired(deadline)).toBeUndefined();
    deadline.cleanup();
  });

  it('measures the phases on the monotonic clock, so a step of the system clock moves no expiry', () => {
    // setSystemTime moves Date alone, as an NTP step or a VM restore does.
    const forward = start();
    vi.setSystemTime(new Date('2026-10-22T13:00:00.000Z'));
    vi.advanceTimersByTime(399 * S);
    expect(expired(forward)).toBeUndefined();
    vi.advanceTimersByTime(1 * S);
    expect(expired(forward)).toMatch(/^No content within 400s of the send: the call began at 2026-10-22T12:00:00\.000Z/);
    forward.cleanup();

    const backward = start();
    vi.setSystemTime(new Date('2026-10-22T11:00:00.000Z'));
    vi.advanceTimersByTime(400 * S);
    expect(expired(backward)).toMatch(/^No content within 400s of the send/);
    backward.cleanup();
  });
});

describe('the bound for an answer that can arrive whole', () => {
  it('bounds a call without phases at 400 s plus its budget at 35 tokens a second, from the send and from each event', () => {
    // The default budget, 4,096 tokens: ceil(117.03) = 118 s, so 518 s.
    const deadline = start({ phases: false });
    vi.advanceTimersByTime(517 * S);
    expect(expired(deadline)).toBeUndefined();
    vi.advanceTimersByTime(1 * S);
    expect(expired(deadline)).toBe(
      'No answer within 518s (400s plus max_tokens 4096 at 35 tokens a second): the call began at 2026-10-22T12:00:00.000Z, provider events: 0',
    );
    deadline.cleanup();

    const renewed = start({ phases: false });
    vi.advanceTimersByTime(500 * S);
    renewed.report('content');
    vi.advanceTimersByTime(517 * S);
    expect(expired(renewed)).toBeUndefined();
    vi.advanceTimersByTime(1 * S);
    expect(expired(renewed)).toMatch(/^No provider event within 518s \(400s plus max_tokens 4096 at 35 tokens a second\): /);
    renewed.cleanup();
  });

  it("sizes the budget from the adapter's report, else the request's maxTokens, else 4096", () => {
    const at = (deadline: ReturnType<typeof start>): number => {
      for (let t = 1; t < 10_000; t++) {
        vi.advanceTimersByTime(1 * S);
        if (deadline.signal!.aborted) { deadline.cleanup(); return t; }
      }
      deadline.cleanup();
      return Infinity;
    };
    expect(at(start({ phases: false, maxTokens: 70_000 }))).toBe(2400);
    for (const none of [0, -5, Number.NaN, Infinity, undefined]) expect(at(start({ phases: false, maxTokens: none }))).toBe(518);

    const reported = start({ phases: false, maxTokens: 70_000 });
    reported.reportSend({ maxTokens: 350 });
    expect(at(reported)).toBe(410);

    const ignored = start({ phases: false, maxTokens: 350 });
    for (const bad of [0, -1, Number.NaN, Infinity, undefined]) ignored.reportSend({ maxTokens: bad });
    expect(at(ignored)).toBe(410);
  });

  it("uses one flat bound instead when progressTimeoutMs is a positive number, whatever the phases", () => {
    const deadline = start({ progressTimeoutMs: 1000 });
    deadline.report('think');
    vi.advanceTimersByTime(999);
    expect(expired(deadline)).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(expired(deadline)).toMatch(/^No provider progress within 1000ms: /);
    deadline.cleanup();
  });

  it('counts null as unset, as it counted before there was a default', () => {
    const deadline = start({ progressTimeoutMs: null });
    vi.advanceTimersByTime(399 * S);
    expect(expired(deadline)).toBeUndefined();
    vi.advanceTimersByTime(1 * S);
    expect(expired(deadline)).toMatch(/^No content within 400s of the send: /);
    deadline.cleanup();
  });

  it('turns the progress deadline off for 0, a negative number or NaN', () => {
    for (const off of [0, -1, Number.NaN]) {
      const deadline = start({ progressTimeoutMs: off, phases: false });
      vi.advanceTimersByTime(10 * 3600 * S);
      expect(expired(deadline)).toBeUndefined();
      deadline.cleanup();
    }
  });
});

describe('the liveness bound', () => {
  it("isn't armed until the transport is first reported alive, and then ends a call 180 s after its last report of any kind", () => {
    const deadline = start({ progressTimeoutMs: 0 });
    deadline.report();
    vi.advanceTimersByTime(3600 * S);
    expect(expired(deadline)).toBeUndefined();
    deadline.report('alive');
    vi.advanceTimersByTime(170 * S);
    deadline.report('content');
    vi.advanceTimersByTime(170 * S);
    deadline.report('alive');
    vi.advanceTimersByTime(179 * S);
    expect(expired(deadline)).toBeUndefined();
    vi.advanceTimersByTime(1 * S);
    expect(expired(deadline)).toMatch(/^No byte from the provider within 180s, so the connection is taken as gone: the call began at \S+, provider events: 2, the last at \S+$/);
    deadline.cleanup();
  });

  it('ends a silent think whose connection is gone, though its allowance runs longer', () => {
    const deadline = start({ maxTokens: 128_000 });
    deadline.report('alive');
    deadline.report('think');
    vi.advanceTimersByTime(180 * S);
    expect(expired(deadline)).toMatch(/^No byte from the provider within 180s/);
    deadline.cleanup();
  });

  it('takes idleTimeoutMs as its bound, the default for null, and is off for 0, a negative number or NaN', () => {
    const set = start({ progressTimeoutMs: 0, idleTimeoutMs: 5 * S });
    set.report('alive');
    vi.advanceTimersByTime(5 * S);
    expect(expired(set)).toMatch(/^No byte from the provider within 5s/);
    set.cleanup();

    const byDefault = start({ progressTimeoutMs: 0, idleTimeoutMs: null });
    byDefault.report('alive');
    vi.advanceTimersByTime(180 * S);
    expect(expired(byDefault)).toMatch(/^No byte from the provider within 180s/);
    byDefault.cleanup();

    for (const off of [0, -1, Number.NaN]) {
      // With the progress deadline off too, nothing is left to keep: the caller's signal (none here) passes through.
      const deadline = start({ progressTimeoutMs: 0, idleTimeoutMs: off });
      expect(deadline.signal).toBeUndefined();
      deadline.report('alive');
      vi.advanceTimersByTime(10 * 3600 * S);
      expect(vi.getTimerCount()).toBe(0);
      deadline.cleanup();

      const withProgress = start({ progressTimeoutMs: 1000, idleTimeoutMs: off });
      withProgress.report('alive');
      vi.advanceTimersByTime(999);
      withProgress.report();
      vi.advanceTimersByTime(999);
      expect(expired(withProgress)).toBeUndefined();
      withProgress.cleanup();
    }
  });
});

describe('a deadline that has ended', () => {
  it('arms nothing on a report that comes after cleanup, expiry or the caller leaving', () => {
    const cleaned = start();
    cleaned.cleanup();
    cleaned.report('alive');
    cleaned.report('content');
    cleaned.reportSend({ maxTokens: 100, reportsPhases: true });
    expect(vi.getTimerCount()).toBe(0);

    const ran = start({ progressTimeoutMs: 1000 });
    vi.advanceTimersByTime(1000);
    expect(ran.signal!.aborted).toBe(true);
    ran.report('alive');
    ran.report('content');
    expect(vi.getTimerCount()).toBe(0);
    ran.cleanup();

    const caller = new AbortController();
    const left = createCallDeadline(caller.signal, {});
    caller.abort('zz gone');
    expect(left.signal!.reason).toBe('zz gone');
    left.report('alive');
    expect(vi.getTimerCount()).toBe(0);
    left.cleanup();
  });
});

describe('Membrane core: which bound each call gets', () => {
  /** Never answers; honours its signal as an adapter does; says nothing unless told to. */
  class Silent implements ProviderAdapter {
    readonly name = 'zz-silent';
    readonly seen: Array<ProviderRequestOptions | undefined> = [];
    constructor(private readonly reportsPhases: boolean, private readonly onSend?: (options: ProviderRequestOptions) => void) {}
    supportsModel(): boolean { return true; }
    private async attempt(options?: ProviderRequestOptions, streaming = false): Promise<ProviderResponse> {
      this.seen.push(options);
      if (streaming && this.reportsPhases) options?.onSend?.({ reportsPhases: true });
      this.onSend?.(options!);
      const signal = options!.signal!;
      return await new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(isDeadlineAbort(signal.reason) ? deadlineTimeoutError(signal.reason) : signal.reason), { once: true });
      });
    }
    async complete(_request: ProviderRequest, options?: ProviderRequestOptions): Promise<ProviderResponse> { return this.attempt(options); }
    async stream(_request: ProviderRequest, _callbacks: StreamCallbacks, options?: ProviderRequestOptions): Promise<ProviderResponse> { return this.attempt(options, true); }
  }
  const REQUEST: NormalizedRequest = {
    messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz hello' }] }],
    config: { model: 'zz-model', maxTokens: 4096 },
  };

  /** Seconds until the call settles, on fake timers. */
  async function settlesAfter(call: Promise<unknown>): Promise<{ seconds: number; result: unknown }> {
    let done: { result: unknown } | undefined;
    void call.then((result) => { done = { result }; }, (error: unknown) => { done = { result: error }; });
    for (let t = 1; t <= 10_000; t++) {
      await vi.advanceTimersByTimeAsync(1 * S);
      if (done) return { seconds: t, result: done.result };
    }
    throw new Error('zz never settled');
  }

  it("bounds a phase adapter's stream per phase, and its complete() and other adapters' streams as a whole answer", async () => {
    vi.useFakeTimers();
    const phased = await settlesAfter(new Membrane(new Silent(true)).stream(REQUEST));
    expect(phased.seconds).toBe(400);
    expect(isAbortedResponse(phased.result)).toBe(true);
    expect((phased.result as { reason: string }).reason).toBe('timeout');

    const whole = await settlesAfter(new Membrane(new Silent(true)).complete(REQUEST));
    expect(whole.seconds).toBe(518);
    expect(whole.result).toBeInstanceOf(TimeoutAbortError);
    expect((whole.result as Error).message).toMatch(/^No answer within 518s \(400s plus max_tokens 4096 at 35 tokens a second\): /);

    const unphased = await settlesAfter(new Membrane(new Silent(false)).stream(REQUEST));
    expect(unphased.seconds).toBe(518);
    expect(isAbortedResponse(unphased.result)).toBe(true);
  });

  it("sizes the bound from the request's maxTokens when the adapter reports none, on complete() and stream()", async () => {
    vi.useFakeTimers();
    const large = { ...REQUEST, config: { ...REQUEST.config, maxTokens: 70_000 } };
    expect((await settlesAfter(new Membrane(new Silent(false)).stream(large))).seconds).toBe(2400);
    expect((await settlesAfter(new Membrane(new Silent(false)).complete(large))).seconds).toBe(2400);
  });

  it("sizes the bound from the budget the adapter reports sending, on complete() and stream()", async () => {
    vi.useFakeTimers();
    const reporting = () => new Silent(false, (options) => options.onSend?.({ maxTokens: 70_000 }));
    expect((await settlesAfter(new Membrane(reporting()).complete(REQUEST))).seconds).toBe(2400);
    expect((await settlesAfter(new Membrane(reporting()).stream(REQUEST))).seconds).toBe(2400);
  });

  it("bounds streamYielding per phase on both tool paths, and stream({ streaming: false }) as a whole answer", async () => {
    vi.useFakeTimers();
    const tools = [{ name: 'zz_probe', description: 'zz probe', inputSchema: { type: 'object' as const, properties: {} } }];
    for (const request of [{ ...REQUEST, toolMode: 'native' as const, tools }, { ...REQUEST, toolMode: 'xml' as const }]) {
      const events: Array<{ type: string; reason?: string }> = [];
      const ended = await settlesAfter((async () => {
        for await (const event of new Membrane(new Silent(true)).streamYielding(request)) events.push(event as never);
      })());
      expect(ended.seconds).toBe(400);
      expect(events.find((e) => e.type === 'aborted')).toMatchObject({ reason: 'timeout' });
    }
    const fallback = await settlesAfter(new Membrane(new Silent(true)).stream({ ...REQUEST, streaming: false }));
    expect(fallback.seconds).toBe(518);
  });

  it('passes idleTimeoutMs to the liveness bound, and keeps it from the adapter', async () => {
    vi.useFakeTimers();
    const adapter = new Silent(true, (options) => options.onProgress?.('alive'));
    const ended = await settlesAfter(new Membrane(adapter).stream(REQUEST, { idleTimeoutMs: 30 * S }));
    expect(ended.seconds).toBe(30);
    expect(adapter.seen[0] !== undefined && 'idleTimeoutMs' in adapter.seen[0]).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// What each adapter reports
// ---------------------------------------------------------------------------

function stubFetch(respond: (init: RequestInit) => Response): RequestInit[] {
  const calls: RequestInit[] = [];
  vi.stubGlobal('fetch', async (_input: unknown, init: RequestInit) => {
    calls.push(init);
    return respond(init);
  });
  return calls;
}

const frame = (event: string, data: object): string => `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`;
const message = {
  id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
  content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 },
};
/** A think, then an answer; with `summary`, the think streams it as a thinking_delta before its signature. */
const thinkThenAnswer = (thinking: object, summary?: string): string[] => [
  frame('message_start', { message }),
  frame('ping', {}),
  frame('content_block_start', { index: 0, content_block: thinking }),
  ...(summary === undefined ? [] : [frame('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: summary } })]),
  frame('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'zz-sig' } }),
  frame('content_block_stop', { index: 0 }),
  frame('content_block_start', { index: 1, content_block: { type: 'text', text: '' } }),
  frame('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'zz answer' } }),
  frame('content_block_stop', { index: 1 }),
  frame('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }),
  frame('message_stop', {}),
];
const anthropicRequest = (extra?: Record<string, unknown>): ProviderRequest => ({
  model: 'claude-sonnet-4-6', maxTokens: 2048,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'zz hello' }] }],
  ...(extra ? { extra } : {}),
});
const anthropic = (): AnthropicAdapter => new AnthropicAdapter({ apiKey: 'sk-test', cacheKeepalive: { enabled: false } });

/** Every report one Anthropic stream makes, one chunk of body per frame. */
async function anthropicReports(frames: string[], request: ProviderRequest): Promise<{ events: Array<ProgressSeen | undefined>; alive: number; sends: SendReport[]; sentBeforeFetch: boolean }> {
  const events: Array<ProgressSeen | undefined> = [];
  const sends: SendReport[] = [];
  let sentBeforeFetch = false;
  stubFetch(() => { sentBeforeFetch = sends.length === 1; return rawSseResponse(frames); });
  let alive = 0;
  await anthropic().stream(request, { onChunk: () => {} }, {
    onProgress: (seen) => { if (seen === 'alive') alive++; else events.push(seen); },
    onSend: (send) => sends.push(send),
  });
  return { events, alive, sends, sentBeforeFetch };
}

describe('AnthropicAdapter reports what it saw', () => {
  it("reports a silent think's start as think, every content delta as content, and the body's chunks as alive", async () => {
    const { events, alive } = await anthropicReports(
      thinkThenAnswer({ type: 'thinking', thinking: '', signature: '' }),
      anthropicRequest({ thinking: { type: 'adaptive', display: 'omitted' } }),
    );
    // message_start, the think, its signature, its stop, the text block's start (an event) and delta, its stop, message_delta (the terminal event).
    expect(events).toEqual([undefined, 'think', 'content', undefined, undefined, 'content', undefined, undefined]);
    expect(alive).toBeGreaterThan(0);
  });

  it('reports no think for a body that asks for summarized thinking, or for a redacted block', async () => {
    const summarized = await anthropicReports(
      thinkThenAnswer({ type: 'thinking', thinking: '', signature: '' }, 'zz summary'),
      anthropicRequest({ thinking: { type: 'adaptive', display: 'summarized' } }),
    );
    // A summarized think's start is only an event: its summary follows as deltas, which are content.
    expect(summarized.events).toEqual([undefined, undefined, 'content', 'content', undefined, undefined, 'content', undefined, undefined]);

    // A redacted block arrives whole, its think done: it's content, which ends the phase before content.
    stubFetch(() => rawSseResponse([
      frame('message_start', { message }),
      frame('content_block_start', { index: 0, content_block: { type: 'redacted_thinking', data: 'zz-redacted' } }),
      frame('content_block_stop', { index: 0 }),
      frame('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }),
    ]));
    const redacted: Array<ProgressSeen | undefined> = [];
    await anthropic().stream(anthropicRequest({ thinking: { type: 'adaptive', display: 'omitted' } }), { onChunk: () => {} }, {
      onProgress: (seen) => { if (seen !== 'alive') redacted.push(seen); },
    });
    expect(redacted).toEqual([undefined, 'content', undefined, undefined]);
  });

  it("reports a tool call's start as an event and its input as content", async () => {
    const { events } = await anthropicReports([
      frame('message_start', { message }),
      frame('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_zz1', name: 'zz_probe', input: {} } }),
      frame('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } }),
      frame('content_block_stop', { index: 0 }),
      frame('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 2 } }),
    ], anthropicRequest());
    expect(events).toEqual([undefined, undefined, 'content', undefined, undefined]);
  });

  it("counts a think with no thinking config sent as silent: the models that think without one do so silently", async () => {
    const { events } = await anthropicReports(thinkThenAnswer({ type: 'thinking', thinking: '', signature: '' }), anthropicRequest());
    expect(events).toContain('think');
  });

  it('reports at the send, before the request goes out, the max_tokens it sends (its default and extra included) and that the stream reports phases', async () => {
    const answer = thinkThenAnswer({ type: 'thinking', thinking: '', signature: '' });
    const asked = await anthropicReports(answer, anthropicRequest());
    expect(asked.sends).toEqual([{ maxTokens: 2048, reportsPhases: true }]);
    expect(asked.sentBeforeFetch).toBe(true);
    expect((await anthropicReports(answer, { ...anthropicRequest(), maxTokens: 0 })).sends).toEqual([{ maxTokens: 4096, reportsPhases: true }]);
    expect((await anthropicReports(answer, anthropicRequest({ max_tokens: 9000 }))).sends).toEqual([{ maxTokens: 9000, reportsPhases: true }]);

    // complete() reports no phases: its answer arrives whole.
    const completeSends: SendReport[] = [];
    let completeSentBeforeFetch = false;
    stubFetch(() => {
      completeSentBeforeFetch = completeSends.length === 1;
      return Response.json({ ...message, content: [{ type: 'text', text: 'zz answer' }], stop_reason: 'end_turn' });
    });
    await anthropic().complete(anthropicRequest({ max_tokens: 9000 }), { onSend: (send) => completeSends.push(send) });
    expect(completeSends).toEqual([{ maxTokens: 9000 }]);
    expect(completeSentBeforeFetch).toBe(true);
  });
});

describe('BedrockAdapter reports what it saw', () => {
  const bedrock = (): BedrockAdapter => new BedrockAdapter({ accessKeyId: 'zz-not-a-key-id', secretAccessKey: 'zz-not-a-secret', region: 'zz-region-1' });
  const frames = (thinking: object, summary?: string) => streamBody([
    chunkFrame({ type: 'message_start', message: { usage: { input_tokens: 3 } } }),
    chunkFrame({ type: 'ping' }),
    chunkFrame({ type: 'content_block_start', index: 0, content_block: thinking }),
    ...(summary === undefined ? [] : [chunkFrame({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: summary } })]),
    chunkFrame({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'zz-sig' } }),
    chunkFrame({ type: 'content_block_stop', index: 0 }),
    chunkFrame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }),
  ]);
  const request = (thinking?: object): ProviderRequest => ({
    model: 'anthropic.claude-sonnet-4-6', maxTokens: 3000,
    messages: [{ role: 'user', content: 'zz hello' }],
    ...(thinking ? { thinking } : {}),
  } as never);

  it("reports each body chunk as alive, a ping as nothing more, a silent think's start as think, a content delta as content, and at the send the max_tokens it sends and its phases", async () => {
    const sends: SendReport[] = [];
    let sentBeforeFetch = false;
    stubFetch(() => { sentBeforeFetch = sends.length === 1; return new Response(frames({ type: 'thinking', thinking: '' }), { status: 200 }); });
    const seen: Array<ProgressSeen | undefined> = [];
    // extra's max_tokens over the request's 3000: the body's limit is the one reported.
    await bedrock().stream({ ...request({ type: 'adaptive', display: 'omitted' }), extra: { max_tokens: 9000 } } as never, { onChunk: () => {} }, {
      onProgress: (kind) => seen.push(kind), onSend: (send) => sends.push(send),
    }).catch(() => undefined);
    // Six frames, one chunk each: each chunk is alive, then the event it carries (the ping none).
    expect(seen).toEqual(['alive', undefined, 'alive', 'alive', 'think', 'alive', 'content', 'alive', undefined, 'alive', undefined]);
    expect(sends).toEqual([{ maxTokens: 9000, reportsPhases: true }]);
    expect(sentBeforeFetch).toBe(true);
  });

  it("reports a redacted block as content, and a tool call's start as an event, its input as content", async () => {
    stubFetch(() => new Response(streamBody([
      chunkFrame({ type: 'message_start', message: { usage: { input_tokens: 3 } } }),
      chunkFrame({ type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'zz-redacted' } }),
      chunkFrame({ type: 'content_block_stop', index: 0 }),
      chunkFrame({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_zz1', name: 'zz_probe', input: {} } }),
      chunkFrame({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } }),
      chunkFrame({ type: 'content_block_stop', index: 1 }),
      chunkFrame({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } }),
    ]), { status: 200 }));
    const seen: Array<ProgressSeen | undefined> = [];
    await bedrock().stream(request({ type: 'adaptive', display: 'omitted' }), { onChunk: () => {} }, {
      onProgress: (kind) => seen.push(kind),
    }).catch(() => undefined);
    expect(seen.filter((kind) => kind !== 'alive')).toEqual([undefined, 'content', undefined, undefined, 'content', undefined, undefined]);
  });

  it('reports no think for a body that asks for summarized thinking, and its summary as content', async () => {
    stubFetch(() => new Response(frames({ type: 'thinking', thinking: '' }, 'zz summary'), { status: 200 }));
    const seen: Array<ProgressSeen | undefined> = [];
    await bedrock().stream(request({ type: 'adaptive', display: 'summarized' }), { onChunk: () => {} }, {
      onProgress: (kind) => seen.push(kind),
    }).catch(() => undefined);
    expect(seen.filter((kind) => kind !== 'alive')).toEqual([undefined, undefined, 'content', 'content', undefined, undefined]);
  });

  it('reports the max_tokens it sends on complete(), extra included, and no phases, before the request goes out', async () => {
    const sends: SendReport[] = [];
    let sentBeforeFetch = false;
    stubFetch(() => { sentBeforeFetch = sends.length === 1; return Response.json({ type: 'message', content: [], usage: { input_tokens: 1, output_tokens: 1 } }); });
    await bedrock().complete({ ...request(), extra: { max_tokens: 9000 } } as never, { onSend: (send) => sends.push(send) }).catch(() => undefined);
    expect(sends).toEqual([{ maxTokens: 9000 }]);
    expect(sentBeforeFetch).toBe(true);
  });

  it('reports each chunk with bytes as alive as it comes, a frame split across chunks included, and an empty chunk as nothing', async () => {
    const frame0 = chunkFrame({ type: 'message_start', message: { usage: { input_tokens: 3 } } });
    const frame1 = chunkFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'zz' } });
    const cut = Math.floor(frame1.length / 2);
    stubFetch(() => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(frame0);
        controller.enqueue(new Uint8Array(0));
        controller.enqueue(frame1.slice(0, cut));
        controller.enqueue(frame1.slice(cut));
        controller.close();
      },
    }), { status: 200 }));
    const seen: Array<ProgressSeen | undefined> = [];
    await bedrock().stream(request(), { onChunk: () => {} }, { onProgress: (kind) => seen.push(kind) }).catch(() => undefined);
    // The split frame's first half is alive before its event decodes; the empty chunk reports nothing.
    expect(seen).toEqual(['alive', undefined, 'alive', 'alive', 'content']);
  });
});

describe('every other adapter reports the output budget its body asks for', () => {
  for (const [name, build] of [
    ['openai', () => new OpenAIAdapter({ apiKey: 'zz-not-a-key' })],
    ['openai-compatible', () => new OpenAICompatibleAdapter({ baseURL: 'http://zz-host.invalid/v1', apiKey: 'zz-not-a-key' })],
  ] as const) {
    it(`${name}: a model sent max_completion_tokens reports that, on stream() and complete()`, async () => {
      stubFetch(() => rawSseResponse(['data: {"zz":1}\n\n']));
      const reported: SendReport[] = [];
      const bodies: Array<Record<string, unknown>> = [];
      const options: ProviderRequestOptions = { onSend: (send) => reported.push(send), onRequest: (req) => { bodies.push(req as Record<string, unknown>); } };
      const request = { model: 'gpt-5', messages: [{ role: 'user' as const, content: 'zz hello' }], maxTokens: 700 };
      await build().stream(request as never, { onChunk: () => {} }, options).catch(() => undefined);
      await build().complete(request as never, options).catch(() => undefined);
      expect(bodies.map((body) => body['max_completion_tokens'])).toEqual([700, 700]);
      expect(reported).toEqual([{ maxTokens: 700 }, { maxTokens: 700 }]);
    });
  }

  const sseBody = ['data: {"zz":1}\n\n'];
  const adapters: Array<[string, () => { stream: (...args: never[]) => Promise<unknown>; complete: (...args: never[]) => Promise<unknown> }]> = [
    ['openai', () => new OpenAIAdapter({ apiKey: 'zz-not-a-key' })],
    ['gemini', () => new GeminiAdapter({ apiKey: 'zz-not-a-key' })],
    ['openai-completions', () => new OpenAICompletionsAdapter({ baseURL: 'http://zz-host.invalid/v1', apiKey: 'zz-not-a-key' })],
    ['openai-compatible', () => new OpenAICompatibleAdapter({ baseURL: 'http://zz-host.invalid/v1', apiKey: 'zz-not-a-key' })],
    ['openrouter', () => new OpenRouterAdapter({ apiKey: 'zz-not-a-key' })],
    ['openai-responses-api', () => new OpenAIResponsesAPIAdapter({ apiKey: 'zz-not-a-key' })],
  ] as never;

  // Each adapter's own field, set through extra over what it built.
  const extraOf: Record<string, Record<string, unknown>> = {
    'openai': { max_tokens: 9000 },
    'gemini': { generationConfig: { maxOutputTokens: 9000 } },
    'openai-completions': { max_tokens: 9000 },
    'openai-compatible': { max_tokens: 9000 },
    'openrouter': { max_tokens: 9000 },
    'openai-responses-api': { max_output_tokens: 9000 },
  };

  for (const [name, build] of adapters) {
    it(`${name}: the limit its body asks for, its default and extra included, at the send on stream() and complete(), and no phases`, async () => {
      const reported: SendReport[] = [];
      const atFetch: number[] = [];
      stubFetch(() => { atFetch.push(reported.length); return rawSseResponse(sseBody); });
      const adapter = build() as unknown as {
        stream: (request: unknown, callbacks: unknown, options: ProviderRequestOptions) => Promise<unknown>;
        complete: (request: unknown, options: ProviderRequestOptions) => Promise<unknown>;
      };
      const options: ProviderRequestOptions = { onSend: (send) => reported.push(send) };
      for (const [maxTokens, extra] of [[16, undefined], [0, undefined], [16, extraOf[name]]] as const) {
        const request = { model: 'zz-model', messages: [{ role: 'user', content: 'zz hello' }], maxTokens, ...(extra ? { extra } : {}) };
        await adapter.stream(request, { onChunk: () => {} }, options).catch(() => undefined);
        await adapter.complete(request, options).catch(() => undefined);
      }
      expect(reported.map((send) => send.maxTokens)).toEqual([16, 16, 4096, 4096, 9000, 9000]);
      expect(reported.some((send) => 'reportsPhases' in send)).toBe(false);
      // Each report came before the request it describes went out.
      expect(atFetch).toEqual([1, 2, 3, 4, 5, 6]);
    });
  }
});
