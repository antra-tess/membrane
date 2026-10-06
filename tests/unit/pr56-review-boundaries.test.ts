import { afterEach, describe, expect, it, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { Membrane } from '../../src/membrane.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { OpenAIAdapter } from '../../src/providers/openai.js';
import { OpenAICompatibleAdapter } from '../../src/providers/openai-compatible.js';
import { OpenAICompletionsAdapter } from '../../src/providers/openai-completions.js';
import { OpenAIResponsesAPIAdapter } from '../../src/providers/openai-responses-api.js';
import { OpenRouterAdapter } from '../../src/providers/openrouter.js';
import { GeminiAdapter } from '../../src/providers/gemini.js';
import { BedrockAdapter } from '../../src/providers/bedrock.js';
import { MembraneError, MembraneNotReadyError, TimeoutAbortError, withRawRequest } from '../../src/types/errors.js';
import type { NormalizedRequest, ProviderAdapter, ProviderRequest } from '../../src/types/index.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const wire: ProviderRequest = { model: 'zz-review-model', messages: [{ role: 'user', content: 'go' }], maxTokens: 16 };
const request: NormalizedRequest = {
  config: { model: 'zz-review-model', maxTokens: 16 }, toolMode: 'native',
  messages: [{ participant: 'User', content: [{ type: 'text', text: 'go' }] }],
};
const factories = [
  ['OpenAI', () => new OpenAIAdapter({ apiKey: 'zz-key' })],
  ['compatible', () => new OpenAICompatibleAdapter({ apiKey: 'zz-key', baseURL: 'https://review.invalid/v1' })],
  ['completions', () => new OpenAICompletionsAdapter({ apiKey: 'zz-key', baseURL: 'https://review.invalid/v1' })],
  ['Responses', () => new OpenAIResponsesAPIAdapter({ apiKey: 'zz-key' })],
  ['OpenRouter', () => new OpenRouterAdapter({ apiKey: 'zz-key' })],
  ['Gemini', () => new GeminiAdapter({ apiKey: 'zz-key' })],
  ['Bedrock', () => new BedrockAdapter({ accessKeyId: 'zz-access', secretAccessKey: 'zz-secret', region: 'us-east-1' })],
] as const;
async function invokeAdapter(adapter: ProviderAdapter, entry: string, options = {}) {
  return entry === 'complete' ? adapter.complete(wire, options) : adapter.stream(wire, { onChunk() {} }, options);
}
async function invoke(membrane: Membrane, entry: string) {
  if (entry === 'complete') return membrane.complete(request);
  if (entry === 'stream') return membrane.stream(request);
  for await (const event of membrane.streamYielding(request)) {
    if (event.type === 'error') throw event.error;
    if (event.type === 'complete') return event.response;
  }
  throw new Error('no completion');
}
function sse(frames: unknown[]) {
  return new Response(frames.map(frame => 'data: ' + (typeof frame === 'string' ? frame : JSON.stringify(frame)) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } });
}

describe('fetch failures preserve transport retryability', () => {
  for (const [name, create] of factories) for (const entry of ['complete', 'stream']) {
    it.each(['fetch failed', 'Failed to fetch'])(name + ' ' + entry + ' %s', async message => {
      vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError(message); }));
      await expect(invokeAdapter(create(), entry)).rejects.toMatchObject({ type: 'network', retryable: true });
    });
  }
  it.each(['complete', 'stream', 'yielding'])('%s retains its own retry policy', async entry => {
    let sends = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (++sends === 1) throw new TypeError('fetch failed');
      return new Response(JSON.stringify({ choices: [{ message: { content: 'done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    }));
    const membrane = new Membrane(new OpenAIAdapter({ apiKey: 'zz-key' }), {
      formatter: new NativeFormatter(), retry: { maxRetries: 2, retryDelayMs: 1 },
    });
    if (entry === 'complete') {
      await invoke(membrane, entry);
      expect(sends).toBe(2);
    } else {
      await expect(invoke(membrane, entry)).rejects.toMatchObject({ type: 'network', retryable: true });
      expect(sends).toBe(1);
    }
  });
});

describe('Anthropic gateway metadata does not override an authoritative status', () => {
  const cases = [
    [401, 'authentication_error', 'auth', false],
    [400, 'invalid_request_error', 'invalid_request', false],
    [429, 'insufficient_quota', 'rate_limit', false],
    [429, 'rate_limit_error', 'rate_limit', true],
    [503, 'api_error', 'server', true],
    [undefined, 'overloaded_error', 'server', true],
  ] as const;
  it.each(cases)('preserves %s / %s', (status, code, type, retryable) => {
    const adapter = new AnthropicAdapter({ apiKey: 'zz-key', cacheKeepalive: { enabled: false } });
    const error = new Anthropic.APIError(status, { error: { type: code, message: 'providerMetadata: modelAttempts trace' } }, undefined, new Headers({ 'retry-after': '7' }));
    const got = (adapter as any).handleError(error, wire);
    expect(got).toMatchObject({
      type, retryable, httpStatus: status ?? 529, providerErrorCode: code, retryAfterMs: 7000, rawRequest: wire,
    });
  });
  it('retains the unknown-status gateway outage fallback', () => {
    const adapter = new AnthropicAdapter({ apiKey: 'zz-key', cacheKeepalive: { enabled: false } });
    const error = new Anthropic.APIError(undefined, { message: 'no_providers_available' }, undefined, new Headers());
    expect((adapter as any).handleError(error)).toMatchObject({ type: 'server', retryable: true, httpStatus: 503 });
  });
});

describe('Bedrock error requests have the same invocation identity as onRequest', () => {
  it.each(['complete', 'stream'])('%s includes modelId and stream identity', async entry => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"message":"unavailable","__type":"ServiceUnavailableException"}', { status: 503 })));
    const adapter = new BedrockAdapter({ accessKeyId: 'zz-access', secretAccessKey: 'zz-secret', region: 'us-east-1' });
    let observed: unknown;
    const error = await invokeAdapter(adapter, entry, { onRequest: (body: unknown) => { observed = body; } }).catch(e => e);
    expect(error).toBeInstanceOf(MembraneError);
    expect(error.rawRequest).toEqual(observed);
    expect(error.rawRequest.modelId).toContain('zz-review-model');
    expect(error.rawRequest.stream).toBe(entry === 'stream' ? true : undefined);
  });
});

describe('raw stop metadata reaches public response paths', () => {
  for (const provider of ['openai', 'gemini']) for (const entry of ['complete', 'stream', 'yielding']) {
    it(provider + '/' + entry + ' reports the original length token', async () => {
      const complete = provider === 'openai'
        ? { choices: [{ message: { content: 'partial' }, finish_reason: 'length' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }
        : { candidates: [{ content: { parts: [{ text: 'partial' }] }, finishReason: 'MAX_TOKENS' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } };
      vi.stubGlobal('fetch', vi.fn(async () => entry === 'complete'
        ? new Response(JSON.stringify(complete))
        : sse(provider === 'openai'
          ? [{ choices: [{ delta: { content: 'partial' }, finish_reason: 'length' }] }, '[DONE]']
          : [complete])));
      const adapter = provider === 'openai' ? new OpenAIAdapter({ apiKey: 'zz-key' }) : new GeminiAdapter({ apiKey: 'zz-key' });
      const result = await invoke(new Membrane(adapter, { formatter: new NativeFormatter() }), entry);
      expect(result).toMatchObject({ stopReason: 'max_tokens', details: { stop: { reason: 'max_tokens', wasTruncated: true, providerReason: provider === 'openai' ? 'length' : 'MAX_TOKENS' } } });
    });
  }
  it.each(['complete', 'stream', 'yielding'])('%s omits an unreported custom-adapter raw token', async entry => {
    const response = { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 }, raw: {} };
    const adapter: ProviderAdapter = { name: 'custom', supportsModel: () => true, complete: async () => response, stream: async () => response };
    const result = await invoke(new Membrane(adapter, { formatter: new NativeFormatter() }), entry) as any;
    expect(result.details.stop.providerReason).toBeUndefined();
  });
  it('does not fabricate a stop token from a bare DONE frame', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sse(['[DONE]'])));
    const result = await new OpenAIAdapter({ apiKey: 'zz-key' }).stream(wire, { onChunk() {} }) as any;
    expect(result.stopReason).toBe('end_turn');
    expect(result.providerStopReason).toBeUndefined();
  });
});

describe('request enrichment retains error identity', () => {
  it.each([new TimeoutAbortError('deadline'), new MembraneNotReadyError('native')])('retains %s', error => {
    expect(withRawRequest(error, wire)).toBe(error);
    expect(error.rawRequest).toBe(wire);
  });
  it('keeps private subclass state and preexisting request metadata', () => {
    class PrivateError extends MembraneError {
      #identity = 9;
      read() { return this.#identity; }
    }
    const error = new PrivateError({ type: 'auth', message: 'credentials', retryable: false });
    expect(withRawRequest(error, wire)).toBe(error);
    expect(error.read()).toBe(9);
    expect(withRawRequest(error, { changed: true }).rawRequest).toBe(wire);
  });
  it('propagates immutable errors unchanged', () => {
    const error = Object.freeze(new TimeoutAbortError('frozen deadline'));
    expect(withRawRequest(error, wire)).toBe(error);
    expect(error.rawRequest).toBeUndefined();
  });
});

function bedrockFrame(event: unknown): Uint8Array {
  const name = Buffer.from(':event-type'), value = Buffer.from('chunk');
  const headers = Buffer.alloc(1 + name.length + 1 + 2 + value.length);
  headers[0] = name.length; name.copy(headers, 1);
  headers[1 + name.length] = 7;
  headers.writeUInt16BE(value.length, 2 + name.length);
  value.copy(headers, 4 + name.length);
  const payload = Buffer.from(JSON.stringify({ bytes: Buffer.from(JSON.stringify(event)).toString('base64') }));
  const frame = Buffer.alloc(16 + headers.length + payload.length);
  frame.writeUInt32BE(frame.length, 0); frame.writeUInt32BE(headers.length, 4);
  headers.copy(frame, 12); payload.copy(frame, 12 + headers.length);
  return frame;
}
function anthropicEvents(reason?: string) {
  return [
    { type: 'message_start', message: { id: 'zz', type: 'message', role: 'assistant', model: 'zz-model', content: [], usage: { input_tokens: 2, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { ...(reason === undefined ? {} : { stop_reason: reason }) }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ];
}

describe('other built-in stop carriers', () => {
  for (const [name, create] of factories.filter(([name]) => ['compatible', 'completions', 'OpenRouter'].includes(name))) {
    it.each(['complete', 'stream'])(name + ' %s carries length before mapping', async entry => {
      vi.stubGlobal('fetch', vi.fn(async () => entry === 'complete'
        ? new Response(JSON.stringify({ choices: [{ message: { content: 'partial' }, text: 'partial', finish_reason: 'length' }], usage: {} }))
        : sse([{ choices: [{ delta: { content: 'partial' }, text: 'partial', finish_reason: 'length' }] }, '[DONE]'])));
      const response = await invokeAdapter(create(), entry) as any;
      expect(response.stopReason).toBe('max_tokens');
      expect(response.providerStopReason).toBe('length');
    });
  }
  for (const provider of ['anthropic', 'bedrock']) {
    const create = () => provider === 'anthropic'
      ? new AnthropicAdapter({ apiKey: 'zz-key', cacheKeepalive: { enabled: false } })
      : new BedrockAdapter({ accessKeyId: 'zz-access', secretAccessKey: 'zz-secret', region: 'us-east-1' });
    for (const entry of ['complete', 'stream']) {
      it(provider + '/' + entry + ' carries the observed max_tokens token', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => {
          if (entry === 'complete') return new Response(JSON.stringify({
            id: 'zz', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'partial' }],
            stop_reason: 'max_tokens', usage: { input_tokens: 2, output_tokens: 1 }, model: 'zz-model',
          }), { headers: { 'content-type': 'application/json' } });
          const events = anthropicEvents('max_tokens');
          return provider === 'anthropic'
            ? new Response(events.map(event => 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } })
            : new Response(Buffer.concat(events.map(bedrockFrame)));
        }));
        const response = await invokeAdapter(create(), entry) as any;
        expect(response.stopReason).toBe('max_tokens');
        expect(response.providerStopReason).toBe('max_tokens');
      });
    }
    it(provider + ' does not manufacture a missing stream reason', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => {
        const events = anthropicEvents();
        return provider === 'anthropic'
          ? new Response(events.map(event => 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } })
          : new Response(Buffer.concat(events.map(bedrockFrame)));
      }));
      const response = await invokeAdapter(create(), 'stream') as any;
      expect(response.stopReason).toBe('end_turn');
      expect(response.providerStopReason).toBeUndefined();
    });
  }
  it.each(['complete', 'stream'])('Responses %s carries incomplete_details.reason', async entry => {
    const response = { id: 'zz', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [], usage: { input_tokens: 1, output_tokens: 0 } };
    vi.stubGlobal('fetch', vi.fn(async () => entry === 'complete'
      ? new Response(JSON.stringify(response))
      : sse([{ type: 'response.incomplete', response }])));
    expect(await invokeAdapter(new OpenAIResponsesAPIAdapter({ apiKey: 'zz-key' }), entry)).toMatchObject({
      stopReason: 'max_tokens', providerStopReason: 'max_output_tokens',
    });
  });
  it('retains custom-adapter raw metadata separately from its normalized reason', async () => {
    const response = { content: [], stopReason: 'max_tokens', providerStopReason: 'CUSTOM_LIMIT', usage: { inputTokens: 0, outputTokens: 0 }, raw: {} };
    const adapter: ProviderAdapter = { name: 'custom', supportsModel: () => true, complete: async () => response, stream: async () => response };
    const result = await new Membrane(adapter, { formatter: new NativeFormatter() }).complete(request);
    expect(result.details.stop).toMatchObject({ reason: 'max_tokens', providerReason: 'CUSTOM_LIMIT' });
  });
});

describe('SSE payload classification shares HTTP-boundary semantics', () => {
  const frames = [
    { error: { code: 429, type: 'insufficient_quota', message: 'billing' }, type: 'rate_limit', retryable: false, status: 429, code: 'insufficient_quota' },
    { error: { code: '429', type: 'insufficient_quota', message: 'billing' }, type: 'rate_limit', retryable: false, status: 429, code: 'insufficient_quota' },
    { error: { status: 429, code: 'rate_limit_exceeded', retry_after_ms: 7, message: 'wait' }, type: 'rate_limit', retryable: true, status: 429, code: 'rate_limit_exceeded', hint: 7 },
    { error: { status: 401, code: 'rate_limit_exceeded', message: 'conflicting token' }, type: 'auth', retryable: false, status: 401, code: 'rate_limit_exceeded' },
    { error: { status: 200, code: 'insufficient_quota', message: 'successful transport, failed call' }, type: 'rate_limit', retryable: false, status: 429, code: 'insufficient_quota' },
    { error: { code: 1009, type: 'permission_error', message: 'provider number' }, type: 'auth', retryable: false, status: 403, code: 'permission_error' },
    { error: { code: '1009', type: 'too_many_requests', retryDelay: '0.007s', message: 'provider number' }, type: 'rate_limit', retryable: true, status: 429, code: 'too_many_requests', hint: 7 },
    { error: { code: 400, type: 'zz_unrecognized_frame_1', message: 'bad request' }, type: 'invalid_request', retryable: false, status: 400, code: 'zz_unrecognized_frame_1' },
    { error: { code: 'zz_future_error', message: 'diagnostic' }, type: 'unknown', retryable: false, status: undefined, code: 'zz_future_error' },
  ];
  it.each(frames)('preserves structured $code, status=$status', async ({ error, type, retryable, status, code, hint }) => {
    vi.stubGlobal('fetch', vi.fn(async () => sse([{ error }])));
    const thrown = await new OpenAIAdapter({ apiKey: 'zz-key' }).stream(wire, { onChunk() {} }).catch(e => e);
    expect(thrown).toBeInstanceOf(MembraneError);
    expect(thrown).toMatchObject({ type, retryable, httpStatus: status, providerErrorCode: code, retryAfterMs: hint });
    expect(thrown.rawError).toEqual({ error });
    expect(thrown.message).toContain(error.message);
  });
  for (const entry of ['stream', 'yielding']) {
    it(entry + ' treats terminal SSE quota as a single failed call', async () => {
      const fetch = vi.fn(async () => sse([{ error: { code: '429', type: 'insufficient_quota', message: 'billing' } }]));
      vi.stubGlobal('fetch', fetch);
      const membrane = new Membrane(new OpenAIAdapter({ apiKey: 'zz-key' }), { formatter: new NativeFormatter(), retry: { retryDelayMs: 1 } });
      await expect(invoke(membrane, entry)).rejects.toMatchObject({ type: 'rate_limit', retryable: false, providerErrorCode: 'insufficient_quota' });
      expect(fetch).toHaveBeenCalledTimes(1);
    });
    it(entry + ' keeps its existing transient SSE-rate-limit retry policy', async () => {
      let sends = 0;
      const fetch = vi.fn(async () => ++sends === 1
        ? sse([{ error: { status: 429, code: 'rate_limit_exceeded', message: 'wait', retry_after_ms: 1 } }])
        : sse([{ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }, '[DONE]']));
      vi.stubGlobal('fetch', fetch);
      const membrane = new Membrane(new OpenAIAdapter({ apiKey: 'zz-key' }), { formatter: new NativeFormatter(), retry: { retryDelayMs: 1 } });
      if (entry === 'stream') {
        await invoke(membrane, entry);
        expect(sends).toBe(2);
      } else {
        await expect(invoke(membrane, entry)).rejects.toMatchObject({ type: 'rate_limit', retryable: true, providerErrorCode: 'rate_limit_exceeded' });
        expect(sends).toBe(1);
      }
    });
  }
});

describe('public error propagation retains classified identity', () => {
  it.each(['complete', 'stream', 'yielding'])('%s preserves a custom subtype and its more-specific request', async entry => {
    class CredentialError extends MembraneError { #receipt = 7; receipt() { return this.#receipt; } }
    const raw = { evidence: 'adapter-owned request identity' };
    const error = new CredentialError({ type: 'auth', retryable: false, message: 'credential refused', rawRequest: raw });
    const adapter: ProviderAdapter = { name: 'custom', supportsModel: () => true, complete: async () => { throw error; }, stream: async () => { throw error; } };
    const thrown = await invoke(new Membrane(adapter, { formatter: new NativeFormatter() }), entry).catch(e => e);
    expect(thrown).toBe(error);
    expect(thrown.receipt()).toBe(7);
    expect(thrown.rawRequest).toBe(raw);
  });
  it('complete preserves identity when onError asks to abort retries', async () => {
    const error = new MembraneError({ type: 'rate_limit', retryable: true, httpStatus: 429, message: 'wait' });
    const adapter: ProviderAdapter = { name: 'custom', supportsModel: () => true, complete: async () => { throw error; }, stream: async () => { throw error; } };
    const membrane = new Membrane(adapter, { formatter: new NativeFormatter(), hooks: { onError: () => 'abort' } });
    await expect(membrane.complete(request)).rejects.toBe(error);
  });
});
