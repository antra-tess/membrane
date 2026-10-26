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

type Step =
  | { fail: () => Error; emitFirst?: string; emitBlock?: boolean; emitSignature?: boolean }
  | { refuse: string }
  | { text?: string; toolCall?: string };

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

const SCHEDULES = {
  retry: {
    maxRetries: 1,
    retryDelayMs: 3,
    maxRetryDelayMs: 3,
    backoffMultiplier: 1,
    overloaded: { maxRetries: 4, retryDelayMs: 40, maxRetryDelayMs: 40, backoffMultiplier: 1 },
  },
};

const native = (adapter: ProviderAdapter, config: object = SCHEDULES) =>
  new Membrane(adapter, { formatter: new NativeFormatter(), ...config });

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

const tokensOf = (events: StreamEvent[]) =>
  ofType(events, 'tokens').filter((e) => e.meta?.type === 'text').map((e) => e.content).join('');

describe('streamYielding() retries a call that failed before it delivered anything', () => {
  it('native: a 529 is retried on the overloaded schedule', async () => {
    const adapter = new ScriptedNativeAdapter([
      { fail: overloaded529 },
      { fail: overloaded529 },
      { text: 'zz recovered' },
    ]);
    const events = await drive(native(adapter).streamYielding(NATIVE_REQUEST));

    expect(adapter.sends).toBe(3);
    expect(tokensOf(events)).toBe('zz recovered');
    const [complete] = ofType(events, 'complete');
    expect(complete!.response.details.timing.attempts).toBe(3);
    const waits = complete!.response.details.timing.retryDelaysMs!;
    expect(waits).toHaveLength(2);
    for (const delayMs of waits) {
      expect(delayMs).toBeGreaterThanOrEqual(20);
      expect(delayMs).toBeLessThan(40);
    }
  });

  it('XML: a 529 is retried the same way', async () => {
    const adapter = new FlakyXmlAdapter(new Map([[1, overloaded529]]));
    adapter.queueResponse('zz recovered');
    const events = await drive(new Membrane(adapter, SCHEDULES).streamYielding(XML_REQUEST));

    expect(adapter.sends).toBe(2);
    expect(tokensOf(events)).toBe('zz recovered');
    const [complete] = ofType(events, 'complete');
    expect(complete!.response.details.timing.attempts).toBe(2);
    const [delayMs] = complete!.response.details.timing.retryDelaysMs!;
    expect(delayMs).toBeGreaterThanOrEqual(20);
    expect(delayMs).toBeLessThan(40);
  });

  it('a 429 is retried on the base schedule, with its floor of five attempts', async () => {
    const adapter = new ScriptedNativeAdapter([
      ...Array.from({ length: 4 }, () => ({ fail: () => rateLimited429() })),
      { text: 'zz ok' },
    ]);
    const events = await drive(native(adapter).streamYielding(NATIVE_REQUEST));

    expect(adapter.sends).toBe(5);
    const [complete] = ofType(events, 'complete');
    expect(complete!.response.details.timing.retryDelaysMs).toEqual([3, 3, 3, 3]);
  });

  it('a call that has delivered something is not retried', async () => {
    const adapter = new ScriptedNativeAdapter([{ fail: overloaded529, emitFirst: 'zz partial ' }, { text: 'zz never' }]);
    const events = await drive(native(adapter).streamYielding(NATIVE_REQUEST));

    expect(adapter.sends).toBe(1);
    expect(tokensOf(events)).toBe('zz partial ');
    const [error] = ofType(events, 'error');
    expect(error!.error).toMatchObject({ httpStatus: 529 });
  });

  it.each([
    ['a content block', { emitBlock: true }],
    ['only a thinking signature', { emitSignature: true }],
  ] as const)('a call that has delivered %s is not retried either', async (_what, emitted) => {
    const adapter = new ScriptedNativeAdapter([{ fail: overloaded529, ...emitted }, { text: 'zz never' }]);
    const events = await drive(native(adapter).streamYielding(NATIVE_REQUEST));

    expect(adapter.sends).toBe(1);
    expect(ofType(events, 'error')[0]!.error).toMatchObject({ httpStatus: 529 });
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
    expect(tokensOf(events)).toBe('zz round onezz round two');
    const [complete] = ofType(events, 'complete');
    expect(complete!.response.details.timing).toMatchObject({ attempts: 3, rounds: 2 });
    expect(complete!.response.details.timing.retryDelaysMs).toHaveLength(1);
  });

  it('XML: a later round is retried too', async () => {
    const adapter = new FlakyXmlAdapter(new Map([[2, overloaded529]]));
    adapter.queueResponses([XML_TOOL_CALL, 'zz round two']);
    const events = await drive(new Membrane(adapter, SCHEDULES).streamYielding(XML_REQUEST));

    expect(adapter.sends).toBe(3);
    expect(ofType(events, 'tool-calls')).toHaveLength(1);
    expect(tokensOf(events)).toContain('zz round two');
    expect(tokensOf(events).match(/zz round two/g)).toHaveLength(1);
    const [complete] = ofType(events, 'complete');
    expect(complete!.response.details.timing.retryDelaysMs).toHaveLength(1);
  });

  it('gives up after the schedule', async () => {
    const adapter = new ScriptedNativeAdapter(Array.from({ length: 10 }, () => ({ fail: overloaded529 })));
    const events = await drive(native(adapter).streamYielding(NATIVE_REQUEST));

    expect(adapter.sends).toBe(SCHEDULES.retry.overloaded.maxRetries);
    const [error] = ofType(events, 'error');
    expect(error!.error).toBeInstanceOf(MembraneError);
    expect(error!.error).toMatchObject({ httpStatus: 529 });
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
    expect(ofType(events, 'error')[0]!.error).toMatchObject({ httpStatus: 529 });
  });
});

describe('the wait before a retry ends when the stream is stopped', () => {
  const SLOW = { retry: { overloaded: { maxRetries: 5, retryDelayMs: 400, maxRetryDelayMs: 400, backoffMultiplier: 1 } } };

  async function withHeldWaits(body: () => Promise<void>): Promise<void> {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await body();
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }
  }

  async function waitBegun(): Promise<void> {
    for (let hop = 0; hop < 50 && vi.getTimerCount() === 0; hop++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(vi.getTimerCount()).toBe(1);
  }

  it('cancel() during the wait ends the stream with aborted, and nothing is sent again', async () => {
    const adapter = new ScriptedNativeAdapter([{ fail: overloaded529 }, { text: 'zz never' }]);
    await withHeldWaits(async () => {
      const stream = native(adapter, SLOW).streamYielding(NATIVE_REQUEST);
      const driven = drive(stream);
      await waitBegun();
      stream.cancel();
      const events = await driven;

      expect(events.map((e) => e.type)).toEqual(['aborted']);
      expect(ofType(events, 'aborted')[0]!.reason).toBe('user');
    });
    expect(adapter.sends).toBe(1);
  });

  it('XML: cancel() during the wait does the same', async () => {
    const adapter = new FlakyXmlAdapter(new Map([[1, overloaded529]]));
    adapter.queueResponses(['zz never']);
    await withHeldWaits(async () => {
      const stream = new Membrane(adapter, SLOW).streamYielding(XML_REQUEST);
      const driven = drive(stream);
      await waitBegun();
      stream.cancel();

      expect((await driven).map((e) => e.type)).toEqual(['aborted']);
    });
    expect(adapter.sends).toBe(1);
  });

  it('a consumer that stops reading during the wait ends it too', async () => {
    const adapter = new ScriptedNativeAdapter([{ fail: overloaded529 }, { text: 'zz never' }]);
    await withHeldWaits(async () => {
      const iterator = native(adapter, SLOW).streamYielding(NATIVE_REQUEST)[Symbol.asyncIterator]();
      const pending = iterator.next();
      await waitBegun();
      await iterator.return!();
      expect(await pending).toMatchObject({ done: true });
    });
    expect(adapter.sends).toBe(1);
  });

  it('cancel() while onError decides: the stream ends with aborted, and nothing is sent again, for a consumer that reads only after onError returns', async () => {
    const adapter = new ScriptedNativeAdapter([{ fail: overloaded529 }, { text: 'zz never' }]);
    await withHeldWaits(async () => {
      let stream!: ReturnType<Membrane['streamYielding']>;
      let returned!: () => void;
      const onErrorReturned = new Promise<void>((resolve) => { returned = resolve; });
      const membrane = native(adapter, {
        ...SLOW,
        hooks: {
          onError: async () => {
            stream.cancel();
            await new Promise((resolve) => setImmediate(resolve));
            returned();
            return 'retry' as const;
          },
        },
      });
      stream = membrane.streamYielding(NATIVE_REQUEST);
      const iterator = stream[Symbol.asyncIterator]();
      await onErrorReturned;
      await new Promise((resolve) => setImmediate(resolve));
      const events: StreamEvent[] = [];
      for (;;) {
        const { value, done } = await iterator.next();
        if (done) break;
        events.push(value);
      }
      expect(events.map((e) => e.type)).toEqual(['aborted']);
    });
    expect(adapter.sends).toBe(1);
  });

  it("the caller's signal during the wait does the same", async () => {
    const adapter = new ScriptedNativeAdapter([{ fail: overloaded529 }, { text: 'zz never' }]);
    await withHeldWaits(async () => {
      const controller = new AbortController();
      const driven = drive(native(adapter, SLOW).streamYielding(NATIVE_REQUEST, { signal: controller.signal }));
      await waitBegun();
      controller.abort();

      expect((await driven).map((e) => e.type)).toEqual(['aborted']);
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

describe('the sends a call gets, on each entry point', () => {
  it('complete(): a 529 gets the overloaded schedule, then its error', async () => {
    const adapter = new ScriptedNativeAdapter(Array.from({ length: 10 }, () => ({ fail: overloaded529 })));
    await expect(native(adapter).complete(NATIVE_REQUEST)).rejects.toMatchObject({ httpStatus: 529 });
    expect(adapter.sends).toBe(4);
  });

  it('stream(): the same', async () => {
    const adapter = new ScriptedNativeAdapter(Array.from({ length: 10 }, () => ({ fail: overloaded529 })));
    await expect(native(adapter).stream(NATIVE_REQUEST)).rejects.toMatchObject({ httpStatus: 529 });
    expect(adapter.sends).toBe(4);
  });

  it('complete(): a cancellation during the wait, or during a later send, ends it as a cancellation', async () => {
    const waiting = new ScriptedNativeAdapter([{ fail: overloaded529 }, { text: 'zz never' }]);
    const duringWait = new AbortController();
    const membrane = native(waiting, {
      ...SCHEDULES,
      hooks: { onError: () => { setTimeout(() => duringWait.abort(), 0); return 'retry' as const; } },
    });
    await expect(membrane.complete(NATIVE_REQUEST, { signal: duringWait.signal })).rejects.toMatchObject({ type: 'abort' });
    expect(waiting.sends).toBe(1);

    const duringSend = new AbortController();
    const sending = new ScriptedNativeAdapter([
      { fail: overloaded529 },
      { fail: () => { duringSend.abort(); return new DOMException('zz aborted', 'AbortError'); } },
    ]);
    await expect(native(sending).complete(NATIVE_REQUEST, { signal: duringSend.signal })).rejects.toMatchObject({ type: 'abort' });
    expect(sending.sends).toBe(2);
  });

  it('stream() and streamYielding(): a raw error an adapter throws is typed, and retried as its type', async () => {
    // Node's fetch rejects with TypeError('fetch failed') when the connection fails.
    const raw = () => new TypeError('fetch failed');
    const config = { retry: { ...SCHEDULES.retry, maxRetries: 3 } };
    const forStream = new ScriptedNativeAdapter(Array.from({ length: 5 }, () => ({ fail: raw })));
    await expect(native(forStream, config).stream(NATIVE_REQUEST)).rejects.toMatchObject({ type: 'network' });
    expect(forStream.sends).toBe(3);
    const forYielding = new ScriptedNativeAdapter(Array.from({ length: 5 }, () => ({ fail: raw })));
    const events = await drive(native(forYielding, config).streamYielding(NATIVE_REQUEST));
    const [error] = ofType(events, 'error');
    expect(error!.error).toBeInstanceOf(MembraneError);
    expect(error!.error).toMatchObject({ type: 'network' });
    expect(forYielding.sends).toBe(3);
  });

  it.each(['complete', 'streamYielding'] as const)('%s(): the next send waits out the reported wait', async (entry) => {
    const config = { retry: { maxRetries: 2, retryDelayMs: 1000, maxRetryDelayMs: 1000, backoffMultiplier: 1 } };
    const adapter = new ScriptedNativeAdapter([{ fail: () => serverError('zz internal', 503) }, { text: 'zz recovered' }]);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const membrane = native(adapter, config);
      const done = entry === 'complete'
        ? membrane.complete(NATIVE_REQUEST)
        : drive(membrane.streamYielding(NATIVE_REQUEST)).then((events) => ofType(events, 'complete')[0]!.response);
      for (let hop = 0; hop < 50 && vi.getTimerCount() === 0; hop++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(vi.getTimerCount()).toBe(1);
      expect(adapter.sends).toBe(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(adapter.sends).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      const response = await done;
      expect(adapter.sends).toBe(2);
      expect(response.details.timing.attempts).toBe(2);
      expect(response.details.timing.retryDelaysMs).toEqual([1000]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a refusal re-issue starts the transport budget again', () => {
  it.each(['complete', 'streamYielding'] as const)('%s(): after a re-issue, onError counts the failing sends from one again', async (entry) => {
    const adapter = new ScriptedNativeAdapter([
      { refuse: 'zz refused' },
      { fail: overloaded529 },
      { text: 'zz recovered' },
    ]);
    const onError = vi.fn(() => 'retry' as const);
    const membrane = native(adapter, { ...SCHEDULES, hooks: { onError } });
    if (entry === 'complete') await membrane.complete(NATIVE_REQUEST, { refusalRetries: 1 });
    else await drive(membrane.streamYielding(NATIVE_REQUEST, { refusalRetries: 1 }));

    expect(adapter.sends).toBe(3);
    expect(onError.mock.calls.map((call) => call[1])).toEqual([1]);
  });

  it.each(['complete', 'streamYielding'] as const)('%s(): retry: false leaves the re-issue the call asks for', async (entry) => {
    const adapter = new ScriptedNativeAdapter([{ refuse: 'zz refused' }, { text: 'zz answered' }]);
    const membrane = native(adapter);
    const response = entry === 'complete'
      ? await membrane.complete(NATIVE_REQUEST, { retry: false, refusalRetries: 1 })
      : ofType(await drive(membrane.streamYielding(NATIVE_REQUEST, { retry: false, refusalRetries: 1 })), 'complete')[0]!.response;

    expect(adapter.sends).toBe(2);
    expect(response.stopReason).toBe('end_turn');
  });

  it('streamYielding(): a 529 after output on the re-issue is not retried', async () => {
    const adapter = new ScriptedNativeAdapter([
      { refuse: 'zz refused' },
      { fail: overloaded529, emitFirst: 'zz partial ' },
      { text: 'zz never' },
    ]);
    const events = await drive(native(adapter).streamYielding(NATIVE_REQUEST, { refusalRetries: 1 }));

    expect(adapter.sends).toBe(2);
    expect(ofType(events, 'retrying')).toHaveLength(1);
    expect(ofType(events, 'error')[0]!.error).toMatchObject({ httpStatus: 529 });
  });

  it("streamYielding(): the re-issue's 529s get the whole schedule", async () => {
    const adapter = new ScriptedNativeAdapter([
      { refuse: 'zz refused' },
      { fail: overloaded529 },
      { fail: overloaded529 },
      { fail: overloaded529 },
      { text: 'zz ok' },
    ]);
    const events = await drive(native(adapter).streamYielding(NATIVE_REQUEST, { refusalRetries: 1 }));

    expect(adapter.sends).toBe(1 + SCHEDULES.retry.overloaded.maxRetries);
    const [complete] = ofType(events, 'complete');
    expect(complete!.response.details.timing.attempts).toBe(1 + SCHEDULES.retry.overloaded.maxRetries);
    expect(complete!.response.details.timing.retryDelaysMs).toHaveLength(3);
  });

  it('a retried call that then fails after delivering is not retried again', async () => {
    const adapter = new ScriptedNativeAdapter([
      { fail: overloaded529 },
      { fail: overloaded529, emitFirst: 'zz partial ' },
      { text: 'zz never' },
    ]);
    const events = await drive(native(adapter).streamYielding(NATIVE_REQUEST));

    expect(adapter.sends).toBe(2);
    expect(tokensOf(events)).toBe('zz partial ');
    expect(ofType(events, 'error')[0]!.error).toMatchObject({ httpStatus: 529 });
  });

  it('complete(): the re-issue gets the whole transport budget again', async () => {
    const adapter = new ScriptedNativeAdapter([
      { refuse: 'zz refused' },
      ...Array.from({ length: 10 }, () => ({ fail: overloaded529 })),
    ]);
    await expect(native(adapter).complete(NATIVE_REQUEST, { refusalRetries: 1 })).rejects.toMatchObject({ httpStatus: 529 });
    expect(adapter.sends).toBe(1 + SCHEDULES.retry.overloaded.maxRetries);
  });
});

describe('retry: false: membrane retries none of a call\'s failed requests, whatever fails', () => {
  const RETRYING = { retry: { ...SCHEDULES.retry, maxRetries: 3 } };
  const failures = [
    ['a 429', () => rateLimited429()],
    ['a 529', overloaded529],
    ['a 5xx', () => serverError('zz internal', 503)],
  ] as const;

  it.each(failures)('streamYielding(): %s ends the stream at once', async (_what, fail) => {
    const adapter = new ScriptedNativeAdapter([{ fail }, { text: 'zz never' }]);
    const events = await drive(native(adapter, RETRYING).streamYielding(NATIVE_REQUEST, { retry: false }));

    expect(adapter.sends).toBe(1);
    expect(ofType(events, 'error')[0]!.error).toMatchObject({ httpStatus: fail().httpStatus });
  });

  it("streamYielding(): a 429's stated wait reaches the caller", async () => {
    const withinBaseCeilingMs = RETRYING.retry.maxRetryDelayMs - 1;
    const adapter = new ScriptedNativeAdapter([{ fail: () => rateLimited429(withinBaseCeilingMs) }, { text: 'zz never' }]);
    const events = await drive(native(adapter, RETRYING).streamYielding(NATIVE_REQUEST, { retry: false }));

    expect(adapter.sends).toBe(1);
    expect(ofType(events, 'error')[0]!.error).toMatchObject({ type: 'rate_limit', retryAfterMs: withinBaseCeilingMs });
  });

  it('streamYielding(), XML: a 529 ends the stream at once', async () => {
    const adapter = new FlakyXmlAdapter(new Map([[1, overloaded529]]));
    adapter.queueResponses(['zz never']);
    const events = await drive(new Membrane(adapter, RETRYING).streamYielding(XML_REQUEST, { retry: false }));

    expect(adapter.sends).toBe(1);
    expect(ofType(events, 'error')[0]!.error).toMatchObject({ httpStatus: 529 });
  });

  it("streamYielding(): a later round's failure ends the turn, and the earlier round stands", async () => {
    const adapter = new ScriptedNativeAdapter([
      { text: 'zz round one', toolCall: 'zz_call_1' },
      { fail: overloaded529 },
      { text: 'zz never' },
    ]);
    const events = await drive(native(adapter, RETRYING).streamYielding(NATIVE_REQUEST, { retry: false }));

    expect(adapter.sends).toBe(2);
    expect(ofType(events, 'tool-calls')).toHaveLength(1);
    expect(tokensOf(events)).toBe('zz round one');
    expect(ofType(events, 'error')[0]!.error).toMatchObject({ httpStatus: 529 });
  });

  it.each(failures)('stream(): %s is thrown at once', async (_what, fail) => {
    const adapter = new ScriptedNativeAdapter([{ fail }, { text: 'zz never' }]);
    await expect(native(adapter, RETRYING).stream(NATIVE_REQUEST, { retry: false })).rejects.toMatchObject({
      httpStatus: fail().httpStatus,
    });
    expect(adapter.sends).toBe(1);
  });

  it('stream(), XML: a 529 is thrown at once', async () => {
    const adapter = new FlakyXmlAdapter(new Map([[1, overloaded529]]));
    adapter.queueResponses(['zz never']);
    await expect(new Membrane(adapter, RETRYING).stream(XML_REQUEST, { retry: false })).rejects.toMatchObject({
      httpStatus: 529,
    });
    expect(adapter.sends).toBe(1);
  });

  it.each(failures)('complete(): %s is thrown at once', async (_what, fail) => {
    const adapter = new ScriptedNativeAdapter([{ fail }, { text: 'zz never' }]);
    await expect(native(adapter, RETRYING).complete(NATIVE_REQUEST, { retry: false })).rejects.toMatchObject({
      httpStatus: fail().httpStatus,
    });
    expect(adapter.sends).toBe(1);
  });

  it('stream() with streaming: false hands the option to complete()', async () => {
    const adapter = new ScriptedNativeAdapter([{ fail: overloaded529 }, { text: 'zz never' }]);
    await expect(
      native(adapter, RETRYING).stream({ ...NATIVE_REQUEST, streaming: false }, { retry: false }),
    ).rejects.toMatchObject({ httpStatus: 529 });
    expect(adapter.sends).toBe(1);
  });

  it('hooks.onError, asked before each retry, is not asked', async () => {
    const onError = vi.fn(() => 'retry' as const);
    const adapter = new ScriptedNativeAdapter([{ fail: overloaded529 }, { fail: overloaded529 }]);
    const membrane = native(adapter, { ...RETRYING, hooks: { onError } });
    await expect(membrane.complete(NATIVE_REQUEST, { retry: false })).rejects.toMatchObject({ httpStatus: 529 });
    const events = await drive(membrane.streamYielding(NATIVE_REQUEST, { retry: false }));
    expect(ofType(events, 'error')).toHaveLength(1);
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('refusalRetries that isn\'t a finite number asks for no re-issue', () => {
  it.each([[NaN], [Infinity]])('complete(): %s re-issues nothing', async (asked) => {
    const adapter = new ScriptedNativeAdapter([{ refuse: 'zz refused' }, { text: 'zz never' }]);
    const response = await native(adapter).complete(NATIVE_REQUEST, { refusalRetries: asked });

    expect(adapter.sends).toBe(1);
    expect(response.stopReason).toBe('refusal');
  });

  it.each([[NaN], [Infinity]])('streamYielding(): %s re-issues nothing', async (asked) => {
    const adapter = new ScriptedNativeAdapter([{ refuse: 'zz refused' }, { text: 'zz never' }]);
    const events = await drive(native(adapter).streamYielding(NATIVE_REQUEST, { refusalRetries: asked }));

    expect(adapter.sends).toBe(1);
    expect(ofType(events, 'retrying')).toHaveLength(0);
  });
});

describe('a refusal re-issue in a later round re-issues that round only', () => {
  it('streamYielding(): the earlier round stands, and only the refused attempt is dropped', async () => {
    const adapter = new ScriptedNativeAdapter([
      { text: 'zz round one', toolCall: 'zz_call_1' },
      { refuse: 'zz refused' },
      { text: 'zz round two' },
    ]);
    const events = await drive(native(adapter).streamYielding(NATIVE_REQUEST, { refusalRetries: 1 }));

    expect(adapter.sends).toBe(3);
    const order = events.map((e) => e.type);
    const tokensAt = (text: string): number => events.findIndex((e) => e.type === 'tokens' && e.content.includes(text));
    const retrying = order.indexOf('retrying');
    expect(retrying).toBeGreaterThan(order.indexOf('tool-calls'));
    expect(tokensAt('zz refused')).toBeGreaterThan(order.indexOf('tool-calls'));
    expect(retrying).toBeGreaterThan(tokensAt('zz refused'));
    expect(tokensAt('zz round two')).toBeGreaterThan(retrying);
    expect(tokensAt('zz round one')).toBeLessThan(order.indexOf('tool-calls'));
    const [complete] = ofType(events, 'complete');
    expect(complete!.response.rawAssistantText).toContain('zz round one');
    expect(complete!.response.rawAssistantText).toContain('zz round two');
    expect(complete!.response.rawAssistantText).not.toContain('zz refused');
  });
});

describe('a stated wait longer than its ceiling is given to the caller, not retried inside', () => {
  const LONG_OVERLOADED = {
    retry: { ...SCHEDULES.retry, overloaded: { ...SCHEDULES.retry.overloaded, maxRetryDelayMs: 300_000 } },
  };
  const overloadedFor = (retryAfterMs: number) => () =>
    new MembraneError({ ...overloaded529().toErrorInfo(), retryAfterMs });

  it('streamYielding(): a 429 asking for longer than a minute ends the stream at once', async () => {
    const adapter = new ScriptedNativeAdapter([{ fail: () => rateLimited429(60_001) }, { text: 'zz never' }]);
    const events = await drive(native(adapter).streamYielding(NATIVE_REQUEST));

    expect(adapter.sends).toBe(1);
    expect(ofType(events, 'error')[0]!.error).toMatchObject({ retryAfterMs: 60_001 });
  });

  it('stream(): the same', async () => {
    const adapter = new ScriptedNativeAdapter([{ fail: () => rateLimited429(60_001) }, { text: 'zz never' }]);
    await expect(native(adapter).stream(NATIVE_REQUEST)).rejects.toMatchObject({ retryAfterMs: 60_001 });
    expect(adapter.sends).toBe(1);
  });

  it('streamYielding(): a 429 asking for less than a minute is waited out, though the base cap is 3 ms', async () => {
    const adapter = new ScriptedNativeAdapter([{ fail: () => rateLimited429(45_000) }, { text: 'zz recovered' }]);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const done = drive(native(adapter).streamYielding(NATIVE_REQUEST));
      for (let hop = 0; hop < 50 && vi.getTimerCount() === 0; hop++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(44_999);
      expect(adapter.sends).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      const events = await done;
      expect(adapter.sends).toBe(2);
      expect(ofType(events, 'complete')[0]!.response.details.timing.retryDelaysMs).toEqual([45_000]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a 429 is held to the base ceiling, not the overloaded one', async () => {
    const adapter = new ScriptedNativeAdapter([{ fail: () => rateLimited429(120_000) }, { text: 'zz never' }]);
    const events = await drive(native(adapter, LONG_OVERLOADED).streamYielding(NATIVE_REQUEST));

    expect(adapter.sends).toBe(1);
    expect(ofType(events, 'error')[0]!.error).toMatchObject({ retryAfterMs: 120_000 });
  });

  it('a 529 is held to the overloaded ceiling', async () => {
    const over = new ScriptedNativeAdapter([{ fail: overloadedFor(300_001) }, { text: 'zz never' }]);
    await expect(native(over, LONG_OVERLOADED).complete(NATIVE_REQUEST)).rejects.toMatchObject({ httpStatus: 529 });
    expect(over.sends).toBe(1);

    const at = new ScriptedNativeAdapter([{ fail: overloadedFor(300_000) }, { text: 'zz ok' }]);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const done = drive(native(at, LONG_OVERLOADED).streamYielding(NATIVE_REQUEST));
      for (let hop = 0; hop < 50 && vi.getTimerCount() === 0; hop++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(299_999);
      expect(at.sends).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      const events = await done;
      expect(at.sends).toBe(2);
      const [complete] = ofType(events, 'complete');
      expect(complete!.response.details.timing.retryDelaysMs).toEqual([300_000]);
    } finally {
      vi.useRealTimers();
    }
  });
});
