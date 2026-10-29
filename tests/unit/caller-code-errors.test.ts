import { afterEach, describe, expect, it, vi } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { MockAdapter } from '../../src/providers/mock.js';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { OpenAIResponsesAPIAdapter } from '../../src/providers/openai-responses-api.js';
import { OpenAIResponsesFormatter } from '../../src/formatters/openai-responses.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { MembraneError, callerCodeError, invalidRequestError, rateLimitError } from '../../src/types/errors.js';
import { AnthropicXmlFormatter } from '../../src/formatters/anthropic-xml.js';
import type { NormalizedRequest } from '../../src/types/index.js';

const text = (t: string) => ({ type: 'text' as const, text: t });
const tool = { name: 'lookup', description: 'look up a record', inputSchema: { type: 'object' as const, properties: {} } };
const request = (extra: Record<string, unknown> = {}): NormalizedRequest => ({
  assistantParticipant: 'Agent', config: { model: 'claude-sonnet-4-6', maxTokens: 32 },
  messages: [{ participant: 'User', content: [text('hello')] }],
  ...extra,
}) as NormalizedRequest;
const repairedHistory = () => request({ tools: [tool], messages: [
  { participant: 'User', content: [text('hello')] },
  { participant: 'Agent', content: [{ type: 'tool_use', id: 't1', name: 'lookup', input: {} }] },
  { participant: 'User', content: [
    { type: 'tool_result', toolUseId: 't1', content: 'first' },
    { type: 'tool_result', toolUseId: 't1', content: 'again' },
  ] },
] });
const noDelay = { retry: { maxRetries: 0, retryDelayMs: 1, maxRetryDelayMs: 2 } };
const callerError = () => new Error('zz rate limit exceeded in the caller');

class CountingAdapter extends MockAdapter {
  completeCalls = 0;
  streamCalls = 0;
  constructor(defaultResponse = 'done and done') { super({ defaultResponse, completeDelayMs: 0, streamChunkDelayMs: 0, streamChunkSize: 4 }); }
  override async complete(...args: Parameters<MockAdapter['complete']>) { this.completeCalls++; return super.complete(...args); }
  override async stream(...args: Parameters<MockAdapter['stream']>) { this.streamCalls++; return super.stream(...args); }
}

function scriptedStream(events: unknown[]) {
  return {
    controller: { abort() { } },
    [Symbol.asyncIterator]() {
      let i = 0;
      return { async next() { return i < events.length ? { value: events[i++], done: false } : { value: undefined, done: true }; } };
    },
  };
}

function anthropic(config: Record<string, unknown> = {}) {
  const adapter = new AnthropicAdapter({ apiKey: 'sk-test', cacheKeepalive: { enabled: false }, ...config });
  const create = vi.fn().mockResolvedValue({
    id: 'msg', model: 'claude-sonnet-4-6', role: 'assistant', content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
  });
  const client: any = { messages: { create, stream: create } };
  client.withOptions = () => client;
  (adapter as any).client = client;
  return { adapter, create };
}

async function rejection(promise: Promise<unknown>): Promise<MembraneError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(MembraneError);
    return error as MembraneError;
  }
  throw new Error('expected a rejection');
}

async function yieldingError(membrane: Membrane, req: NormalizedRequest): Promise<MembraneError> {
  for await (const event of membrane.streamYielding(req, {})) {
    if (event.type === 'error') {
      expect(event.error).toBeInstanceOf(MembraneError);
      return event.error as MembraneError;
    }
  }
  throw new Error('expected an error event');
}

const call = (path: 'complete' | 'stream', membrane: Membrane, req: NormalizedRequest, options: Record<string, unknown> = {}) =>
  path === 'complete' ? membrane.complete(req, options) : membrane.stream(req, { onChunk: () => {}, ...options });

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('callerCodeError', () => {
  it('wraps an error that isn\'t a MembraneError: its type read from its wording, not retryable, no status or wait, its raw error and cause the caller\'s', () => {
    const original = new Error('zz rate limit exceeded in the caller, retry after 30 seconds');
    const error = callerCodeError(original);
    expect(error).toBeInstanceOf(MembraneError);
    expect(error).toMatchObject({ type: 'rate_limit', retryable: false, message: original.message });
    expect(error.httpStatus).toBeUndefined();
    expect(error.retryAfterMs).toBeUndefined();
    expect(error.rawError).toMatchObject({ name: 'Error', message: original.message });
    expect(error.cause).toBe(original);
  });

  it('keeps a MembraneError that already isn\'t retryable as itself', () => {
    const original = invalidRequestError('zz a MembraneError that says not retryable');
    expect(callerCodeError(original)).toBe(original);
    expect(original.cause).toBeUndefined();
  });

  it('wraps a retryable MembraneError, taking nothing of another call\'s from it and leaving it as it was', () => {
    const stated = { httpStatus: 429, providerErrorCode: 'zz_rate_limited', retryAfterMs: 30_000, rawError: { zz: 'the nested provider error' }, rawRequest: { zz: 'the nested request' } };
    const original = new MembraneError({ type: 'rate_limit', message: 'zz a nested call\'s 429', retryable: true, ...stated });
    const error = callerCodeError(original);
    expect(error).not.toBe(original);
    expect(error).toMatchObject({ type: 'rate_limit', retryable: false, message: original.message });
    expect(error.cause).toBe(original);
    expect(error.httpStatus).toBeUndefined();
    expect(error.providerErrorCode).toBeUndefined();
    expect(error.retryAfterMs).toBeUndefined();
    expect(error.rawError).toBeUndefined();
    expect(error.rawRequest).toBeUndefined();
    expect(original).toMatchObject({ retryable: true, ...stated });
  });
});

describe('complete() sends once when the caller\'s code throws after the response arrived', () => {
  it('onResponse', async () => {
    const adapter = new CountingAdapter();
    const original = callerError();
    const error = await rejection(new Membrane(adapter, noDelay).complete(request(), { onResponse: () => { throw original; } }));
    expect(adapter.completeCalls).toBe(1);
    expect(error).toMatchObject({ type: 'rate_limit', retryable: false });
    expect(error.cause).toBe(original);
  });

  it('the afterResponse hook', async () => {
    const adapter = new CountingAdapter();
    const membrane = new Membrane(adapter, { ...noDelay, hooks: { afterResponse: async () => { throw callerError(); } } });
    const error = await rejection(membrane.complete(request()));
    expect(adapter.completeCalls).toBe(1);
    expect(error.retryable).toBe(false);
  });

  it('the afterResponse hook, rethrowing a nested call\'s retryable MembraneError, which it still holds unchanged', async () => {
    const adapter = new CountingAdapter();
    const nested = rateLimitError('zz the nested call was rate limited', 30_000);
    const membrane = new Membrane(adapter, { ...noDelay, hooks: { afterResponse: async () => { throw nested; } } });
    const error = await rejection(membrane.complete(request()));
    expect(adapter.completeCalls).toBe(1);
    expect(error).not.toBe(nested);
    expect(error).toMatchObject({ type: 'rate_limit', retryable: false });
    expect(error.cause).toBe(nested);
    expect(nested).toMatchObject({ retryable: true, retryAfterMs: 30_000 });
  });
});

describe('the caller\'s code before the send runs once', () => {
  for (const path of ['complete', 'stream'] as const) {
    it(`${path}: the beforeRequest hook`, async () => {
      let runs = 0;
      const membrane = new Membrane(new CountingAdapter(), { ...noDelay, hooks: { beforeRequest: async () => { runs++; throw callerError(); } } });
      const error = await rejection(call(path, membrane, request()));
      expect(runs).toBe(1);
      expect(error.retryable).toBe(false);
    });

    it(`${path}: onCacheWireReceipt on the provider-request basis`, async () => {
      let runs = 0;
      const membrane = new Membrane(new CountingAdapter(), noDelay);
      const error = await rejection(call(path, membrane, request({ onCacheWireReceipt: () => { runs++; throw callerError(); } })));
      expect(runs).toBe(1);
      expect(error.retryable).toBe(false);
    });

    it(`${path}: onCacheWireReceipt on the wire-request basis, before the client is called`, async () => {
      let runs = 0;
      const { adapter, create } = anthropic();
      const membrane = new Membrane(adapter, noDelay);
      const error = await rejection(call(path, membrane, request({ onCacheWireReceipt: () => { runs++; throw callerError(); } })));
      expect(runs).toBe(1);
      expect(create).not.toHaveBeenCalled();
      expect(error.retryable).toBe(false);
    });

    it(`${path}: onRequest`, async () => {
      let runs = 0;
      const membrane = new Membrane(new CountingAdapter(), noDelay);
      const error = await rejection(call(path, membrane, request(), { onRequest: () => { runs++; throw callerError(); } }));
      expect(runs).toBe(1);
      expect(error.retryable).toBe(false);
    });

    it(`${path}: the onNormalize hook, inside the build`, async () => {
      let runs = 0;
      const membrane = new Membrane(new CountingAdapter(), { ...noDelay, formatter: new NativeFormatter(), hooks: { onNormalize: () => { runs++; throw callerError(); } } });
      const error = await rejection(call(path, membrane, repairedHistory()));
      expect(runs).toBe(1);
      expect(error.retryable).toBe(false);
    });

    it(`${path}: the Anthropic adapter's dynamicHeaders, before the send`, async () => {
      let runs = 0;
      const { adapter, create } = anthropic({ dynamicHeaders: () => { runs++; throw callerError(); } });
      const record = vi.fn();
      (adapter as any).cacheKeepalive = { record };
      const error = await rejection(call(path, new Membrane(adapter, noDelay), request()));
      expect(runs).toBe(1);
      expect(create).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
      expect(error.retryable).toBe(false);
    });

    it(`${path}: onCacheWireReceipt is called with the request as this, as before`, async () => {
      const req = request();
      let seen: unknown;
      req.onCacheWireReceipt = function (this: unknown) { seen = this; };
      await call(path, new Membrane(new CountingAdapter(), noDelay), req);
      expect(seen).toBe(req);
    });
  }
});

describe('the onError hook is the caller\'s code too', () => {
  class RateLimitedOnce extends CountingAdapter {
    override async complete(...args: Parameters<MockAdapter['complete']>) {
      if (this.completeCalls++ === 0) {
        args[1]?.onRequest?.(args[0]);
        throw rateLimitError('zz the provider says slow down');
      }
      return MockAdapter.prototype.complete.apply(this, args);
    }
    override async stream(...args: Parameters<MockAdapter['stream']>) {
      if (this.streamCalls++ === 0) {
        args[2]?.onRequest?.(args[0]);
        throw rateLimitError('zz the provider says slow down');
      }
      return MockAdapter.prototype.stream.apply(this, args);
    }
  }

  class SwallowingRateLimitedOnce extends CountingAdapter {
    override async complete(...args: Parameters<MockAdapter['complete']>) {
      try { args[1]?.onRequest?.(args[0]); } catch { }
      if (this.completeCalls++ === 0) throw rateLimitError('zz the provider says slow down');
      return MockAdapter.prototype.complete.call(this, args[0], { ...args[1], onRequest: undefined });
    }
    override async stream(...args: Parameters<MockAdapter['stream']>) {
      try { args[2]?.onRequest?.(args[0]); } catch { }
      if (this.streamCalls++ === 0) throw rateLimitError('zz the provider says slow down');
      return MockAdapter.prototype.stream.call(this, args[0], args[1], { ...args[2], onRequest: undefined });
    }
  }

  for (const path of ['complete', 'stream'] as const) {
    it(`${path}: what it throws, or rejects with, leaves as a MembraneError that isn't retryable`, async () => {
      const original = callerError();
      const membrane = new Membrane(new RateLimitedOnce(), { ...noDelay, hooks: { onError: async () => { throw original; } } });
      const error = await rejection(call(path, membrane, request()));
      expect(error.retryable).toBe(false);
      expect(error.cause).toBe(original);
    });

    it(`${path}: a provider's rate limit is still retried when the caller's code runs and returns (control)`, async () => {
      const adapter = new RateLimitedOnce();
      const onError = vi.fn(() => 'retry' as const);
      const membrane = new Membrane(adapter, { ...noDelay, hooks: { onError } });
      await expect(call(path, membrane, request(), { onRequest: () => {}, onResponse: () => {} })).resolves.toBeDefined();
      expect(path === 'complete' ? adapter.completeCalls : adapter.streamCalls).toBe(2);
      expect(onError).toHaveBeenCalledTimes(1);
    });

    it(`${path}: a provider's rate limit after the caller's error was swallowed in the same attempt is still retried (control)`, async () => {
      const adapter = new SwallowingRateLimitedOnce();
      let runs = 0;
      await expect(call(path, new Membrane(adapter, noDelay), request(), { onRequest: () => { runs++; throw callerError(); } })).resolves.toBeDefined();
      expect(path === 'complete' ? adapter.completeCalls : adapter.streamCalls).toBe(2);
      expect(runs).toBe(2);
    });
  }

  it('streamYielding: what it throws, or rejects with, leaves as a MembraneError that isn\'t retryable', async () => {
    const original = callerError();
    const membrane = new Membrane(new RateLimitedOnce(), { ...noDelay, hooks: { onError: async () => { throw original; } } });
    const error = await yieldingError(membrane, request());
    expect(error.retryable).toBe(false);
    expect(error.cause).toBe(original);
  });
});

describe('the configured logger and a model registry run beside the call, so complete() sends once when they throw', () => {
  it('a logger whose warn() throws, while membrane warns of a tool block that parsed to nothing', async () => {
    const emptyBlock = '<' + 'function_calls>\nzz musing: no invokes in here\n</' + 'function_calls>';
    const adapter = new CountingAdapter(`zz_bot: here goes\n${emptyBlock}`);
    let runs = 0;
    const logger = { debug() {}, info() {}, error() {}, warn: () => { runs++; throw callerError(); } };
    const membrane = new Membrane(adapter, { ...noDelay, formatter: new AnthropicXmlFormatter(), logger });
    const error = await rejection(membrane.complete(request({ tools: [tool], toolMode: 'xml' })));
    expect(runs).toBe(1);
    expect(adapter.completeCalls).toBe(1);
    expect(error.retryable).toBe(false);
  });

  it('a registry whose getPricing throws, as membrane prices the response', async () => {
    const adapter = new CountingAdapter();
    let runs = 0;
    const registry = { getPricing: () => { runs++; throw callerError(); } } as any;
    const error = await rejection(new Membrane(adapter, { ...noDelay, registry }).complete(request()));
    expect(runs).toBe(1);
    expect(adapter.completeCalls).toBe(1);
    expect(error.retryable).toBe(false);
  });
});

describe('the configured logger\'s other warning sites: what its warn() throws leaves not retryable', () => {
  class EverDeeper extends CountingAdapter {
    override async stream(req: any, callbacks: any): Promise<any> {
      this.streamCalls++;
      const round = '<' + 'function_calls>\n<invoke name="round-content-padding">';
      callbacks.onChunk(round);
      return { content: [text(round)], stopReason: 'stop_sequence', usage: { inputTokens: 1, outputTokens: 1 }, model: req.model, rawRequest: req, raw: {} };
    }
  }
  const xml = () => request({ toolMode: 'xml' });
  const throwingLogger = () => {
    const logger = { runs: 0, debug() {}, info() {}, error() {}, warn: () => { logger.runs++; throw callerError(); } };
    return logger;
  };

  it('stream(), warning at the XML loop\'s resumption cap', async () => {
    const logger = throwingLogger();
    const adapter = new EverDeeper();
    const membrane = new Membrane(adapter, { ...noDelay, logger });
    const error = await rejection(membrane.stream(xml(), { onChunk: () => {}, maxResumptionRounds: 2 }));
    expect(logger.runs).toBe(1);
    expect(adapter.streamCalls).toBe(3);
    expect(error.retryable).toBe(false);
  });

  it('streamYielding(), warning at the XML loop\'s resumption cap', async () => {
    const logger = throwingLogger();
    const adapter = new EverDeeper();
    let error: unknown;
    for await (const event of new Membrane(adapter, { ...noDelay, logger }).streamYielding(xml(), { maxResumptionRounds: 3 })) {
      if (event.type === 'error') error = event.error;
    }
    expect(logger.runs).toBe(1);
    expect(adapter.streamCalls).toBe(4);
    expect(error).toBeInstanceOf(MembraneError);
    expect((error as MembraneError).retryable).toBe(false);
  });

  it('streamYielding(), warning that XML mode ignores refusalRetries, which it does before returning the stream', () => {
    const logger = throwingLogger();
    const adapter = new CountingAdapter();
    let thrown: unknown;
    try {
      new Membrane(adapter, { ...noDelay, logger }).streamYielding(xml(), { refusalRetries: 1 });
    } catch (error) {
      thrown = error;
    }
    expect(logger.runs).toBe(1);
    expect(adapter.streamCalls).toBe(0);
    expect(thrown).toBeInstanceOf(MembraneError);
    expect((thrown as MembraneError).retryable).toBe(false);
  });
});

describe('stream() after emission: the caller\'s error is not retryable, a provider\'s keeps its classification', () => {
  it('onChunk throws after the first chunk', async () => {
    const adapter = new CountingAdapter();
    const original = callerError();
    let chunks = 0;
    const error = await rejection(new Membrane(adapter, noDelay).stream(request(), { onChunk: () => { if (++chunks === 2) throw original; } }));
    expect(adapter.streamCalls).toBe(1);
    expect(error).toMatchObject({ type: 'rate_limit', retryable: false });
    expect(error.cause).toBe(original);
  });

  it('onChunk throws as stream() replays a non-streaming response', async () => {
    const adapter = new CountingAdapter();
    const original = callerError();
    const error = await rejection(new Membrane(adapter, noDelay).stream(request({ streaming: false }), { onChunk: () => { throw original; } }));
    expect(adapter.completeCalls).toBe(1);
    expect(error.retryable).toBe(false);
    expect(error.cause).toBe(original);
  });

  class ToolUse extends CountingAdapter {
    override async stream(req: any, callbacks: any, options?: any): Promise<any> {
      this.streamCalls++;
      options?.onRequest?.(req);
      const content = [{ type: 'text', text: 'zz before the call' }, { type: 'tool_use', id: 't9', name: 'lookup', input: {} }];
      content.forEach((block, index) => callbacks.onContentBlock?.(index, block));
      return { content, stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 }, model: req.model, rawRequest: req, raw: {} };
    }
  }

  it('onToolCalls rejects', async () => {
    const adapter = new ToolUse();
    const original = callerError();
    const onToolCalls = vi.fn(async () => { throw original; });
    const membrane = new Membrane(adapter, { ...noDelay, formatter: new NativeFormatter() });
    const error = await rejection(membrane.stream(request({ tools: [tool] }), { onChunk: () => {}, onToolCalls }));
    expect(adapter.streamCalls).toBe(1);
    expect(onToolCalls).toHaveBeenCalledTimes(1);
    expect(error.retryable).toBe(false);
    expect(error.cause).toBe(original);
  });

  it('onPreToolContent rejects', async () => {
    const adapter = new ToolUse();
    const original = callerError();
    const membrane = new Membrane(adapter, { ...noDelay, formatter: new NativeFormatter() });
    const error = await rejection(membrane.stream(request({ tools: [tool] }), {
      onChunk: () => {}, onToolCalls: async () => [], onPreToolContent: async () => { throw original; },
    }));
    expect(adapter.streamCalls).toBe(1);
    expect(error.retryable).toBe(false);
    expect(error.cause).toBe(original);
  });

  const native = { tools: [tool], toolMode: 'native' };
  const callbacks: Array<[string, () => CountingAdapter, () => NativeFormatter | undefined, Record<string, unknown>]> = [
    ['onResponse', () => new CountingAdapter(), () => undefined, {}],
    ['onUsage', () => new CountingAdapter(), () => undefined, {}],
    ['onBlock', () => new ToolUse(), () => new NativeFormatter(), native],
    ['onContentBlockUpdate', () => new ToolUse(), () => undefined, {}],
  ];
  for (const [name, makeAdapter, formatter, extra] of callbacks) {
    it(`${name} throws`, async () => {
      const adapter = makeAdapter();
      const original = callerError();
      const f = formatter();
      const membrane = new Membrane(adapter, { ...noDelay, ...(f ? { formatter: f } : {}) });
      const error = await rejection(membrane.stream(request(extra), { onChunk: () => {}, [name]: () => { throw original; } }));
      expect(adapter.streamCalls).toBe(1);
      expect(error.retryable).toBe(false);
      expect(error.cause).toBe(original);
    });
  }

  for (const name of ['onChunk', 'onUsage'] as const) {
    it(`${name} throws, through the Anthropic adapter`, async () => {
      const events = [
        { type: 'message_start', message: { id: 'msg', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
        { type: 'message_stop' },
      ];
      const adapter = new AnthropicAdapter({ apiKey: 'sk-test', cacheKeepalive: { enabled: false } });
      let sends = 0;
      const client: any = { messages: { stream: async () => { sends++; return scriptedStream(events); } } };
      client.withOptions = () => client;
      (adapter as any).client = client;
      const original = callerError();
      let runs = 0;
      const error = await rejection(new Membrane(adapter, noDelay).stream(request(), { onChunk: () => {}, [name]: () => { runs++; throw original; } }));
      expect(sends).toBe(1);
      expect(runs).toBe(1);
      expect(error.retryable).toBe(false);
      expect(error.cause).toBe(original);
    });
  }

  it('a caller\'s AbortError from onChunk still ends stream() with an AbortedResponse, as before', async () => {
    const stop = Object.assign(new Error('zz the caller stopped'), { name: 'AbortError' });
    let chunks = 0;
    const result: any = await new Membrane(new CountingAdapter(), noDelay).stream(request(), { onChunk: () => { if (++chunks === 2) throw stop; } });
    expect(result).toMatchObject({ aborted: true, reason: 'error' });
  });

  it('a provider\'s rate limit after a chunk keeps retryable: true (control)', async () => {
    class LateFailure extends CountingAdapter {
      override async stream(req: any, callbacks: any): Promise<any> {
        this.streamCalls++;
        callbacks.onChunk('partial');
        throw rateLimitError('zz the provider says slow down, after a chunk');
      }
    }
    const adapter = new LateFailure();
    const error = await rejection(new Membrane(adapter, noDelay).stream(request(), { onChunk: () => {} }));
    expect(adapter.streamCalls).toBe(1);
    expect(error).toMatchObject({ type: 'rate_limit', retryable: true });
  });
});

describe('streamYielding(): the error event carries a MembraneError that isn\'t retryable, with the caller\'s error as cause', () => {
  it('the beforeRequest hook', async () => {
    const original = callerError();
    const membrane = new Membrane(new CountingAdapter(), { hooks: { beforeRequest: async () => { throw original; } } });
    const error = await yieldingError(membrane, request());
    expect(error).toMatchObject({ type: 'rate_limit', retryable: false });
    expect(error.cause).toBe(original);
  });

  it('onCacheWireReceipt', async () => {
    const original = callerError();
    const error = await yieldingError(new Membrane(new CountingAdapter()), request({ onCacheWireReceipt: () => { throw original; } }));
    expect(error.retryable).toBe(false);
    expect(error.cause).toBe(original);
  });

  it('the onNormalize hook', async () => {
    const membrane = new Membrane(new CountingAdapter(), { formatter: new NativeFormatter(), hooks: { onNormalize: () => { throw callerError(); } } });
    const error = await yieldingError(membrane, repairedHistory());
    expect(error.retryable).toBe(false);
  });
});

describe('the Responses adapter: a throwing onFastModeFallback is logged, and the response stands', () => {
  for (const path of ['complete', 'stream'] as const) {
    it(path, async () => {
      const completed = {
        type: 'response.completed',
        response: {
          status: 'completed', service_tier: 'default',
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'zz the paid answer' }] }],
          usage: { input_tokens: 7, output_tokens: 3 },
        },
      };
      const fetch = vi.fn(async () => new Response(`data: ${JSON.stringify(completed)}\n\n`));
      vi.stubGlobal('fetch', fetch);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const original = callerError();
      const fallback = vi.fn(() => { throw original; });
      const adapter = new OpenAIResponsesAPIAdapter({ mode: 'subscription', credentials: () => ({ token: 't' }), fastMode: true, onFastModeFallback: fallback });
      const membrane = new Membrane(adapter, { ...noDelay, formatter: new OpenAIResponsesFormatter() });
      const req: NormalizedRequest = { messages: [{ participant: 'user', content: [text('hello')] }], config: { model: 'gpt-5.4', maxTokens: 100 } };
      for (let i = 0; i < 2; i++) {
        const response: any = await call(path, membrane, req);
        expect(response.content).toMatchObject([text('zz the paid answer')]);
        expect(response.usage).toMatchObject({ inputTokens: 7, outputTokens: 3 });
      }
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fallback).toHaveBeenCalledTimes(1);
      expect(fallback).toHaveBeenCalledWith('default');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls.some((args) => args.includes(original))).toBe(true);
    });
  }
});
