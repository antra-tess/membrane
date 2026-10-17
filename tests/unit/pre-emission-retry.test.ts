/**
 * A provider call that fails with a 529 or a 429 before it delivers anything
 * is sent again, by every streaming entry point and in every round of a tool
 * loop: nothing from it reached the caller, so retrying replays nothing.
 *
 *  - streamYielding() retries on the native and XML paths, yielding one
 *    `backoff` event per wait; cancel() and the caller's signal end the wait.
 *  - stream() retries a later round's call too, where it used to end the turn.
 *  - The error membrane ends with says how many times it sent the request
 *    (`attempts`), on complete(), stream() and streamYielding().
 *  - `retryRateLimits: false` leaves a 429 to the caller on all three.
 */

import { describe, it, expect, vi } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { MockAdapter } from '../../src/providers/mock.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { MembraneError, serverError } from '../../src/types/errors.js';
import type {
  NormalizedRequest,
  ProviderAdapter,
  ProviderRequest,
  ProviderRequestOptions,
  ProviderResponse,
  StreamCallbacks,
  StreamEvent,
  ToolDefinition,
} from '../../src/types/index.js';
import type { BackoffEvent } from '../../src/types/yielding-stream.js';

const zzTool: ToolDefinition = {
  name: 'zz_tool',
  description: 'zz no-op',
  inputSchema: { type: 'object', properties: {} },
};

const overloaded529 = () => serverError('zz overloaded', 529);
const rateLimited429 = (retryAfterMs?: number) =>
  new MembraneError({
    type: 'rate_limit',
    message: 'zz slow down',
    retryable: true,
    httpStatus: 429,
    providerErrorCode: 'rate_limit_exceeded',
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    rawError: undefined,
  });

/**
 * One provider call each: a failure (after an optional chunk), or a response
 * with optional text and an optional tool call.
 */
type Step =
  | { fail: () => Error; emitFirst?: string; emitBlock?: boolean; emitSignature?: boolean }
  | { refuse: string }
  | { text?: string; toolCall?: string };

/** Native-mode adapter that plays a script, one step per provider call. */
class ScriptedNativeAdapter implements ProviderAdapter {
  readonly name = 'zz-scripted';
  sends = 0;
  constructor(private steps: Step[]) {}

  supportsModel(): boolean {
    return true;
  }

  private next(): Step {
    this.sends++;
    const step = this.steps.shift();
    if (!step) throw new Error('zz script ran out');
    return step;
  }

  private respond(step: { text?: string; toolCall?: string } | { refuse: string }): ProviderResponse {
    if ('refuse' in step) {
      return {
        content: [{ type: 'text', text: step.refuse }],
        stopReason: 'refusal',
        usage: { inputTokens: 1, outputTokens: 1 },
        raw: { response: { stop_reason: 'refusal' } },
      } as unknown as ProviderResponse;
    }
    const content: unknown[] = [];
    if (step.text) content.push({ type: 'text', text: step.text });
    if (step.toolCall) content.push({ type: 'tool_use', id: step.toolCall, name: 'zz_tool', input: {} });
    return {
      content,
      stopReason: step.toolCall ? 'tool_use' : 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
      raw: {},
    } as unknown as ProviderResponse;
  }

  async complete(_request: ProviderRequest, _options?: ProviderRequestOptions): Promise<ProviderResponse> {
    const step = this.next();
    if ('fail' in step) throw step.fail();
    return this.respond(step);
  }

  async stream(
    _request: ProviderRequest,
    callbacks: StreamCallbacks,
    _options?: ProviderRequestOptions,
  ): Promise<ProviderResponse> {
    const step = this.next();
    if ('fail' in step) {
      if (step.emitFirst) callbacks.onChunk(step.emitFirst);
      if (step.emitBlock) callbacks.onContentBlock?.(0, { type: 'text', text: '' });
      if (step.emitSignature) callbacks.onThinkingSignature?.(0, 'zz-signature');
      throw step.fail();
    }
    if ('refuse' in step) callbacks.onChunk(step.refuse);
    else if (step.text) callbacks.onChunk(step.text);
    return this.respond(step);
  }
}

/** XML-mode adapter: MockAdapter's text responses, with scripted failures first. */
class FlakyXmlAdapter extends MockAdapter {
  sends = 0;
  constructor(private failAt: Map<number, () => Error>) {
    super();
  }

  override async stream(
    request: ProviderRequest,
    callbacks: StreamCallbacks,
    options?: ProviderRequestOptions,
  ): Promise<ProviderResponse> {
    this.sends++;
    const fail = this.failAt.get(this.sends);
    if (fail) throw fail();
    return super.stream(request, callbacks, options);
  }
}

const NATIVE_REQUEST: NormalizedRequest = {
  messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz go' }] }],
  config: { model: 'zz-model', maxTokens: 100 },
  tools: [zzTool],
};

const XML_REQUEST: NormalizedRequest = { ...NATIVE_REQUEST, toolMode: 'xml' };

const XML_TOOL_CALL =
  'zz before\n<function_calls><invoke name="zz_tool"><parameter name="i">1</parameter></invoke></function_calls>';

/**
 * Distinct schedules, so a wait shows which one it was drawn from: the
 * overloaded one is jittered into [20, 40), the base one is exactly 3.
 */
const SCHEDULES = {
  retry: {
    // One attempt for a 5xx or a connection failure, so the cases below see
    // only the 529 and 429 rules; the base default has cases of its own.
    maxRetries: 1,
    retryDelayMs: 3,
    maxRetryDelayMs: 3,
    backoffMultiplier: 1,
    overloaded: { maxRetries: 4, retryDelayMs: 40, maxRetryDelayMs: 40, backoffMultiplier: 1 },
  },
};

const native = (adapter: ProviderAdapter, config: object = SCHEDULES) =>
  new Membrane(adapter, { formatter: new NativeFormatter(), ...config });

/** Drive a yielding stream to its end, answering every tool round. */
async function drive(
  stream: ReturnType<Membrane['streamYielding']>,
  onEvent?: (event: StreamEvent) => void,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
    onEvent?.(event);
    if (event.type === 'tool-calls') {
      stream.provideToolResults(event.calls.map((c) => ({ toolUseId: c.id, content: 'zz ok' })));
    }
  }
  return events;
}

const ofType = <T extends StreamEvent['type']>(events: StreamEvent[], type: T) =>
  events.filter((e): e is Extract<StreamEvent, { type: T }> => e.type === type);

/** The visible text the consumer received. */
const tokensOf = (events: StreamEvent[]) =>
  ofType(events, 'tokens').filter((e) => e.meta?.type === 'text').map((e) => e.content).join('');

describe('streamYielding() retries a call that failed before it delivered anything', () => {
  it('native: a 529 is retried on the overloaded schedule, one backoff event per wait', async () => {
    const adapter = new ScriptedNativeAdapter([
      { fail: overloaded529 },
      { fail: overloaded529 },
      { text: 'zz recovered' },
    ]);
    const events = await drive(native(adapter).streamYielding(NATIVE_REQUEST));

    expect(adapter.sends).toBe(3);
    const backoffs = ofType(events, 'backoff');
    expect(backoffs.map((e) => [e.schedule, e.attempt, e.maxAttempts])).toEqual([
      ['overloaded', 1, 3],
      ['overloaded', 2, 3],
    ]);
    for (const e of backoffs) {
      expect(e.delayMs).toBeGreaterThanOrEqual(20);
      expect(e.delayMs).toBeLessThan(40);
      expect(e.error).toBeInstanceOf(MembraneError);
      expect((e.error as MembraneError).httpStatus).toBe(529);
    }
    // Each wait's error carries the sends so far.
    expect(backoffs.map((e) => e.error.attempts)).toEqual([1, 2]);
    // The failed calls delivered nothing, so the text arrives once.
    expect(tokensOf(events)).toBe('zz recovered');
    const [complete] = ofType(events, 'complete');
    expect(complete!.response.details.timing.attempts).toBe(3);
    expect(complete!.response.details.timing.retryDelaysMs).toEqual(backoffs.map((e) => e.delayMs));
  });

  it('XML: a 529 is retried the same way', async () => {
    const adapter = new FlakyXmlAdapter(new Map([[1, overloaded529]]));
    adapter.queueResponse('zz recovered');
    const events = await drive(new Membrane(adapter, SCHEDULES).streamYielding(XML_REQUEST));

    expect(adapter.sends).toBe(2);
    expect(ofType(events, 'backoff').map((e) => [e.schedule, e.attempt])).toEqual([['overloaded', 1]]);
    expect(tokensOf(events)).toBe('zz recovered');
    const [complete] = ofType(events, 'complete');
    expect(complete!.response.details.timing.attempts).toBe(2);
    expect(complete!.response.details.timing.retryDelaysMs).toHaveLength(1);
  });

  it('a 429 is retried on the base schedule', async () => {
    const adapter = new ScriptedNativeAdapter([{ fail: () => rateLimited429() }, { text: 'zz ok' }]);
    const events = await drive(native(adapter).streamYielding(NATIVE_REQUEST));

    expect(adapter.sends).toBe(2);
    // The base schedule, unjittered, and the 429 floor of five attempts.
    expect(ofType(events, 'backoff').map((e) => [e.schedule, e.attempt, e.maxAttempts, e.delayMs])).toEqual([
      ['base', 1, 4, 3],
    ]);
    expect(ofType(events, 'complete')).toHaveLength(1);
  });

  it('a call that has delivered something is not retried', async () => {
    const adapter = new ScriptedNativeAdapter([{ fail: overloaded529, emitFirst: 'zz partial ' }, { text: 'zz never' }]);
    const events = await drive(native(adapter).streamYielding(NATIVE_REQUEST));

    expect(adapter.sends).toBe(1);
    expect(ofType(events, 'backoff')).toHaveLength(0);
    expect(tokensOf(events)).toBe('zz partial ');
    const [error] = ofType(events, 'error');
    expect(error!.error).toMatchObject({ httpStatus: 529, attempts: 1 });
  });

  it.each([
    ['a content block', { emitBlock: true }],
    ['only a thinking signature', { emitSignature: true }],
  ] as const)('a call that has delivered %s is not retried either', async (_what, emitted) => {
    const adapter = new ScriptedNativeAdapter([{ fail: overloaded529, ...emitted }, { text: 'zz never' }]);
    const events = await drive(native(adapter).streamYielding(NATIVE_REQUEST));

    expect(adapter.sends).toBe(1);
    expect(ofType(events, 'backoff')).toHaveLength(0);
    expect(ofType(events, 'error')[0]!.error).toMatchObject({ httpStatus: 529, attempts: 1 });
  });

  it('native: a later round is retried too, and the earlier round stands', async () => {
    const adapter = new ScriptedNativeAdapter([
      { text: 'zz round one', toolCall: 'zz_call_1' },
      { fail: overloaded529 },
      { text: 'zz round two' },
    ]);
    const events = await drive(native(adapter).streamYielding(NATIVE_REQUEST));

    expect(adapter.sends).toBe(3);
    expect(ofType(events, 'tool-calls')).toHaveLength(1);
    expect(ofType(events, 'backoff').map((e) => e.attempt)).toEqual([1]);
    expect(tokensOf(events)).toBe('zz round onezz round two');
    const [complete] = ofType(events, 'complete');
    expect(complete!.response.details.timing).toMatchObject({ attempts: 3, rounds: 2 });
  });

  it('XML: a later round is retried too', async () => {
    const adapter = new FlakyXmlAdapter(new Map([[2, overloaded529]]));
    adapter.queueResponses([XML_TOOL_CALL, 'zz round two']);
    const events = await drive(new Membrane(adapter, SCHEDULES).streamYielding(XML_REQUEST));

    expect(adapter.sends).toBe(3);
    expect(ofType(events, 'tool-calls')).toHaveLength(1);
    expect(ofType(events, 'backoff')).toHaveLength(1);
    expect(tokensOf(events)).toContain('zz round two');
    expect(tokensOf(events).match(/zz round two/g)).toHaveLength(1);
    expect(ofType(events, 'complete')).toHaveLength(1);
  });

  it('gives up after the schedule, and the error says how many times it sent the request', async () => {
    const adapter = new ScriptedNativeAdapter(Array.from({ length: 10 }, () => ({ fail: overloaded529 })));
    const events = await drive(native(adapter).streamYielding(NATIVE_REQUEST));

    // overloaded.maxRetries bounds the attempts in all.
    expect(adapter.sends).toBe(4);
    expect(ofType(events, 'backoff')).toHaveLength(3);
    const [error] = ofType(events, 'error');
    expect(error!.error).toMatchObject({ httpStatus: 529, attempts: 4 });
  });

  it('consults hooks.onError before each wait, and its abort ends the stream', async () => {
    const adapter = new ScriptedNativeAdapter([{ fail: overloaded529 }, { text: 'zz never' }]);
    const seen: number[] = [];
    const membrane = native(adapter, {
      ...SCHEDULES,
      hooks: { onError: (_info: unknown, attempt: number) => { seen.push(attempt); return 'abort' as const; } },
    });
    const events = await drive(membrane.streamYielding(NATIVE_REQUEST));

    expect(seen).toEqual([1]);
    expect(adapter.sends).toBe(1);
    expect(ofType(events, 'backoff')).toHaveLength(0);
    expect(ofType(events, 'error')[0]!.error).toMatchObject({ httpStatus: 529, attempts: 1 });
  });
});

describe('the backoff wait ends when the stream is stopped', () => {
  const SLOW = { retry: { overloaded: { maxRetries: 5, retryDelayMs: 400, maxRetryDelayMs: 400, backoffMultiplier: 1 } } };

  /**
   * Runs `body` with the wait's timer faked and never advanced, so only the
   * stop under test can end a wait. Afterwards every timer still set is run:
   * a wait that outlived the stop would send the call again then.
   */
  async function withHeldWaits(body: () => Promise<void>): Promise<void> {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await body();
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }
  }

  it('cancel() during the wait ends the stream with aborted, and nothing is sent again', async () => {
    const adapter = new ScriptedNativeAdapter([{ fail: overloaded529 }, { text: 'zz never' }]);
    await withHeldWaits(async () => {
      const stream = native(adapter, SLOW).streamYielding(NATIVE_REQUEST);
      const events = await drive(stream, (event) => { if (event.type === 'backoff') stream.cancel(); });

      expect(events.map((e) => e.type)).toEqual(['backoff', 'aborted']);
      expect(ofType(events, 'aborted')[0]!.reason).toBe('user');
    });
    expect(adapter.sends).toBe(1);
  });

  it('XML: cancel() during the wait does the same', async () => {
    const adapter = new FlakyXmlAdapter(new Map([[1, overloaded529]]));
    adapter.queueResponses(['zz never']);
    await withHeldWaits(async () => {
      const stream = new Membrane(adapter, SLOW).streamYielding(XML_REQUEST);
      const events = await drive(stream, (event) => { if (event.type === 'backoff') stream.cancel(); });

      expect(events.map((e) => e.type)).toEqual(['backoff', 'aborted']);
    });
    expect(adapter.sends).toBe(1);
  });

  it('a consumer that stops reading during the wait ends it too', async () => {
    const adapter = new ScriptedNativeAdapter([{ fail: overloaded529 }, { text: 'zz never' }]);
    await withHeldWaits(async () => {
      const seen: string[] = [];
      for await (const event of native(adapter, SLOW).streamYielding(NATIVE_REQUEST)) {
        seen.push(event.type);
        if (event.type === 'backoff') break;
      }
      expect(seen).toEqual(['backoff']);
    });
    expect(adapter.sends).toBe(1);
  });

  it('cancel() while onError decides: no backoff event after aborted, and nothing sent again', async () => {
    const adapter = new ScriptedNativeAdapter([{ fail: overloaded529 }, { text: 'zz never' }]);
    let stream!: ReturnType<Membrane['streamYielding']>;
    let returned!: () => void;
    const onErrorReturned = new Promise<void>((resolve) => { returned = resolve; });
    const membrane = native(adapter, {
      ...SLOW,
      hooks: {
        onError: async () => {
          stream.cancel();
          await new Promise((resolve) => setTimeout(resolve, 0));
          returned();
          return 'retry' as const;
        },
      },
    });
    stream = membrane.streamYielding(NATIVE_REQUEST);
    // Start the stream, and read it only once the runner is past onError: a
    // consumer that hasn't drained sees whatever was queued after `aborted`.
    const iterator = stream[Symbol.asyncIterator]();
    await onErrorReturned;
    await new Promise((resolve) => setTimeout(resolve, 0));
    const events: StreamEvent[] = [];
    for (;;) {
      const { value, done } = await iterator.next();
      if (done) break;
      events.push(value);
    }

    expect(events.map((e) => e.type)).toEqual(['aborted']);
    expect(adapter.sends).toBe(1);
  });

  it("the caller's signal during the wait does the same", async () => {
    const adapter = new ScriptedNativeAdapter([{ fail: overloaded529 }, { text: 'zz never' }]);
    await withHeldWaits(async () => {
      const controller = new AbortController();
      const stream = native(adapter, SLOW).streamYielding(NATIVE_REQUEST, { signal: controller.signal });
      const events = await drive(stream, (event) => { if (event.type === 'backoff') controller.abort(); });

      expect(events.map((e) => e.type)).toEqual(['backoff', 'aborted']);
    });
    expect(adapter.sends).toBe(1);
  });

  it("stream(): the caller's signal in a later round's wait returns what the earlier round delivered", async () => {
    const adapter = new ScriptedNativeAdapter([
      { text: 'zz round one', toolCall: 'zz_call_1' },
      { fail: overloaded529 },
      { text: 'zz never' },
    ]);
    const controller = new AbortController();
    let decided = 0;
    const membrane = native(adapter, {
      ...SLOW,
      hooks: {
        // The wait begins as soon as onError has decided, before any timer
        // can fire, so this abort lands inside it.
        onError: () => {
          decided++;
          setTimeout(() => controller.abort(), 0);
          return 'retry' as const;
        },
      },
    });
    const result = await membrane.stream(NATIVE_REQUEST, {
      signal: controller.signal,
      onToolCalls: async (calls) => calls.map((c) => ({ toolUseId: c.id, content: 'zz ok' })),
    });

    expect(decided).toBe(1);
    expect(result).toMatchObject({ aborted: true, reason: 'user', rawAssistantText: 'zz round one' });
    expect((result as { toolCalls?: unknown[] }).toolCalls).toHaveLength(1);
    expect(adapter.sends).toBe(2);
  });
});

describe('stream() retries a later round the same way', () => {
  it('a 529 on the call after a tool round is retried, where it used to end the turn', async () => {
    const adapter = new ScriptedNativeAdapter([
      { text: 'zz round one', toolCall: 'zz_call_1' },
      { fail: overloaded529 },
      { text: 'zz round two' },
    ]);
    const chunks: string[] = [];
    const result = await native(adapter).stream(NATIVE_REQUEST, {
      onChunk: (text, meta) => { if (meta?.type === 'text') chunks.push(text); },
      onToolCalls: async (calls) => calls.map((c) => ({ toolUseId: c.id, content: 'zz ok' })),
    });

    expect(adapter.sends).toBe(3);
    expect(chunks.join('')).toBe('zz round onezz round two');
    expect('details' in result && result.details.timing).toMatchObject({ attempts: 3, rounds: 2 });
    expect('details' in result && result.details.timing.retryDelaysMs).toHaveLength(1);
  });
});

describe('the error says how many times membrane sent the request', () => {
  it('complete(): every send, retries included', async () => {
    const adapter = new ScriptedNativeAdapter(Array.from({ length: 10 }, () => ({ fail: overloaded529 })));
    await expect(native(adapter).complete(NATIVE_REQUEST)).rejects.toMatchObject({ httpStatus: 529, attempts: 4 });
    expect(adapter.sends).toBe(4);
  });

  it('complete(): 1 for an error that is not retried', async () => {
    const adapter = new ScriptedNativeAdapter([{ fail: () => serverError('zz internal', 500) }]);
    await expect(native(adapter).complete(NATIVE_REQUEST)).rejects.toMatchObject({ httpStatus: 500, attempts: 1 });
  });

  it('stream(): the sends of the call that failed', async () => {
    const adapter = new ScriptedNativeAdapter(Array.from({ length: 10 }, () => ({ fail: overloaded529 })));
    await expect(native(adapter).stream(NATIVE_REQUEST)).rejects.toMatchObject({ httpStatus: 529, attempts: 4 });
  });

  it('complete(): a cancellation after a send says how many sends there were', async () => {
    // Cancelled during the wait, after one send.
    const waiting = new ScriptedNativeAdapter([{ fail: overloaded529 }, { text: 'zz never' }]);
    const duringWait = new AbortController();
    const membrane = native(waiting, {
      ...SCHEDULES,
      hooks: { onError: () => { setTimeout(() => duringWait.abort(), 0); return 'retry' as const; } },
    });
    await expect(membrane.complete(NATIVE_REQUEST, { signal: duringWait.signal })).rejects.toMatchObject({
      type: 'abort',
      attempts: 1,
    });
    expect(waiting.sends).toBe(1);

    // Cancelled during the second send.
    const duringSend = new AbortController();
    const sending = new ScriptedNativeAdapter([
      { fail: overloaded529 },
      { fail: () => { duringSend.abort(); return new DOMException('zz aborted', 'AbortError'); } },
    ]);
    await expect(native(sending).complete(NATIVE_REQUEST, { signal: duringSend.signal })).rejects.toMatchObject({
      type: 'abort',
      attempts: 2,
    });
  });

  it('stream() and streamYielding(): a raw error an adapter throws keeps the count', async () => {
    // What fetch throws when the connection fails: not a MembraneError yet.
    const raw = () => new TypeError('fetch failed');
    const config = { retry: { ...SCHEDULES.retry, maxRetries: 3 } };
    const forStream = new ScriptedNativeAdapter(Array.from({ length: 5 }, () => ({ fail: raw })));
    await expect(native(forStream, config).stream(NATIVE_REQUEST)).rejects.toMatchObject({
      type: 'network',
      attempts: 3,
    });
    const forYielding = new ScriptedNativeAdapter(Array.from({ length: 5 }, () => ({ fail: raw })));
    const events = await drive(native(forYielding, config).streamYielding(NATIVE_REQUEST));
    expect(ofType(events, 'error')[0]!.error).toMatchObject({ type: 'network', attempts: 3 });
    expect(forYielding.sends).toBe(3);
  });

  it('stream(): a later round counts its own sends, not the earlier rounds', async () => {
    const adapter = new ScriptedNativeAdapter([
      { text: 'zz round one', toolCall: 'zz_call_1' },
      { fail: () => serverError('zz internal', 500) },
    ]);
    await expect(
      native(adapter).stream(NATIVE_REQUEST, {
        onToolCalls: async (calls) => calls.map((c) => ({ toolUseId: c.id, content: 'zz ok' })),
      }),
    ).rejects.toMatchObject({ httpStatus: 500, attempts: 1 });
    expect(adapter.sends).toBe(2);
  });
});

describe('attempts counts the sends membrane retried for this failure', () => {
  it('streamYielding(): a 529 after output on the re-issue reports attempts 1', async () => {
    const adapter = new ScriptedNativeAdapter([
      { refuse: 'zz refused' },
      { fail: overloaded529, emitFirst: 'zz partial ' },
      { text: 'zz never' },
    ]);
    const events = await drive(native(adapter).streamYielding(NATIVE_REQUEST, { refusalRetries: 1 }));

    expect(adapter.sends).toBe(2);
    expect(ofType(events, 'retrying')).toHaveLength(1);
    // Membrane re-issued the refusal but never retried the 529.
    expect(ofType(events, 'error')[0]!.error).toMatchObject({ httpStatus: 529, attempts: 1 });
  });

  it('streamYielding(): a 529 before output on the re-issue is the first retry, not the second', async () => {
    const adapter = new ScriptedNativeAdapter([
      { refuse: 'zz refused' },
      { fail: overloaded529 },
      { text: 'zz ok' },
    ]);
    const events = await drive(native(adapter).streamYielding(NATIVE_REQUEST, { refusalRetries: 1 }));

    expect(adapter.sends).toBe(3);
    expect(ofType(events, 'backoff').map((e) => [e.attempt, e.maxAttempts])).toEqual([[1, 3]]);
    const [complete] = ofType(events, 'complete');
    // The response still counts every provider call.
    expect(complete!.response.details.timing.attempts).toBe(3);
  });

  it('a retried call that then fails after delivering reports attempts 1: membrane did not retry that failure', async () => {
    const adapter = new ScriptedNativeAdapter([
      { fail: overloaded529 },
      { fail: overloaded529, emitFirst: 'zz partial ' },
      { text: 'zz never' },
    ]);
    const events = await drive(native(adapter).streamYielding(NATIVE_REQUEST));

    expect(adapter.sends).toBe(2);
    expect(ofType(events, 'backoff')).toHaveLength(1);
    expect(ofType(events, 'error')[0]!.error).toMatchObject({ httpStatus: 529, attempts: 1 });
  });

  it('complete(): the re-issue gets the whole transport budget again', async () => {
    const adapter = new ScriptedNativeAdapter([
      { refuse: 'zz refused' },
      ...Array.from({ length: 10 }, () => ({ fail: overloaded529 })),
    ]);
    await expect(native(adapter).complete(NATIVE_REQUEST, { refusalRetries: 1 })).rejects.toMatchObject({
      httpStatus: 529,
      attempts: 4,
    });
    // One refused send, then overloaded.maxRetries (4) sends of the re-issue.
    expect(adapter.sends).toBe(5);
  });
});

describe('retryRateLimits: false leaves a 429 to the caller', () => {
  it('streamYielding(): the stream ends with the 429 at once, with its stated wait', async () => {
    const adapter = new ScriptedNativeAdapter([{ fail: () => rateLimited429(1500) }, { text: 'zz never' }]);
    const events = await drive(native(adapter).streamYielding(NATIVE_REQUEST, { retryRateLimits: false }));

    expect(adapter.sends).toBe(1);
    expect(ofType(events, 'backoff')).toHaveLength(0);
    expect(ofType(events, 'error')[0]!.error).toMatchObject({ type: 'rate_limit', retryAfterMs: 1500, attempts: 1 });
  });

  it('streamYielding(): a 529 is still retried', async () => {
    const adapter = new ScriptedNativeAdapter([{ fail: overloaded529 }, { text: 'zz ok' }]);
    const events = await drive(native(adapter).streamYielding(NATIVE_REQUEST, { retryRateLimits: false }));

    expect(adapter.sends).toBe(2);
    expect(ofType(events, 'backoff').map((e) => e.schedule)).toEqual(['overloaded']);
    expect(ofType(events, 'complete')).toHaveLength(1);
  });

  it('stream(): thrown at once, even with base retries configured', async () => {
    const adapter = new ScriptedNativeAdapter([{ fail: () => rateLimited429() }, { text: 'zz never' }]);
    const membrane = native(adapter, { retry: { ...SCHEDULES.retry, maxRetries: 3 } });
    await expect(membrane.stream(NATIVE_REQUEST, { retryRateLimits: false })).rejects.toMatchObject({
      type: 'rate_limit',
      attempts: 1,
    });
    expect(adapter.sends).toBe(1);
  });

  it('complete(): thrown at once, even with base retries configured', async () => {
    const adapter = new ScriptedNativeAdapter([{ fail: () => rateLimited429() }, { text: 'zz never' }]);
    const membrane = native(adapter, { retry: { ...SCHEDULES.retry, maxRetries: 3 } });
    await expect(membrane.complete(NATIVE_REQUEST, { retryRateLimits: false })).rejects.toMatchObject({
      type: 'rate_limit',
      attempts: 1,
    });
    expect(adapter.sends).toBe(1);
  });

  it('complete(): other retryable errors keep their retries', async () => {
    const adapter = new ScriptedNativeAdapter([{ fail: () => serverError('zz internal', 500) }, { text: 'zz ok' }]);
    const membrane = native(adapter, { retry: { ...SCHEDULES.retry, maxRetries: 3 } });
    const response = await membrane.complete(NATIVE_REQUEST, { retryRateLimits: false });
    expect(response.content[0]).toMatchObject({ type: 'text', text: 'zz ok' });
    expect(adapter.sends).toBe(2);
  });

  it('stream() with streaming: false hands the option to complete()', async () => {
    const adapter = new ScriptedNativeAdapter([{ fail: () => rateLimited429() }, { text: 'zz never' }]);
    await expect(
      native(adapter).stream({ ...NATIVE_REQUEST, streaming: false }, { retryRateLimits: false }),
    ).rejects.toMatchObject({ type: 'rate_limit', attempts: 1 });
    expect(adapter.sends).toBe(1);
  });
});

describe('a stated wait longer than the ceiling is given to the caller, not retried inside', () => {
  // SCHEDULES caps the base wait at 3 ms and the overloaded one at 40 ms.
  it('streamYielding(): a 429 asking for longer ends the stream at once', async () => {
    const adapter = new ScriptedNativeAdapter([{ fail: () => rateLimited429(5_000) }, { text: 'zz never' }]);
    const events = await drive(native(adapter).streamYielding(NATIVE_REQUEST));

    expect(adapter.sends).toBe(1);
    expect(ofType(events, 'backoff')).toHaveLength(0);
    expect(ofType(events, 'error')[0]!.error).toMatchObject({ retryAfterMs: 5_000, attempts: 1 });
  });

  it('stream(): the same', async () => {
    const adapter = new ScriptedNativeAdapter([{ fail: () => rateLimited429(5_000) }, { text: 'zz never' }]);
    await expect(native(adapter).stream(NATIVE_REQUEST)).rejects.toMatchObject({ retryAfterMs: 5_000, attempts: 1 });
    expect(adapter.sends).toBe(1);
  });

  it('a 429 is held to the base ceiling, not the overloaded one', async () => {
    // 20 ms is over the base ceiling and under the overloaded one.
    const adapter = new ScriptedNativeAdapter([{ fail: () => rateLimited429(20) }, { text: 'zz never' }]);
    const events = await drive(native(adapter).streamYielding(NATIVE_REQUEST));

    expect(adapter.sends).toBe(1);
    expect(ofType(events, 'backoff')).toHaveLength(0);
    expect(ofType(events, 'error')[0]!.error).toMatchObject({ retryAfterMs: 20, attempts: 1 });
  });

  it('a 529 is held to the overloaded ceiling', async () => {
    const overloadedFor = (retryAfterMs: number) => () =>
      new MembraneError({ ...overloaded529().toErrorInfo(), retryAfterMs });
    const over = new ScriptedNativeAdapter([{ fail: overloadedFor(41) }, { text: 'zz never' }]);
    await expect(native(over).complete(NATIVE_REQUEST)).rejects.toMatchObject({ httpStatus: 529, attempts: 1 });
    expect(over.sends).toBe(1);

    // At the ceiling it is waited out: the wait is the stated one.
    const at = new ScriptedNativeAdapter([{ fail: overloadedFor(40) }, { text: 'zz ok' }]);
    const events = await drive(native(at).streamYielding(NATIVE_REQUEST));
    expect(at.sends).toBe(2);
    expect(ofType(events, 'backoff').map((e) => e.delayMs)).toEqual([40]);
  });
});

// Keeps the BackoffEvent type import honest: the event's shape is public.
const _shape: BackoffEvent = {
  type: 'backoff', schedule: 'overloaded', attempt: 1, maxAttempts: 1, delayMs: 0, error: overloaded529(),
};
void _shape;
