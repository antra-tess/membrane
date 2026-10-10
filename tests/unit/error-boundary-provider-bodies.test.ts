/**
 * Real provider error bodies at the shared boundary, from review of #56.
 *
 * The status-guarded classifier must read each form a provider actually
 * sends: a context overflow in Anthropic's and Gemini's own words (and inside
 * OpenRouter's wrapper), a bad Google key that arrives as a 400, a retry hint
 * stated only in prose, Bedrock's exception type in a header, and transport
 * failures that carry no status at all. Anything typed wrongly here reaches
 * agent-framework's poison-history breaker as `invalid_request`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { GeminiAdapter } from '../../src/providers/gemini.js';
import { OpenRouterAdapter } from '../../src/providers/openrouter.js';
import { OpenAIAdapter } from '../../src/providers/openai.js';
import { BedrockAdapter } from '../../src/providers/bedrock.js';
import { MembraneError, classifyError } from '../../src/types/errors.js';
import type { ProviderRequest } from '../../src/types/provider.js';

const request: ProviderRequest = { model: 'zz-model-1', messages: [{ role: 'user', content: 'zz-prompt' }], maxTokens: 16 };

function stubHttpFailure(status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(text, { status, headers })));
}

async function failure(adapter: { complete(request: ProviderRequest): Promise<unknown> }): Promise<MembraneError> {
  try {
    await adapter.complete(request);
  } catch (error) {
    expect(error).toBeInstanceOf(MembraneError);
    return error as MembraneError;
  }
  throw new Error('expected the call to reject');
}

function anthropicHandled(error: unknown): MembraneError {
  const adapter = new AnthropicAdapter({ apiKey: 'zz-key-anthropic' });
  return (adapter as unknown as { handleError(error: unknown): MembraneError }).handleError(error);
}

afterEach(() => vi.unstubAllGlobals());

describe('a context overflow in each provider\'s own words is context_length', () => {
  it('anthropic: "input length and `max_tokens` exceed context limit"', () => {
    const body = {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'input length and `max_tokens` exceed context limit: 196738 + 8192 > 200000, decrease input length or `max_tokens` and try again',
      },
    };
    const error = anthropicHandled(new Anthropic.APIError(400, body, undefined, undefined as never));
    expect(error.type).toBe('context_length');
    expect(error.retryable).toBe(false);
    expect(error.httpStatus).toBe(400);
    expect(error.providerErrorCode).toBe('invalid_request_error');
  });

  it('anthropic: "prompt is too long"', () => {
    const body = { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 210123 tokens > 200000 maximum' } };
    expect(anthropicHandled(new Anthropic.APIError(400, body, undefined, undefined as never)).type).toBe('context_length');
  });

  it('gemini: "The input token count (N) exceeds the maximum number of input tokens allowed (M)"', async () => {
    stubHttpFailure(400, {
      error: {
        code: 400,
        message: 'The input token count (1150231) exceeds the maximum number of input tokens allowed (1048576).',
        status: 'INVALID_ARGUMENT',
      },
    });
    const error = await failure(new GeminiAdapter({ apiKey: 'zz-key-gemini' }));
    expect(error.type).toBe('context_length');
    expect(error.httpStatus).toBe(400);
  });

  it('openrouter: a generic "Provider returned error" classifies by the upstream body in metadata.raw', async () => {
    stubHttpFailure(400, {
      error: {
        code: 400,
        message: 'Provider returned error',
        metadata: {
          provider_name: 'Anthropic',
          raw: JSON.stringify({
            type: 'error',
            error: { type: 'invalid_request_error', message: 'prompt is too long: 210123 tokens > 200000 maximum' },
          }),
        },
      },
    });
    const error = await failure(new OpenRouterAdapter({ apiKey: 'zz-key-openrouter' }));
    expect(error.type).toBe('context_length');
    expect(error.httpStatus).toBe(400);
  });

  it('openrouter: the same, mid-stream, in an HTTP-200 SSE error frame', async () => {
    const frame = JSON.stringify({
      error: {
        code: 400,
        message: 'Provider returned error',
        metadata: { raw: '{"error":{"message":"This model\'s maximum context length is 128000 tokens.","code":"context_length_exceeded"}}' },
      },
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${frame}\n\n`));
        controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })));
    const adapter = new OpenRouterAdapter({ apiKey: 'zz-key-openrouter' });
    let caught: unknown;
    try {
      await adapter.stream(request, { onChunk: () => {} } as never);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MembraneError);
    expect((caught as MembraneError).type).toBe('context_length');
  });

  it('a 400 that is not about length stays invalid_request', async () => {
    stubHttpFailure(400, { error: { code: 400, message: 'Invalid value at contents[0].role', status: 'INVALID_ARGUMENT' } });
    expect((await failure(new GeminiAdapter({ apiKey: 'zz-key-gemini' }))).type).toBe('invalid_request');
  });
});

describe('a credential failure sent as a 400 is auth', () => {
  it('gemini: INVALID_ARGUMENT with ErrorInfo reason API_KEY_INVALID', async () => {
    stubHttpFailure(400, {
      error: {
        code: 400,
        message: 'API key not valid. Please pass a valid API key.',
        status: 'INVALID_ARGUMENT',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason: 'API_KEY_INVALID',
            domain: 'googleapis.com',
            metadata: { service: 'generativelanguage.googleapis.com' },
          },
        ],
      },
    });
    const error = await failure(new GeminiAdapter({ apiKey: 'zz-key-gemini' }));
    expect(error.type).toBe('auth');
    expect(error.retryable).toBe(false);
    expect(error.httpStatus).toBe(400);
    expect(error.providerErrorCode).toBe('INVALID_ARGUMENT');
  });

  it('an invalid_api_key code on a 400', async () => {
    stubHttpFailure(400, { error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } });
    const error = await failure(new OpenAIAdapter({ apiKey: 'zz-key-openai' }));
    expect(error.type).toBe('auth');
    expect(error.httpStatus).toBe(400);
  });
});

describe('retry hints and codes carried outside the usual fields', () => {
  it('reads a retry hint stated only in prose', async () => {
    stubHttpFailure(429, {
      error: { code: '429', message: 'Requests to the ChatCompletions_Create Operation have exceeded the token rate limit. Please retry after 60 seconds.' },
    });
    const error = await failure(new OpenAIAdapter({ apiKey: 'zz-key-openai' }));
    expect(error.type).toBe('rate_limit');
    expect(error.retryAfterMs).toBe(60_000);
  });

  it('reads prose only as stated seconds, and only on an error that asks to be retried', async () => {
    // Not a wait in seconds: another unit, a timestamp, a count of attempts.
    for (const message of [
      'Too many requests. Please retry after 5 minutes.',
      'Too many requests. Retry after 1 hour',
      'Too many requests. Please retry after 2026-10-09T15:00:00Z',
      'Rate limited; do not retry after 3 attempts',
    ]) {
      stubHttpFailure(429, { error: { message } });
      const error = await failure(new OpenAIAdapter({ apiKey: 'zz-key-openai' }));
      expect(error.type, message).toBe('rate_limit');
      expect(error.retryAfterMs, message).toBeUndefined();
    }
    // A 400 whose text says "retry after N seconds" states no wait to honour.
    stubHttpFailure(400, { error: { message: 'Invalid model name. Please retry after 30 seconds.' } });
    const invalid = await failure(new OpenAIAdapter({ apiKey: 'zz-key-openai' }));
    expect(invalid.type).toBe('invalid_request');
    expect(invalid.retryAfterMs).toBeUndefined();
    // A transient 503 that states one is believed.
    stubHttpFailure(503, { error: { message: 'Service is busy. Please retry after 12 seconds.' } });
    expect((await failure(new OpenAIAdapter({ apiKey: 'zz-key-openai' }))).retryAfterMs).toBe(12_000);
  });

  it('a retry-after header still wins over prose', async () => {
    stubHttpFailure(429, { error: { message: 'Please retry after 60 seconds.' } }, { 'retry-after': '7' });
    expect((await failure(new OpenAIAdapter({ apiKey: 'zz-key-openai' }))).retryAfterMs).toBe(7_000);
  });

  it("carries bedrock's x-amzn-ErrorType header as the provider code", async () => {
    stubHttpFailure(429, { message: 'Too many requests, please wait before trying again.' }, {
      'x-amzn-ErrorType': 'ThrottlingException:http://internal.amazon.com/coral/com.amazon.bedrock/',
    });
    const error = await failure(new BedrockAdapter({ accessKeyId: 'zz-access-key', secretAccessKey: 'zz-secret-key', region: 'zz-region-1' }));
    expect(error.type).toBe('rate_limit');
    expect(error.providerErrorCode).toBe('ThrottlingException');
  });
});

describe('transport failures without a status are typed', () => {
  it("anthropic: the SDK's APIConnectionError is a retryable network error", () => {
    const sdkError = new Anthropic.APIConnectionError({ cause: new TypeError('fetch failed') });
    const error = anthropicHandled(sdkError);
    expect(error.type).toBe('network');
    expect(error.retryable).toBe(true);
  });

  it("anthropic: the SDK's APIConnectionTimeoutError is a retryable timeout", () => {
    const error = anthropicHandled(new Anthropic.APIConnectionTimeoutError());
    expect(error.type).toBe('timeout');
    expect(error.retryable).toBe(true);
  });

  it("a socket code on the error or its cause classifies it, whatever the message says", () => {
    const bun = Object.assign(new Error('Unable to connect. Is the computer able to access the url?'), { code: 'ConnectionRefused' });
    expect(classifyError(bun)).toMatchObject({ type: 'network', retryable: true });
    const node = new TypeError('fetch failed', { cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }) });
    expect(classifyError(node)).toMatchObject({ type: 'network', retryable: true });
    const dns = new Error('getaddrinfo', { cause: { code: 'ENOTFOUND' } });
    expect(classifyError(dns)).toMatchObject({ type: 'network', retryable: true });
    const slow = Object.assign(new Error('connect'), { code: 'UND_ERR_CONNECT_TIMEOUT' });
    expect(classifyError(slow)).toMatchObject({ type: 'timeout', retryable: true });
    expect(classifyError(Object.assign(new Error('zz-internal'), { code: 'ERR_ZZ' })).type).toBe('unknown');
  });
});
