import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { BedrockAdapter } from '../../src/providers/bedrock.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { chunkFrame } from '../helpers/bedrock-event-stream.js';
import { MockAdapter } from '../../src/providers/mock.js';
import { createProgressDeadline, deadlineTimeoutError, isDeadlineAbort } from '../../src/providers/utils.js';
import { PROGRESS_BOUNDS, resolveProgressBounds, type ProgressBounds } from '../../src/progress-bounds.js';
import { isAbortedResponse, serverError } from '../../src/types/index.js';
import type { NormalizedRequest, StreamEvent } from '../../src/types/index.js';
import type { ProviderAdapter, ProviderRequest, ProviderRequestOptions, ProviderResponse } from '../../src/types/provider.js';
import type { StreamCallbacks } from '../../src/types/streaming.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const S = 1000;
const BEGAN = '2026-10-26T12:00:00.000Z';

const REQUEST: NormalizedRequest = {
  messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz hello' }] }],
  config: { model: 'claude-sonnet-4-6', maxTokens: 100 },
};
const XML_REQUEST: NormalizedRequest = { ...REQUEST, toolMode: 'xml' };
const NATIVE_REQUEST: NormalizedRequest = {
  ...REQUEST,
  toolMode: 'native',
  tools: [{ name: 'zz_probe', description: 'zz probe', inputSchema: { type: 'object', properties: { fld1: { type: 'string' } } } }],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe('the bounds a caller asks for', () => {
  it("are on their own entry, frozen at 60 s, 150 s and 87 tokens a second, in a module that loads nothing else of membrane's", () => {
    const exports = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).exports;
    expect(exports['./progress-bounds']).toEqual({
      bun: './src/progress-bounds.ts',
      types: './dist/progress-bounds.d.ts',
      import: './dist/progress-bounds.js',
    });
    expect(PROGRESS_BOUNDS).toEqual({ beforeContentMs: 60_000, betweenEventsMs: 150_000, thinkTokensPerSecond: 87 });
    expect(Object.isFrozen(PROGRESS_BOUNDS)).toBe(true);
    expect(readFileSync(join(root, 'src/progress-bounds.ts'), 'utf8')).not.toMatch(/\bfrom\s+['"]|\bimport\s*\(|\brequire\s*\(|^\s*import\s+['"]/m);
  });

  it('are the defaults for true, the defaults with a given value in its place for an object, and none for false or unset', () => {
    expect(resolveProgressBounds(true)).toEqual(PROGRESS_BOUNDS);
    expect(resolveProgressBounds({ betweenEventsMs: 90_000 })).toEqual({ ...PROGRESS_BOUNDS, betweenEventsMs: 90_000 });
    expect(resolveProgressBounds({ beforeContentMs: 1, betweenEventsMs: 2, thinkTokensPerSecond: 0.5 }))
      .toEqual({ beforeContentMs: 1, betweenEventsMs: 2, thinkTokensPerSecond: 0.5 });
    expect(resolveProgressBounds(false)).toBeUndefined();
    expect(resolveProgressBounds(undefined)).toBeUndefined();
  });

  it("are refused, naming the field, for a value that isn't a finite number above 0, and for an option that isn't a boolean or an object", () => {
    for (const key of ['beforeContentMs', 'betweenEventsMs', 'thinkTokensPerSecond'] as const) {
      expect(() => resolveProgressBounds({ [key]: '60' } as unknown as Partial<ProgressBounds>))
        .toThrow(new TypeError(`[membrane] progressBounds.${key} must be a number, got string`));
      expect(() => resolveProgressBounds({ [key]: null } as unknown as Partial<ProgressBounds>))
        .toThrow(new TypeError(`[membrane] progressBounds.${key} must be a number, got null`));
      for (const value of [0, -1, Number.NaN, Infinity]) {
        expect(() => resolveProgressBounds({ [key]: value }))
          .toThrow(new RangeError(`[membrane] progressBounds.${key} must be a finite number above 0, got ${value}`));
      }
    }
    expect(() => resolveProgressBounds(null as unknown as boolean)).toThrow(TypeError);
    expect(() => resolveProgressBounds(60 as unknown as boolean)).toThrow(
      new TypeError('[membrane] progressBounds must be a boolean or an object of bounds, got number'),
    );
  });

  it('are refused by stream() and streamYielding() before anything is sent', async () => {
    const adapter = new MockAdapter();
    const send = vi.spyOn(adapter, 'stream');
    const sendWhole = vi.spyOn(adapter, 'complete');
    const membrane = new Membrane(adapter);
    await expect(membrane.stream(REQUEST, { progressBounds: { beforeContentMs: 0 } })).rejects.toThrow(RangeError);
    await expect(membrane.stream({ ...REQUEST, streaming: false }, { progressBounds: { beforeContentMs: 0 } })).rejects.toThrow(RangeError);
    expect(() => membrane.streamYielding(REQUEST, { progressBounds: { thinkTokensPerSecond: -1 } })).toThrow(RangeError);
    expect(send).not.toHaveBeenCalled();
    expect(sendWhole).not.toHaveBeenCalled();
  });
});

function expiredWith(deadline: { signal?: AbortSignal }): string | undefined {
  const signal = deadline.signal!;
  if (!signal.aborted) return undefined;
  expect(isDeadlineAbort(signal.reason)).toBe(true);
  return deadlineTimeoutError(signal.reason).message;
}

function sentWithContentReported(maxTokens?: number, bounds: ProgressBounds = PROGRESS_BOUNDS, timeoutMs?: number) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(BEGAN));
  const deadline = createProgressDeadline(undefined, timeoutMs, bounds);
  deadline.onSend!({ maxTokens, reportsContent: true });
  return deadline;
}

describe("one call's bounds", () => {
  it('end a call with no content 60 s after the send, whatever other events come first', () => {
    const deadline = sentWithContentReported(32_000);
    vi.advanceTimersByTime(5 * S);
    deadline.onProgress!();
    vi.advanceTimersByTime(25 * S);
    deadline.onProgress!();
    vi.advanceTimersByTime(30 * S - 1);
    expect(expiredWith(deadline)).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(expiredWith(deadline)).toBe(
      'No content within 60s of the send: the call began at 2026-10-26T12:00:00.000Z, provider events: 2, the last at 2026-10-26T12:00:30.000Z',
    );
    deadline.cleanup();
  });

  it('count from the send the adapter reports, on the monotonic clock', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(BEGAN));
    const deadline = createProgressDeadline(undefined, undefined, PROGRESS_BOUNDS);
    vi.advanceTimersByTime(50 * S);
    deadline.onSend!({ maxTokens: 100, reportsContent: true });
    vi.setSystemTime(new Date('2026-10-26T13:00:00.000Z'));
    vi.advanceTimersByTime(60 * S - 1);
    expect(expiredWith(deadline)).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(expiredWith(deadline)).toMatch(/^No content within 60s of the send: /);
    deadline.cleanup();
  });

  it("give a thinking block before content its max_tokens at 87 tokens a second, rounded up, from its start: 368 s for 32,000", () => {
    const deadline = sentWithContentReported(32_000);
    vi.advanceTimersByTime(10 * S);
    deadline.onProgress!('think');
    vi.advanceTimersByTime(368 * S - 1);
    expect(expiredWith(deadline)).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(expiredWith(deadline)).toMatch(
      /^No content within 368s of a thinking block's start \(max_tokens 32000 at 87 tokens a second\): the call began at /,
    );
    deadline.cleanup();
  });

  it("end a call at the 60 s from the send when a short thinking block's allowance ends sooner: 48 s for 4,096, from 5 s", () => {
    const deadline = sentWithContentReported(4096);
    vi.advanceTimersByTime(5 * S);
    deadline.onProgress!('think');
    vi.advanceTimersByTime(55 * S - 1);
    expect(expiredWith(deadline)).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(expiredWith(deadline)).toMatch(/^No content within 60s of the send: /);
    deadline.cleanup();
  });

  it('restart the allowance at a second thinking block before content', () => {
    const deadline = sentWithContentReported(32_000);
    vi.advanceTimersByTime(10 * S);
    deadline.onProgress!('think');
    vi.advanceTimersByTime(290 * S);
    deadline.onProgress!('think');
    vi.advanceTimersByTime(368 * S - 1);
    expect(expiredWith(deadline)).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(expiredWith(deadline)).toMatch(/^No content within 368s of a thinking block's start /);
    deadline.cleanup();
  });

  it('once content has begun, end a call 150 s after its last provider event, of any kind', () => {
    const deadline = sentWithContentReported(32_000);
    vi.advanceTimersByTime(5 * S);
    deadline.onProgress!('content');
    vi.advanceTimersByTime(95 * S);
    deadline.onProgress!();
    vi.advanceTimersByTime(150 * S - 1);
    expect(expiredWith(deadline)).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(expiredWith(deadline)).toBe(
      'No provider event within 150s: the call began at 2026-10-26T12:00:00.000Z, provider events: 2, the last at 2026-10-26T12:01:40.000Z',
    );
    deadline.cleanup();
  });

  it("after content, give a thinking block's start the larger of 150 s and its allowance, and any later event 150 s again", () => {
    const long = sentWithContentReported(32_000);
    long.onProgress!('content');
    vi.advanceTimersByTime(1 * S);
    long.onProgress!('think');
    vi.advanceTimersByTime(368 * S - 1);
    expect(expiredWith(long)).toBeUndefined();
    long.onProgress!('content');
    vi.advanceTimersByTime(150 * S - 1);
    expect(expiredWith(long)).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(expiredWith(long)).toMatch(/^No provider event within 150s: /);
    long.cleanup();

    const thenEvent = sentWithContentReported(32_000);
    thenEvent.onProgress!('content');
    thenEvent.onProgress!('think');
    vi.advanceTimersByTime(10 * S);
    thenEvent.onProgress!();
    vi.advanceTimersByTime(150 * S);
    expect(expiredWith(thenEvent)).toMatch(/^No provider event within 150s: /);
    thenEvent.cleanup();

    const short = sentWithContentReported(4096);
    short.onProgress!('content');
    short.onProgress!('think');
    vi.advanceTimersByTime(150 * S - 1);
    expect(expiredWith(short)).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(expiredWith(short)).toMatch(/^No provider event within 150s: /);
    short.cleanup();

    const named = sentWithContentReported(32_000);
    named.onProgress!('content');
    named.onProgress!('think');
    vi.advanceTimersByTime(368 * S);
    expect(expiredWith(named)).toMatch(/^No provider event within 368s of a thinking block's start \(max_tokens 32000 at 87 tokens a second\): /);
    named.cleanup();
  });

  it('bring the end closer when content follows a long thinking block, after the 60 s from the send have passed', () => {
    const deadline = sentWithContentReported(32_000);
    vi.advanceTimersByTime(10 * S);
    deadline.onProgress!('think');
    vi.advanceTimersByTime(90 * S);
    deadline.onProgress!('content');
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(150 * S - 1);
    expect(expiredWith(deadline)).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(expiredWith(deadline)).toMatch(/^No provider event within 150s: /);
    deadline.cleanup();

    const cleaned = sentWithContentReported(32_000);
    vi.advanceTimersByTime(10 * S);
    cleaned.onProgress!('think');
    vi.advanceTimersByTime(90 * S);
    cleaned.onProgress!('content');
    cleaned.cleanup();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("after content and a thinking block's start, bring the end closer at any later event once the allowance has been armed", () => {
    const deadline = sentWithContentReported(32_000);
    deadline.onProgress!('content');
    vi.advanceTimersByTime(1 * S);
    deadline.onProgress!('think');
    vi.advanceTimersByTime(151 * S);
    expect(expiredWith(deadline)).toBeUndefined();
    deadline.onProgress!();
    vi.advanceTimersByTime(150 * S - 1);
    expect(expiredWith(deadline)).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(expiredWith(deadline)).toMatch(/^No provider event within 150s: /);
    deadline.cleanup();
  });

  it("give a thinking block no allowance when the send reports no output budget that's a finite number above 0", () => {
    for (const maxTokens of [undefined, 0, -5, Number.NaN, Infinity]) {
      const deadline = sentWithContentReported(maxTokens);
      vi.advanceTimersByTime(1 * S);
      deadline.onProgress!('think');
      vi.advanceTimersByTime(59 * S);
      expect(expiredWith(deadline)).toMatch(/^No content within 60s of the send: /);
      deadline.cleanup();
    }
  });

  it("leave a call alone whose adapter doesn't report content, or reports nothing at its send", () => {
    vi.useFakeTimers();
    const unreported = createProgressDeadline(undefined, undefined, PROGRESS_BOUNDS);
    const contentless = createProgressDeadline(undefined, undefined, PROGRESS_BOUNDS);
    contentless.onSend!({ maxTokens: 100 });
    contentless.onSend!({ maxTokens: 100, reportsContent: false });
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(24 * 3600 * S);
    expect(unreported.signal!.aborted).toBe(false);
    expect(contentless.signal!.aborted).toBe(false);
    unreported.cleanup();
    contentless.cleanup();
  });

  it('run beside progressTimeoutMs, the first to run out ending the call', () => {
    const flatFirst = sentWithContentReported(32_000, PROGRESS_BOUNDS, 30 * S);
    vi.advanceTimersByTime(30 * S);
    expect(expiredWith(flatFirst)).toMatch(/^No provider progress within 30000ms: /);
    flatFirst.cleanup();

    const boundFirst = sentWithContentReported(32_000, PROGRESS_BOUNDS, 300 * S);
    vi.advanceTimersByTime(60 * S);
    expect(expiredWith(boundFirst)).toMatch(/^No content within 60s of the send: /);
    boundFirst.cleanup();

    const afterContent = sentWithContentReported(32_000, PROGRESS_BOUNDS, 100 * S);
    afterContent.onProgress!('content');
    vi.advanceTimersByTime(100 * S);
    expect(expiredWith(afterContent)).toMatch(/^No provider progress within 100000ms: /);
    afterContent.cleanup();
  });

  it('take the values a caller gives: 32 s for 32,000 at 1,000 tokens a second', () => {
    const deadline = sentWithContentReported(32_000, { beforeContentMs: 10 * S, betweenEventsMs: 20 * S, thinkTokensPerSecond: 1000 });
    vi.advanceTimersByTime(1 * S);
    deadline.onProgress!('think');
    vi.advanceTimersByTime(31 * S);
    expect(expiredWith(deadline)).toBeUndefined();
    deadline.onProgress!('content');
    vi.advanceTimersByTime(20 * S - 1);
    expect(expiredWith(deadline)).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(expiredWith(deadline)).toMatch(/^No provider event within 20s: /);
    deadline.cleanup();
  });

  it("arm nothing once a call has run out, been cleaned up or been left by its caller", () => {
    const ended = sentWithContentReported(32_000);
    vi.advanceTimersByTime(60 * S);
    expect(expiredWith(ended)).toMatch(/^No content within 60s of the send: /);
    ended.onSend!({ maxTokens: 100, reportsContent: true });
    ended.onProgress!('content');
    expect(vi.getTimerCount()).toBe(0);
    ended.cleanup();

    const cleaned = sentWithContentReported(32_000);
    cleaned.cleanup();
    cleaned.onSend!({ maxTokens: 100, reportsContent: true });
    cleaned.onProgress!('content');
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(3600 * S);
    expect(cleaned.signal!.aborted).toBe(false);

    vi.useFakeTimers();
    const caller = new AbortController();
    const left = createProgressDeadline(caller.signal, undefined, PROGRESS_BOUNDS);
    left.onSend!({ maxTokens: 100, reportsContent: true });
    expect(vi.getTimerCount()).toBe(1);
    const reason = new Error('zz caller');
    caller.abort(reason);
    expect(vi.getTimerCount()).toBe(0);
    left.onSend!({ maxTokens: 100, reportsContent: true });
    left.onProgress!('content');
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(3600 * S);
    expect(left.signal!.reason).toBe(reason);
    left.cleanup();
  });
});

describe('Membrane core: progress bounds per provider call', () => {
  class RecordingAdapter extends MockAdapter {
    readonly seen: Array<ProviderRequestOptions | undefined> = [];
    override async stream(request: ProviderRequest, callbacks: StreamCallbacks, options?: ProviderRequestOptions): Promise<ProviderResponse> {
      this.seen.push(options);
      return super.stream(request, callbacks, options);
    }
  }

  it('give the adapter onSend, onProgress and a signal of its own when they are on, and none when they are off', async () => {
    const on = new RecordingAdapter();
    const caller = new AbortController();
    await new Membrane(on).stream(XML_REQUEST, { progressBounds: true, signal: caller.signal });
    await new Membrane(on).stream(NATIVE_REQUEST, { progressBounds: { beforeContentMs: 90_000 }, signal: caller.signal });
    for await (const _ of new Membrane(on).streamYielding(XML_REQUEST, { progressBounds: true, signal: caller.signal })) { }
    for await (const _ of new Membrane(on).streamYielding(NATIVE_REQUEST, { progressBounds: true, signal: caller.signal })) { }
    expect(on.seen).toHaveLength(4);
    for (const options of on.seen) {
      expect(typeof options?.onSend).toBe('function');
      expect(typeof options?.onProgress).toBe('function');
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      expect(options?.signal).not.toBe(caller.signal);
      expect(options !== undefined && 'progressBounds' in options).toBe(false);
    }

    const off = new RecordingAdapter();
    await new Membrane(off).stream(XML_REQUEST, { signal: caller.signal });
    await new Membrane(off).stream(NATIVE_REQUEST, { progressBounds: false, signal: caller.signal });
    for await (const _ of new Membrane(off).streamYielding(XML_REQUEST, { signal: caller.signal })) { }
    for await (const _ of new Membrane(off).streamYielding(NATIVE_REQUEST, { progressBounds: false, signal: caller.signal })) { }
    expect(off.seen).toHaveLength(4);
    for (const options of off.seen) {
      expect(options?.onSend).toBeUndefined();
      expect(options?.onProgress).toBeUndefined();
      expect(options !== undefined && 'progressBounds' in options).toBe(false);
    }
    expect(off.seen[0]?.signal).toBe(caller.signal);
  });

  class ContentAfterQuiet implements ProviderAdapter {
    readonly name = 'zz-sends';
    calls = 0;
    constructor(private readonly quietMs: (send: number) => number, private readonly fails: (send: number) => Error | undefined = () => undefined) {}
    supportsModel(): boolean { return true; }
    async complete(request: ProviderRequest, options?: ProviderRequestOptions): Promise<ProviderResponse> {
      return this.stream(request, { onChunk: () => {} }, options);
    }
    async stream(request: ProviderRequest, callbacks: StreamCallbacks, options?: ProviderRequestOptions): Promise<ProviderResponse> {
      const send = this.calls++;
      const signal = options!.signal!;
      options!.onSend?.({ maxTokens: request.maxTokens, reportsContent: true });
      await new Promise<void>((resolve, reject) => {
        const abort = (): void => reject(isDeadlineAbort(signal.reason) ? deadlineTimeoutError(signal.reason) : signal.reason);
        if (signal.aborted) { abort(); return; }
        const timer = setTimeout(resolve, this.quietMs(send));
        signal.addEventListener('abort', () => { clearTimeout(timer); abort(); }, { once: true });
      });
      const failure = this.fails(send);
      if (failure) throw failure;
      options!.onProgress?.('content');
      callbacks.onChunk('zz answer');
      return {
        content: [{ type: 'text', text: 'zz answer' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 2 },
        model: request.model,
        rawRequest: request,
        raw: {},
      } as unknown as ProviderResponse;
    }
  }

  it('end a stalled call as a timeout whose message names the bound, and send it once', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(BEGAN));
    const stalled = (): ContentAfterQuiet => new ContentAfterQuiet(() => 3600 * S);

    for (const request of [XML_REQUEST, NATIVE_REQUEST]) {
      const viaStream = stalled();
      const streamed = new Membrane(viaStream).stream(request, { progressBounds: { beforeContentMs: 30 * S } });
      await vi.advanceTimersByTimeAsync(31 * S);
      const result = await streamed;
      expect(isAbortedResponse(result)).toBe(true);
      expect(result).toMatchObject({ reason: 'timeout' });
      expect((result as { message?: string }).message).toMatch(/^No content within 30s of the send: the call began at /);
      expect(viaStream.calls).toBe(1);
    }

    for (const request of [XML_REQUEST, NATIVE_REQUEST]) {
      const viaYielding = stalled();
      const collecting = collect(new Membrane(viaYielding).streamYielding(request, { progressBounds: { beforeContentMs: 30 * S } }));
      await vi.advanceTimersByTimeAsync(31 * S);
      const aborted = (await collecting).filter((event) => event.type === 'aborted');
      expect(aborted).toHaveLength(1);
      expect(aborted[0]).toMatchObject({ reason: 'timeout' });
      expect((aborted[0] as { message?: string }).message).toMatch(/^No content within 30s of the send: /);
      expect(viaYielding.calls).toBe(1);
    }
  });

  it("name progressTimeoutMs's deadline too, on a stream() that falls back to complete()", async () => {
    vi.useFakeTimers();
    const streamed = new Membrane(new ContentAfterQuiet(() => 3600 * S)).stream({ ...REQUEST, streaming: false }, { progressTimeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(2 * S);
    const result = await streamed;
    expect(result).toMatchObject({ aborted: true, reason: 'timeout' });
    expect((result as { message?: string }).message).toMatch(/^No provider progress within 1000ms: /);
  });

  it("give a caller's own cancel no message", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const streamed = new Membrane(new ContentAfterQuiet(() => 3600 * S)).stream(XML_REQUEST, { progressBounds: true, signal: caller.signal });
    await vi.advanceTimersByTimeAsync(10 * S);
    caller.abort(new Error('zz caller'));
    const result = await streamed;
    expect(result).toMatchObject({ aborted: true, reason: 'user' });
    expect('message' in result).toBe(false);
  });

  it('count each retry from its own send', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const schedule = { retry: { maxRetries: 2, retryDelayMs: 1000, maxRetryDelayMs: 1000, backoffMultiplier: 1 } };
    const failsOnce = (): ContentAfterQuiet => new ContentAfterQuiet(() => 40 * S, (send) => (send === 0 ? serverError('zz unavailable', 503) : undefined));

    const viaStream = failsOnce();
    const streamed = new Membrane(viaStream, schedule).stream(XML_REQUEST, { progressBounds: true });
    await vi.advanceTimersByTimeAsync(100 * S);
    const result = await streamed;
    expect(isAbortedResponse(result)).toBe(false);
    expect(viaStream.calls).toBe(2);

    const viaYielding = failsOnce();
    const collecting = collect(new Membrane(viaYielding, schedule).streamYielding(NATIVE_REQUEST, { progressBounds: true }));
    await vi.advanceTimersByTimeAsync(100 * S);
    const events = await collecting;
    expect(events.filter((event) => event.type === 'aborted')).toEqual([]);
    expect(events.some((event) => event.type === 'complete')).toBe(true);
    expect(viaYielding.calls).toBe(2);
  });
});

describe('AnthropicAdapter under progress bounds', () => {
  const message = {
    id: 'msg_test', type: 'message', role: 'assistant', model: REQUEST.config.model,
    content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 },
  };
  const frame = (event: string, data: object): string => `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`;
  const ping = frame('ping', {});
  const thinkingStart = frame('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } });
  const thinkingEnd = [
    frame('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'zzsig' } }),
    frame('content_block_stop', { index: 0 }),
    frame('content_block_start', { index: 1, content_block: { type: 'text', text: '' } }),
    frame('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'zz done' } }),
    frame('content_block_stop', { index: 1 }),
    frame('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }),
    frame('message_stop', {}),
  ];

  function stubThinkingThatPingsFor(pingMs: number): { calls: RequestInit[]; sending: Promise<void> } {
    const calls: RequestInit[] = [];
    let sent!: () => void;
    const sending = new Promise<void>((resolve) => { sent = resolve; });
    vi.stubGlobal('fetch', async (_input: unknown, init: RequestInit) => {
      calls.push(init);
      sent();
      const encoder = new TextEncoder();
      let done = false;
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start(c) { controller = c; },
        cancel() { done = true; },
      });
      const emit = (text: string): void => { if (!done) controller.enqueue(encoder.encode(text)); };
      init.signal?.addEventListener('abort', () => {
        if (done) return;
        done = true;
        controller.error(init.signal!.reason as Error);
      }, { once: true });
      void (async () => {
        emit(frame('message_start', { message }));
        emit(thinkingStart);
        for (let elapsed = 0; elapsed < pingMs && !done; elapsed += 25) {
          emit(ping);
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        for (const part of thinkingEnd) emit(part);
        if (!done) { done = true; controller.close(); }
      })();
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_fixture' } });
    });
    return { calls, sending };
  }
  const anthropic = (): AnthropicAdapter => new AnthropicAdapter({ apiKey: 'sk-test', cacheKeepalive: { enabled: false } });
  const TWO_SECONDS_FOR_100_TOKENS = { beforeContentMs: 300, betweenEventsMs: 300, thinkTokensPerSecond: 50 };

  it("keep a stream whose thinking block pings past the 300 ms before content but within its 2 s allowance", async () => {
    vi.useFakeTimers();
    const { sending } = stubThinkingThatPingsFor(600);
    const streaming = new Membrane(anthropic()).stream(REQUEST, { progressBounds: TWO_SECONDS_FOR_100_TOKENS });
    await sending;
    await vi.advanceTimersByTimeAsync(700);
    const result = await streaming;
    expect(isAbortedResponse(result)).toBe(false);
  });

  it("end a stream whose thinking block pings past its allowance, naming it", async () => {
    vi.useFakeTimers();
    const { calls, sending } = stubThinkingThatPingsFor(4000);
    const streaming = new Membrane(anthropic()).stream(REQUEST, { progressBounds: TWO_SECONDS_FOR_100_TOKENS });
    await sending;
    await vi.advanceTimersByTimeAsync(2100);
    const result = await streaming;
    expect(result).toMatchObject({ aborted: true, reason: 'timeout' });
    expect((result as { message?: string }).message).toMatch(
      /^No content within 2s of a thinking block's start \(max_tokens 100 at 50 tokens a second\): /,
    );
    expect(calls).toHaveLength(1);
  });
});

describe('BedrockAdapter under progress bounds', () => {
  it('end a stream that sends only pings after message_start, as a timeout naming the bound, and send it once', async () => {
    vi.useFakeTimers();
    const calls: RequestInit[] = [];
    let sent!: () => void;
    const sending = new Promise<void>((resolve) => { sent = resolve; });
    vi.stubGlobal('fetch', async (_input: unknown, init: RequestInit) => {
      calls.push(init);
      sent();
      let done = false;
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start(c) { controller = c; },
        cancel() { done = true; },
      });
      init.signal?.addEventListener('abort', () => {
        if (done) return;
        done = true;
        controller.error(init.signal!.reason as Error);
      }, { once: true });
      void (async () => {
        controller.enqueue(chunkFrame({ type: 'message_start', message: { usage: { input_tokens: 3 } } }));
        for (let elapsed = 0; elapsed < 3000 && !done; elapsed += 25) {
          controller.enqueue(chunkFrame({ type: 'ping' }));
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        if (!done) { done = true; controller.close(); }
      })();
      return new Response(body, { status: 200 });
    });
    const membrane = new Membrane(
      new BedrockAdapter({ accessKeyId: 'zz-key', secretAccessKey: 'zz-secret', region: 'us-east-1' }),
      { formatter: new NativeFormatter() },
    );
    const streaming = membrane.stream(
      { ...NATIVE_REQUEST, tools: undefined },
      { progressBounds: { beforeContentMs: 300, betweenEventsMs: 300, thinkTokensPerSecond: 50 } },
    );
    // Signing awaits crypto.subtle, which fake timers don't drive, so the clock moves only once the request is out.
    await sending;
    await vi.advanceTimersByTimeAsync(400);
    const result = await streaming;
    expect(result).toMatchObject({ aborted: true, reason: 'timeout' });
    expect((result as { message?: string }).message).toMatch(/^No content within 0\.3s of the send: /);
    expect(calls).toHaveLength(1);
  });
});
