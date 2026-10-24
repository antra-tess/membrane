/**
 * The attempt record: one per provider attempt, given to
 * `MembraneConfig.onAttempt` as the attempt's adapter call settles.
 *
 * A scripted adapter reports its request, what it sends and its events the
 * way a built-in adapter does, and fake timers move the clock between them
 * (vitest moves `performance.now()` and `Date` together), so each time in
 * the record is exact.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { errorFromProviderStatus, MembraneError, serverError, deadlineExpired } from '../../src/types/errors.js';
import { deadlineTimeoutError, isDeadlineAbort } from '../../src/providers/utils.js';
import type {
  AttemptRecord,
  NormalizedRequest,
  NormalizedResponse,
  ProviderAdapter,
  ProviderRequest,
  ProviderRequestOptions,
  ProviderResponse,
  StreamCallbacks,
  StreamEvent,
} from '../../src/types/index.js';

afterEach(() => {
  vi.useRealTimers();
});

interface Call {
  method: 'complete' | 'stream';
  request: ProviderRequest;
  callbacks?: StreamCallbacks;
  options?: ProviderRequestOptions;
}
type Script = (call: Call) => Promise<ProviderResponse>;

/** An adapter that runs one script per call, in order, and keeps the options each call got. */
class ScriptedAdapter implements ProviderAdapter {
  readonly name = 'zz-scripted';
  readonly calls: Call[] = [];
  constructor(private readonly scripts: Script[]) {}
  supportsModel(): boolean {
    return true;
  }
  private run(call: Call): Promise<ProviderResponse> {
    this.calls.push(call);
    const script = this.scripts.shift();
    if (!script) throw new Error(`zz unscripted call ${this.calls.length}`);
    return script(call);
  }
  complete(request: ProviderRequest, options?: ProviderRequestOptions): Promise<ProviderResponse> {
    return this.run({ method: 'complete', request, options });
  }
  stream(request: ProviderRequest, callbacks: StreamCallbacks, options?: ProviderRequestOptions): Promise<ProviderResponse> {
    return this.run({ method: 'stream', request, callbacks, options });
  }
}

function answer(request: ProviderRequest, text: string, extra: Partial<ProviderResponse> = {}): ProviderResponse {
  return {
    content: [{ type: 'text', text }],
    stopReason: 'end_turn',
    usage: { inputTokens: 10, outputTokens: 5 },
    model: request.model,
    rawRequest: request,
    raw: {},
    ...extra,
  };
}

/** A send as a built-in adapter makes it: the request reported, then what it sends. */
function sendAs(call: Call, send: { maxTokens?: number; reportsContent?: boolean } = {}): void {
  call.options?.onRequest?.(call.request);
  call.options?.onSend?.(send);
}

/** Answers at once, reporting its send and nothing else. */
const plain = (text = 'zz answer'): Script => async (call) => {
  sendAs(call);
  call.callbacks?.onChunk(text);
  return answer(call.request, text);
};

const REQUEST: NormalizedRequest = {
  messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz hello' }] }],
  config: { model: 'zz-model-1', maxTokens: 64 },
  toolMode: 'native',
};

const TOOL_REQUEST: NormalizedRequest = {
  ...REQUEST,
  tools: [{ name: 'zz_probe', description: 'zz probe', inputSchema: { type: 'object', properties: {} } }],
};

function recording(adapter: ProviderAdapter, config: ConstructorParameters<typeof Membrane>[1] = {}) {
  const records: AttemptRecord[] = [];
  const membrane = new Membrane(adapter, {
    formatter: new NativeFormatter(),
    retry: { maxRetries: 2, retryDelayMs: 0, backoffMultiplier: 1, maxRetryDelayMs: 0 },
    ...config,
    onAttempt: (record) => { records.push(record); },
  });
  return { membrane, records };
}

async function drain(stream: AsyncIterable<StreamEvent> & { provideToolResults?: unknown }, onTools?: (event: StreamEvent) => void): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
    if (event.type === 'tool-calls') onTools?.(event);
  }
  return events;
}

describe('one record per attempt, with what the call says about it', () => {
  it('complete(): the call, the send, the usage and the stop', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-24T12:00:00Z') });
    const adapter = new ScriptedAdapter([
      async (call) => {
        vi.advanceTimersByTime(250);
        sendAs(call, { maxTokens: 64 });
        vi.advanceTimersByTime(1500);
        return answer(call.request, 'zz answer', {
          usage: { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 7, cacheReadTokens: 3 },
        });
      },
    ]);
    const { membrane, records } = recording(adapter);

    await membrane.complete(REQUEST, { purpose: 'compression', requestId: 'zz-req-1' });

    expect(records).toEqual([{
      purpose: 'compression',
      callerRequestId: 'zz-req-1',
      method: 'complete',
      round: 0,
      attempt: 0,
      provider: 'zz-scripted',
      model: 'zz-model-1',
      sentAt: Date.parse('2026-10-24T12:00:00.250Z'),
      reportsContent: false,
      endMs: 1500,
      maxTokens: 64,
      usage: { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 7, cacheReadTokens: 3 },
      ending: { stopReason: 'end_turn' },
    }]);
  });

  it('leaves out a purpose, a requestId and a usage count the call or provider gave none of', async () => {
    const adapter = new ScriptedAdapter([
      async (call) => {
        sendAs(call);
        return answer(call.request, 'zz', { usage: { inputTokens: 0, outputTokens: 0 }, unreportedUsage: ['outputTokens'] });
      },
    ]);
    const { membrane, records } = recording(adapter);

    await membrane.complete(REQUEST, { purpose: 'other' as never, requestId: '' });

    expect(records).toHaveLength(1);
    expect(Object.keys(records[0]!)).not.toContain('purpose');
    expect(Object.keys(records[0]!)).not.toContain('callerRequestId');
    expect(Object.keys(records[0]!)).not.toContain('maxTokens');
    expect(records[0]!.usage).toEqual({ inputTokens: 0 });

    const inputUnreported = recording(new ScriptedAdapter([
      async (call) => {
        sendAs(call);
        return answer(call.request, 'zz', { usage: { inputTokens: 0, outputTokens: 5 }, unreportedUsage: ['inputTokens'] });
      },
    ]));
    await inputUnreported.membrane.complete(REQUEST);
    expect(inputUnreported.records[0]!.usage).toEqual({ outputTokens: 5 });
  });

  it('usage is normalized: cache reads and writes outside inputTokens', async () => {
    class InclusiveAdapter extends ScriptedAdapter {
      readonly usageCacheConvention = 'cache-inclusive' as const;
    }
    const adapter = new InclusiveAdapter([
      async (call) => {
        sendAs(call);
        return answer(call.request, 'zz', { usage: { inputTokens: 100, outputTokens: 5, cacheReadTokens: 60 } });
      },
    ]);
    const { membrane, records } = recording(adapter);

    await membrane.complete(REQUEST);

    expect(records[0]!.usage).toEqual({ inputTokens: 40, outputTokens: 5, cacheReadTokens: 60 });
  });

  it('a failed send and its retry are two attempts of the one round', async () => {
    const adapter = new ScriptedAdapter([
      async (call) => {
        sendAs(call);
        throw serverError('zz upstream 500', 500);
      },
      plain(),
    ]);
    const { membrane, records } = recording(adapter);

    await membrane.complete(REQUEST);

    expect(records.map((r) => [r.round, r.attempt])).toEqual([[0, 0], [0, 1]]);
    expect(records[0]!.ending).toEqual({
      error: { type: 'server', httpStatus: 500, cancelled: false, deadline: false },
    });
    expect(records[1]!.ending).toEqual({ stopReason: 'end_turn' });
  });

  it('a refusal and its re-issue are two attempts, the first with its category', async () => {
    const adapter = new ScriptedAdapter([
      async (call) => {
        sendAs(call);
        return answer(call.request, '', { stopReason: 'refusal', refusalCategory: 'cyber' });
      },
      plain(),
    ]);
    const { membrane, records } = recording(adapter);

    await membrane.complete(REQUEST, { refusalRetries: 1 });

    expect(records.map((r) => r.attempt)).toEqual([0, 1]);
    expect(records[0]!.ending).toEqual({ stopReason: 'refusal', refusalCategory: 'cyber' });
  });

  it("a category beside a stop that isn't a refusal isn't carried, nor one that isn't a non-empty string", async () => {
    const adapter = new ScriptedAdapter([
      async (call) => {
        sendAs(call);
        return answer(call.request, 'zz', { refusalCategory: 'cyber' });
      },
      async (call) => {
        sendAs(call);
        return answer(call.request, '', { stopReason: 'refusal', refusalCategory: '' });
      },
    ]);
    const { membrane, records } = recording(adapter);

    await membrane.complete(REQUEST);
    await membrane.complete(REQUEST);

    expect(records.map((r) => r.ending)).toEqual([{ stopReason: 'end_turn' }, { stopReason: 'refusal' }]);
  });

  it("carries the provider's own stop, not the round's after a local stop sequence cut it", async () => {
    const adapter = new ScriptedAdapter([
      async (call) => {
        sendAs(call);
        call.callbacks?.onChunk('zz before STOP after');
        return answer(call.request, 'zz before STOP after');
      },
    ]);
    const { membrane, records } = recording(adapter);

    const response = await membrane.stream({ ...REQUEST, stopSequences: ['STOP'] });

    expect((response as NormalizedResponse).stopReason).toBe('stop_sequence');
    expect(records[0]!.ending).toEqual({ stopReason: 'end_turn' });
  });
});

describe('times, from the send', () => {
  it("a stream's events: first event, first content, the longest gaps, the last event and the end", async () => {
    vi.useFakeTimers();
    const adapter = new ScriptedAdapter([
      async (call) => {
        sendAs(call, { reportsContent: true });
        const progress = call.options!.onProgress!;
        vi.advanceTimersByTime(1000); progress();            // 1 s: an event
        vi.advanceTimersByTime(4000); progress('content');   // 5 s: content, after a 4 s gap
        vi.advanceTimersByTime(500); progress();             // 5.5 s
        vi.advanceTimersByTime(1500); progress('content');   // 7 s
        call.callbacks?.onChunk('zz');
        vi.advanceTimersByTime(250);
        return answer(call.request, 'zz');
      },
    ]);
    const { membrane, records } = recording(adapter);

    await membrane.stream(REQUEST);

    expect(records[0]).toMatchObject({
      method: 'stream',
      reportsContent: true,
      firstEventMs: 1000,
      firstContentMs: 5000,
      maxGapMs: 4000,
      // The 4 s gap ended at first content, so it isn't after it.
      maxGapAfterContentMs: 1500,
      lastEventMs: 7000,
      endMs: 7250,
    });
  });

  it('a stream cut off after its events: the open gap is left to the reader, by the last event and the end', async () => {
    vi.useFakeTimers();
    const adapter = new ScriptedAdapter([
      async (call) => {
        sendAs(call, { reportsContent: true });
        const progress = call.options!.onProgress!;
        vi.advanceTimersByTime(1000); progress();
        vi.advanceTimersByTime(1000); progress('content');
        vi.advanceTimersByTime(1000); progress();
        vi.advanceTimersByTime(7000);
        // Not retryable, so the one attempt is the call.
        throw new MembraneError({ type: 'network', message: 'zz socket closed', retryable: false, rawError: null });
      },
    ]);
    const { membrane, records } = recording(adapter);

    await expect(membrane.stream(REQUEST)).rejects.toThrow('zz socket closed');

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      firstEventMs: 1000, firstContentMs: 2000, maxGapMs: 1000, maxGapAfterContentMs: 1000,
      lastEventMs: 3000, endMs: 10000,
      ending: { error: { type: 'network', cancelled: false, deadline: false } },
    });
  });

  it("complete(): an adapter that streams to answer it reports its events, as the subscription transport does", async () => {
    vi.useFakeTimers();
    const adapter = new ScriptedAdapter([
      async (call) => {
        sendAs(call);
        vi.advanceTimersByTime(300); call.options!.onProgress!();
        vi.advanceTimersByTime(200); call.options!.onProgress!();
        return answer(call.request, 'zz');
      },
    ]);
    const { membrane, records } = recording(adapter);

    await membrane.complete(REQUEST);

    expect(records[0]).toMatchObject({ method: 'complete', firstEventMs: 300, lastEventMs: 500, maxGapMs: 200 });
  });

  it("ends with the adapter's call, before held text goes to the caller", async () => {
    vi.useFakeTimers();
    const adapter = new ScriptedAdapter([
      async (call) => {
        sendAs(call);
        vi.advanceTimersByTime(1000);
        // Text that could begin a stop is held until the attempt ends.
        call.callbacks!.onChunk('ST');
        throw new MembraneError({ type: 'network', message: 'zz socket closed', retryable: false, rawError: null });
      },
    ]);
    const { membrane, records } = recording(adapter);

    await membrane.stream({ ...REQUEST, stopSequences: ['STOP'] }, {
      // The caller's own callback, slow on the clock.
      onChunk: () => { vi.advanceTimersByTime(5000); },
    }).catch(() => undefined);

    expect(records[0]!.endMs).toBe(1000);
  });

  it('one event: no gap; no events: no event times at all', async () => {
    const adapter = new ScriptedAdapter([
      async (call) => {
        sendAs(call);
        call.options!.onProgress!();
        return answer(call.request, 'zz');
      },
      async (call) => {
        sendAs(call);
        return answer(call.request, 'zz');
      },
    ]);
    const { membrane, records } = recording(adapter);

    await membrane.stream(REQUEST);
    await membrane.stream(REQUEST);

    expect(records[0]!.firstEventMs).toBe(records[0]!.lastEventMs);
    for (const key of ['maxGapMs', 'maxGapAfterContentMs', 'firstContentMs']) {
      expect(Object.keys(records[0]!)).not.toContain(key);
    }
    for (const key of ['firstEventMs', 'lastEventMs', 'maxGapMs', 'maxGapAfterContentMs', 'firstContentMs']) {
      expect(Object.keys(records[1]!)).not.toContain(key);
    }
  });

  it("counts nothing before the send, and a record once given doesn't change", async () => {
    vi.useFakeTimers();
    let late: ((seen?: 'content') => void) | undefined;
    const adapter = new ScriptedAdapter([
      async (call) => {
        call.options!.onProgress!('content'); // before the request is reported: no origin
        vi.advanceTimersByTime(2000);
        sendAs(call, { reportsContent: true });
        vi.advanceTimersByTime(3000);
        call.options!.onProgress!();
        late = call.options!.onProgress!;
        return answer(call.request, 'zz');
      },
    ]);
    const { membrane, records } = recording(adapter);

    await membrane.stream(REQUEST);
    vi.advanceTimersByTime(1000);
    late!('content');

    expect(records[0]).toMatchObject({ firstEventMs: 3000, lastEventMs: 3000, endMs: 3000 });
    expect(Object.keys(records[0]!)).not.toContain('firstContentMs');
  });

  it('the first send report counts: a resend inside the attempt keeps the attempt', async () => {
    vi.useFakeTimers({ now: 0 });
    const adapter = new ScriptedAdapter([
      async (call) => {
        sendAs(call, { maxTokens: 64 });
        vi.advanceTimersByTime(800);
        sendAs(call, { maxTokens: 64 });
        return answer(call.request, 'zz');
      },
    ]);
    const { membrane, records } = recording(adapter);

    await membrane.complete(REQUEST);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ sentAt: 0, endMs: 800 });
  });

  it("a send report counts only as what it says: maxTokens as a count, reportsContent as true", async () => {
    const reports: unknown[] = [
      { maxTokens: -1, reportsContent: 'yes' }, { maxTokens: Number.NaN, reportsContent: 1 },
      { maxTokens: '64' }, { maxTokens: null }, undefined, null,
    ];
    const adapter = new ScriptedAdapter(
      reports.map((report) => async (call: Call) => {
        call.options?.onRequest?.(call.request);
        call.options?.onSend?.(report as never);
        return answer(call.request, 'zz');
      }),
    );
    const { membrane, records } = recording(adapter);

    for (let i = 0; i < reports.length; i++) await membrane.complete(REQUEST);

    expect(records).toHaveLength(reports.length);
    for (const record of records) {
      expect(Object.keys(record)).not.toContain('maxTokens');
      expect(record.reportsContent).toBe(false);
    }
  });

  it("the model membrane asked the adapter for, or '' where a hook left something else there", async () => {
    const adapter = new ScriptedAdapter([plain()]);
    const { membrane, records } = recording(adapter, {
      hooks: { beforeRequest: (_request, provider) => ({ ...(provider as object), model: 42 }) },
    });
    // The call itself fails later on such a model; its attempt was sent, and recorded.
    await membrane.complete(REQUEST).catch(() => undefined);
    const plainRecord = recording(new ScriptedAdapter([plain()]));
    await plainRecord.membrane.complete(REQUEST);

    expect(records[0]!.model).toBe('');
    expect(plainRecord.records[0]!.model).toBe('zz-model-1');
  });
});

describe('rounds, on every entry point', () => {
  /** A tool round, then an answer. */
  const twoRounds = (): Script[] => [
    async (call) => {
      sendAs(call);
      return {
        ...answer(call.request, ''),
        content: [{ type: 'tool_use', id: 'zz_call_1', name: 'zz_probe', input: {} }],
        stopReason: 'tool_use',
      };
    },
    plain(),
  ];
  const results = (calls: Array<{ id: string }>) => calls.map((c) => ({ toolUseId: c.id, content: 'zz ok' }));

  it('stream(), native tools', async () => {
    const { membrane, records } = recording(new ScriptedAdapter(twoRounds()));
    await membrane.stream(TOOL_REQUEST, { purpose: 'turn', requestId: 'zz-r', onToolCalls: async (calls) => results(calls) });
    expect(records.map((r) => [r.method, r.round, r.attempt, r.purpose, r.callerRequestId]))
      .toEqual([['stream', 0, 0, 'turn', 'zz-r'], ['stream', 1, 0, 'turn', 'zz-r']]);
  });

  it('streamYielding(), native tools', async () => {
    const { membrane, records } = recording(new ScriptedAdapter(twoRounds()));
    const stream = membrane.streamYielding(TOOL_REQUEST, { purpose: 'turn', requestId: 'zz-r' });
    await drain(stream, (event) => stream.provideToolResults(results((event as { calls: Array<{ id: string }> }).calls)));
    expect(records.map((r) => [r.method, r.round, r.attempt, r.purpose, r.callerRequestId]))
      .toEqual([['stream', 0, 0, 'turn', 'zz-r'], ['stream', 1, 0, 'turn', 'zz-r']]);
  });

  const XML_CALL = '<function_calls>\n<invoke name="zz_probe">\n</invoke>';
  /** An XML tool round, then an answer. */
  const twoXmlRounds = (): Script[] => [
    async (call) => {
      sendAs(call);
      call.callbacks?.onChunk(`zz\n${XML_CALL}`);
      return answer(call.request, `zz\n${XML_CALL}`, { stopReason: 'stop_sequence', stopSequence: '</function_calls>' });
    },
    plain(),
  ];
  const XML_REQUEST: NormalizedRequest = { ...TOOL_REQUEST, toolMode: 'xml' };

  it('stream(), XML tools', async () => {
    const adapter = new ScriptedAdapter(twoXmlRounds());
    const records: AttemptRecord[] = [];
    const membrane = new Membrane(adapter, { onAttempt: (record) => { records.push(record); } });
    await membrane.stream(XML_REQUEST, { purpose: 'turn', requestId: 'zz-r', onToolCalls: async (calls) => results(calls) });
    expect(records.map((r) => [r.round, r.attempt, r.purpose, r.callerRequestId]))
      .toEqual([[0, 0, 'turn', 'zz-r'], [1, 0, 'turn', 'zz-r']]);
  });

  it('streamYielding(), XML tools', async () => {
    const adapter = new ScriptedAdapter(twoXmlRounds());
    const records: AttemptRecord[] = [];
    const membrane = new Membrane(adapter, { onAttempt: (record) => { records.push(record); } });
    const stream = membrane.streamYielding(XML_REQUEST, { purpose: 'turn', requestId: 'zz-r' });
    await drain(stream, (event) => stream.provideToolResults(results((event as { calls: Array<{ id: string }> }).calls)));
    expect(records.map((r) => [r.round, r.attempt, r.purpose, r.callerRequestId]))
      .toEqual([[0, 0, 'turn', 'zz-r'], [1, 0, 'turn', 'zz-r']]);
  });

  it('a streamed refusal re-issue is the next attempt of its round', async () => {
    const adapter = new ScriptedAdapter([
      async (call) => {
        sendAs(call);
        call.callbacks?.onChunk('zz');
        return answer(call.request, 'zz', { stopReason: 'refusal', refusalCategory: 'bio' });
      },
      plain(),
    ]);
    const { membrane, records } = recording(adapter);
    await drain(membrane.streamYielding(REQUEST, { refusalRetries: 1 }));
    expect(records.map((r) => [r.round, r.attempt])).toEqual([[0, 0], [0, 1]]);
    expect(records[0]!.ending).toEqual({ stopReason: 'refusal', refusalCategory: 'bio' });
  });
});

describe('how an attempt ended', () => {
  it("the caller's cancellation, on complete()", async () => {
    const controller = new AbortController();
    const adapter = new ScriptedAdapter([
      async (call) => {
        sendAs(call);
        controller.abort();
        throw new MembraneError({ type: 'abort', message: 'zz aborted', retryable: false, rawError: null });
      },
    ]);
    const { membrane, records } = recording(adapter);

    await expect(membrane.complete(REQUEST, { signal: controller.signal })).rejects.toThrow();

    expect(records[0]!.ending).toEqual({ error: { type: 'abort', cancelled: true, deadline: false } });
  });

  it("the caller's cancellation, on stream()", async () => {
    const controller = new AbortController();
    const adapter = new ScriptedAdapter([
      async (call) => {
        sendAs(call);
        call.options!.onProgress!();
        controller.abort();
        throw new MembraneError({ type: 'abort', message: 'zz aborted', retryable: false, rawError: null });
      },
    ]);
    const { membrane, records } = recording(adapter);

    await membrane.stream(REQUEST, { signal: controller.signal });

    expect(records[0]!.ending).toEqual({ error: { type: 'abort', cancelled: true, deadline: false } });
  });

  it('the progress deadline', async () => {
    vi.useFakeTimers();
    const adapter = new ScriptedAdapter([
      // Waits for its signal, and types a deadline's abort as every built-in adapter does.
      (call) => new Promise((_resolve, reject) => {
        sendAs(call);
        const signal = call.options!.signal!;
        signal.addEventListener('abort', () => {
          reject(isDeadlineAbort(signal.reason) ? deadlineTimeoutError(signal.reason, call.request) : signal.reason);
        }, { once: true });
      }),
    ]);
    const { membrane, records } = recording(adapter);

    const done = membrane.complete(REQUEST, { progressTimeoutMs: 1000 }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1000);
    await done;

    expect(records[0]!.ending).toMatchObject({ error: { cancelled: false, deadline: true } });
    expect(records[0]!.endMs).toBe(1000);
  });

  it('a deadline on a request already sent', async () => {
    const adapter = new ScriptedAdapter([
      async (call) => {
        sendAs(call);
        throw deadlineExpired(new MembraneError({ type: 'timeout', message: 'zz idle', retryable: true, rawError: null }));
      },
    ]);
    const { membrane, records } = recording(adapter);

    await expect(membrane.complete(REQUEST)).rejects.toThrow('zz idle');

    expect(records[0]!.ending).toEqual({ error: { type: 'timeout', cancelled: false, deadline: true } });
  });

  it("a 400: its template, its field path and the provider's code", async () => {
    const body = {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'messages.3.content.1: Invalid `signature` in `thinking` block',
      },
    };
    const adapter = new ScriptedAdapter([
      async (call) => {
        sendAs(call);
        throw errorFromProviderStatus({ provider: 'zz', status: 400, body, rawError: body });
      },
    ]);
    const { membrane, records } = recording(adapter);

    await expect(membrane.complete(REQUEST)).rejects.toThrow();

    expect(records[0]!.ending).toEqual({
      error: {
        type: 'invalid_request',
        httpStatus: 400,
        providerErrorCode: 'invalid_request_error',
        cancelled: false,
        deadline: false,
        template: 'thinking_signature_invalid',
        fieldPath: 'messages.N.content.N',
      },
    });
  });

  it("only a 400 is classified, whatever another status's message says", async () => {
    const body = { type: 'error', error: { type: 'api_error', message: 'messages.0.content.0.thinking.signature: Field required' } };
    const adapter = new ScriptedAdapter([
      async (call) => {
        sendAs(call);
        throw errorFromProviderStatus({ provider: 'zz', status: 500, body, rawError: body });
      },
    ]);
    const { membrane, records } = recording(adapter, { retry: { maxRetries: 0 } });

    await expect(membrane.complete(REQUEST)).rejects.toThrow();

    expect(records[0]!.ending).toEqual({
      error: { type: 'server', httpStatus: 500, providerErrorCode: 'api_error', cancelled: false, deadline: false },
    });
  });

  it('an error that is no MembraneError yet is typed as the call types it', async () => {
    const adapter = new ScriptedAdapter([
      async (call) => {
        sendAs(call);
        throw Object.assign(new Error('zz connect refused'), { code: 'ECONNREFUSED' });
      },
      plain(),
    ]);
    const { membrane, records } = recording(adapter);

    await membrane.complete(REQUEST);

    expect(records[0]!.ending).toEqual({ error: { type: 'network', cancelled: false, deadline: false } });
  });
});

describe('no record where nothing was sent', () => {
  it('a beforeRequest hook that throws: the adapter is never called', async () => {
    const adapter = new ScriptedAdapter([]);
    const { membrane, records } = recording(adapter, { hooks: { beforeRequest: () => { throw new Error('zz hook'); } } });

    await expect(membrane.complete(REQUEST)).rejects.toThrow('zz hook');

    expect(adapter.calls).toHaveLength(0);
    expect(records).toEqual([]);
  });

  it('an adapter that fails before reporting its request', async () => {
    const adapter = new ScriptedAdapter([async () => { throw new Error('zz refused before sending'); }]);
    const { membrane, records } = recording(adapter);

    await expect(membrane.stream(REQUEST)).rejects.toThrow('zz refused before sending');

    expect(records).toEqual([]);
  });

  it("the caller's onRequest that throws: the adapter doesn't send", async () => {
    const adapter = new ScriptedAdapter([
      async (call) => {
        sendAs(call); // throws inside onRequest, as a real adapter's would before sending
        return answer(call.request, 'zz');
      },
    ]);
    const { membrane, records } = recording(adapter);

    await expect(membrane.complete(REQUEST, { onRequest: () => { throw new Error('zz logger'); } })).rejects.toThrow('zz logger');

    expect(records).toEqual([]);
  });
});

describe('an observer that fails changes nothing', () => {
  it('a throwing onAttempt: the call goes on and returns', async () => {
    const adapter = new ScriptedAdapter([
      async (call) => {
        sendAs(call);
        throw serverError('zz 503', 503);
      },
      plain('zz recovered'),
    ]);
    let seen = 0;
    const membrane = new Membrane(adapter, {
      formatter: new NativeFormatter(),
      retry: { maxRetries: 2, retryDelayMs: 0, backoffMultiplier: 1, maxRetryDelayMs: 0 },
      onAttempt: () => { seen++; throw new Error('zz observer'); },
    });

    const response = await membrane.complete(REQUEST);

    expect(seen).toBe(2);
    expect(response.content).toEqual([{ type: 'text', text: 'zz recovered' }]);
  });

  it('a rejecting onAttempt: no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', listener);
    try {
      const adapter = new ScriptedAdapter([plain()]);
      const membrane = new Membrane(adapter, {
        formatter: new NativeFormatter(),
        onAttempt: async () => { throw new Error('zz async observer'); },
      });

      await membrane.stream(REQUEST);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', listener);
    }
  });
});

describe('without onAttempt, nothing is observed', () => {
  it('the adapter gets neither onSend nor onProgress unless a progress deadline asks for it', async () => {
    const adapter = new ScriptedAdapter([plain(), plain(), plain()]);
    const membrane = new Membrane(adapter, { formatter: new NativeFormatter() });

    await membrane.complete(REQUEST);
    await membrane.stream(REQUEST);
    await membrane.stream(REQUEST, { progressTimeoutMs: 60_000 });

    expect(adapter.calls.map((c) => [c.options?.onSend, c.options?.onProgress].map((f) => typeof f)))
      .toEqual([['undefined', 'undefined'], ['undefined', 'undefined'], ['undefined', 'function']]);
  });
});
