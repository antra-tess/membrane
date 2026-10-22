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
import type { NormalizedRequest, ProgressSeen } from '../../src/types/index.js';
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

function start(options: Partial<Parameters<typeof createCallDeadline>[1]> = {}) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(BEGAN));
  return createCallDeadline(undefined, { phases: true, ...options });
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
    for (const none of [0, -5, Number.NaN, undefined]) expect(at(start({ phases: false, maxTokens: none }))).toBe(518);

    const reported = start({ phases: false, maxTokens: 70_000 });
    reported.reportMaxTokens(350);
    expect(at(reported)).toBe(410);

    const ignored = start({ phases: false, maxTokens: 350 });
    for (const bad of [0, -1, Number.NaN, Infinity, undefined]) ignored.reportMaxTokens(bad);
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

  it('turns the progress deadline off for 0, a negative number, NaN or null', () => {
    for (const off of [0, -1, Number.NaN, null as unknown as number]) {
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

    const byDefault = start({ progressTimeoutMs: 0, idleTimeoutMs: null as unknown as number });
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
    cleaned.reportMaxTokens(100);
    expect(vi.getTimerCount()).toBe(0);

    const ran = start({ progressTimeoutMs: 1000 });
    vi.advanceTimersByTime(1000);
    expect(ran.signal!.aborted).toBe(true);
    ran.report('alive');
    ran.report('content');
    expect(vi.getTimerCount()).toBe(0);
    ran.cleanup();

    const caller = new AbortController();
    const left = createCallDeadline(caller.signal, { phases: true });
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
    constructor(readonly reportsProgressPhases: boolean, private readonly onSend?: (options: ProviderRequestOptions) => void) {}
    supportsModel(): boolean { return true; }
    private async attempt(options?: ProviderRequestOptions): Promise<ProviderResponse> {
      this.seen.push(options);
      this.onSend?.(options!);
      const signal = options!.signal!;
      return await new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(isDeadlineAbort(signal.reason) ? deadlineTimeoutError(signal.reason) : signal.reason), { once: true });
      });
    }
    async complete(_request: ProviderRequest, options?: ProviderRequestOptions): Promise<ProviderResponse> { return this.attempt(options); }
    async stream(_request: ProviderRequest, _callbacks: StreamCallbacks, options?: ProviderRequestOptions): Promise<ProviderResponse> { return this.attempt(options); }
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

  it("sizes a stream's bound from the request's maxTokens when the adapter reports none", async () => {
    vi.useFakeTimers();
    const large = { ...REQUEST, config: { ...REQUEST.config, maxTokens: 70_000 } };
    const stream = await settlesAfter(new Membrane(new Silent(false)).stream(large));
    expect(stream.seconds).toBe(2400);
  });

  it("sizes the bound from the budget the adapter reports sending", async () => {
    vi.useFakeTimers();
    const reports = await settlesAfter(new Membrane(new Silent(false, (options) => options.onMaxTokens?.(70_000))).complete(REQUEST));
    expect(reports.seconds).toBe(2400);
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
const thinkThenAnswer = (thinking: object): string[] => [
  frame('message_start', { message }),
  frame('ping', {}),
  frame('content_block_start', { index: 0, content_block: thinking }),
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
async function anthropicReports(frames: string[], request: ProviderRequest): Promise<{ events: Array<ProgressSeen | undefined>; alive: number; maxTokens: Array<number | undefined> }> {
  stubFetch(() => rawSseResponse(frames));
  const events: Array<ProgressSeen | undefined> = [];
  const maxTokens: Array<number | undefined> = [];
  let alive = 0;
  await anthropic().stream(request, { onChunk: () => {} }, {
    onProgress: (seen) => { if (seen === 'alive') alive++; else events.push(seen); },
    onMaxTokens: (n) => maxTokens.push(n),
  });
  return { events, alive, maxTokens };
}

describe('AnthropicAdapter reports what it saw', () => {
  it("reports a silent think's start as think, every content delta as content, and the body's chunks as alive", async () => {
    const { events, alive } = await anthropicReports(
      thinkThenAnswer({ type: 'thinking', thinking: '', signature: '' }),
      anthropicRequest({ thinking: { type: 'adaptive', display: 'omitted' } }),
    );
    // message_start, the think, its signature, its stop, the text block, its delta, its stop, message_delta (the terminal event).
    expect(events).toEqual([undefined, 'think', 'content', undefined, undefined, 'content', undefined, undefined]);
    expect(alive).toBeGreaterThan(0);
  });

  it('reports no think for a body that asks for summarized thinking, or for a redacted block', async () => {
    const summarized = await anthropicReports(
      thinkThenAnswer({ type: 'thinking', thinking: '', signature: '' }),
      anthropicRequest({ thinking: { type: 'adaptive', display: 'summarized' } }),
    );
    expect(summarized.events).not.toContain('think');

    const redacted = await anthropicReports(
      thinkThenAnswer({ type: 'redacted_thinking', data: 'zz-redacted' }),
      anthropicRequest({ thinking: { type: 'adaptive', display: 'omitted' } }),
    );
    expect(redacted.events).not.toContain('think');
  });

  it("counts a think with no thinking config sent as silent: the models that think without one do so silently", async () => {
    const { events } = await anthropicReports(thinkThenAnswer({ type: 'thinking', thinking: '', signature: '' }), anthropicRequest());
    expect(events).toContain('think');
  });

  it('reports the max_tokens it sends, its default and extra included, once per call', async () => {
    const asked = await anthropicReports(thinkThenAnswer({ type: 'thinking', thinking: '', signature: '' }), anthropicRequest());
    expect(asked.maxTokens).toEqual([2048]);
    const byDefault = await anthropicReports(thinkThenAnswer({ type: 'thinking', thinking: '', signature: '' }), { ...anthropicRequest(), maxTokens: 0 });
    expect(byDefault.maxTokens).toEqual([4096]);
    const byExtra = await anthropicReports(thinkThenAnswer({ type: 'thinking', thinking: '', signature: '' }), anthropicRequest({ max_tokens: 9000 }));
    expect(byExtra.maxTokens).toEqual([9000]);

    stubFetch(() => Response.json({ ...message, content: [{ type: 'text', text: 'zz answer' }], stop_reason: 'end_turn' }));
    const completeReports: Array<number | undefined> = [];
    await anthropic().complete(anthropicRequest(), { onMaxTokens: (n) => completeReports.push(n) });
    expect(completeReports).toEqual([2048]);
  });
});

describe('BedrockAdapter reports what it saw', () => {
  const bedrock = (): BedrockAdapter => new BedrockAdapter({ accessKeyId: 'zz-not-a-key-id', secretAccessKey: 'zz-not-a-secret', region: 'zz-region-1' });
  const frames = (thinking: object) => streamBody([
    chunkFrame({ type: 'message_start', message: { usage: { input_tokens: 3 } } }),
    chunkFrame({ type: 'ping' }),
    chunkFrame({ type: 'content_block_start', index: 0, content_block: thinking }),
    chunkFrame({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'zz-sig' } }),
    chunkFrame({ type: 'content_block_stop', index: 0 }),
    chunkFrame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }),
  ]);
  const request = (thinking?: object): ProviderRequest => ({
    model: 'anthropic.claude-sonnet-4-6', maxTokens: 3000,
    messages: [{ role: 'user', content: 'zz hello' }],
    ...(thinking ? { thinking } : {}),
  } as never);

  it("reports a ping as alive, a silent think's start as think and a content delta as content, and the max_tokens it sends", async () => {
    stubFetch(() => new Response(frames({ type: 'thinking', thinking: '' }), { status: 200 }));
    const seen: Array<ProgressSeen | undefined> = [];
    const maxTokens: Array<number | undefined> = [];
    await bedrock().stream(request({ type: 'adaptive', display: 'omitted' }), { onChunk: () => {} }, {
      onProgress: (kind) => seen.push(kind), onMaxTokens: (n) => maxTokens.push(n),
    }).catch(() => undefined);
    expect(seen).toEqual([undefined, 'alive', 'think', 'content', undefined, undefined]);
    expect(maxTokens).toEqual([3000]);
  });

  it('reports no think for a body that asks for summarized thinking', async () => {
    stubFetch(() => new Response(frames({ type: 'thinking', thinking: '' }), { status: 200 }));
    const seen: Array<ProgressSeen | undefined> = [];
    await bedrock().stream(request({ type: 'adaptive', display: 'summarized' }), { onChunk: () => {} }, {
      onProgress: (kind) => seen.push(kind),
    }).catch(() => undefined);
    expect(seen).not.toContain('think');
  });
});

describe('every other adapter reports the output budget its body asks for', () => {
  const sseBody = ['data: {"zz":1}\n\n'];
  const adapters: Array<[string, () => { stream: (...args: never[]) => Promise<unknown>; complete: (...args: never[]) => Promise<unknown> }]> = [
    ['openai', () => new OpenAIAdapter({ apiKey: 'zz-not-a-key' })],
    ['gemini', () => new GeminiAdapter({ apiKey: 'zz-not-a-key' })],
    ['openai-completions', () => new OpenAICompletionsAdapter({ baseURL: 'http://zz-host.invalid/v1', apiKey: 'zz-not-a-key' })],
    ['openai-compatible', () => new OpenAICompatibleAdapter({ baseURL: 'http://zz-host.invalid/v1', apiKey: 'zz-not-a-key' })],
    ['openrouter', () => new OpenRouterAdapter({ apiKey: 'zz-not-a-key' })],
    ['openai-responses-api', () => new OpenAIResponsesAPIAdapter({ apiKey: 'zz-not-a-key' })],
  ] as never;

  for (const [name, build] of adapters) {
    it(`${name}: its request's maxTokens, or its default of 4096, on stream() and complete()`, async () => {
      stubFetch(() => rawSseResponse(sseBody));
      const reported: Array<number | undefined> = [];
      const adapter = build() as unknown as {
        stream: (request: unknown, callbacks: unknown, options: ProviderRequestOptions) => Promise<unknown>;
        complete: (request: unknown, options: ProviderRequestOptions) => Promise<unknown>;
      };
      const options: ProviderRequestOptions = { onMaxTokens: (n) => reported.push(n) };
      for (const maxTokens of [16, 0]) {
        const request = { model: 'zz-model', messages: [{ role: 'user', content: 'zz hello' }], maxTokens };
        await adapter.stream(request, { onChunk: () => {} }, options).catch(() => undefined);
        await adapter.complete(request, options).catch(() => undefined);
      }
      expect(reported).toEqual([16, 16, 4096, 4096]);
    });
  }
});
