/**
 * Providers' error bodies as they send them: a context overflow in
 * Anthropic's and Gemini's own words (and inside OpenRouter's wrapper), a bad
 * Google key as a 400, a refusal of the account or its credential that
 * Anthropic sends as a 400, a Gemini quota no retry can outlast, a retry hint
 * stated only in prose, Bedrock's exception type in a header, and transport
 * failures that carry no status at all.
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

  it('a field that is too long is not a context overflow', async () => {
    stubHttpFailure(400, {
      error: {
        message: "Invalid 'messages[0].content': string too long. Expected a string with maximum length 10485760, but got a string with length 10485761 instead.",
        type: 'invalid_request_error',
        param: 'messages[0].content',
        code: 'string_above_max_length',
      },
    });
    expect((await failure(new OpenAIAdapter({ apiKey: 'zz-key-openai' }))).type).toBe('invalid_request');
  });

  it('a 400 with no message is not read for length, though its body echoes the request', async () => {
    // The echo is the prompt's own words, not the provider's: with no message to read, the status decides.
    stubHttpFailure(400, {
      error: {
        code: 400,
        status: 'INVALID_ARGUMENT',
        details: [{ request: { contents: 'my prompt is too long for the context window, please help' } }],
      },
    });
    expect((await failure(new GeminiAdapter({ apiKey: 'zz-key-gemini' }))).type).toBe('invalid_request');
  });
});

describe('a credential failure sent as a 400 is auth', () => {
  it.each(['API_KEY_EXPIRED', 'ACCESS_TOKEN_EXPIRED'])('gemini: INVALID_ARGUMENT with ErrorInfo reason %s', async reason => {
    stubHttpFailure(400, {
      error: {
        code: 400,
        message: 'zz credential no longer valid',
        status: 'INVALID_ARGUMENT',
        details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain: 'googleapis.com' }],
      },
    });
    const error = await failure(new GeminiAdapter({ apiKey: 'zz-key-gemini' }));
    expect(error).toMatchObject({ type: 'auth', retryable: false, httpStatus: 400 });
  });

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

describe('a refusal of the account or its credential sent as a 400 is auth', () => {
  const anthropic400 = (message: string) =>
    anthropicHandled(new Anthropic.APIError(
      400,
      { type: 'error', error: { type: 'invalid_request_error', message }, request_id: 'req_zz' },
      undefined,
      undefined as never,
    ));

  it('anthropic: "Your credit balance is too low"', () => {
    const error = anthropic400(
      'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
    );
    expect(error.type).toBe('auth');
    expect(error.retryable).toBe(false);
    expect(error.httpStatus).toBe(400);
    expect(error.providerErrorCode).toBe('invalid_request_error');
  });

  it('anthropic: "You have reached your specified API usage limits"', () => {
    const error = anthropic400(
      'You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.',
    );
    expect(error.type).toBe('auth');
    expect(error.retryable).toBe(false);
    expect(error.httpStatus).toBe(400);
  });

  it('anthropic: "This organization has been disabled."', () => {
    const error = anthropic400('This organization has been disabled.');
    expect(error.type).toBe('auth');
    expect(error.retryable).toBe(false);
    expect(error.httpStatus).toBe(400);
  });

  it('anthropic: a credential only authorized for use with Claude Code', () => {
    const error = anthropic400(
      'This credential is only authorized for use with Claude Code and cannot be used for other API requests.',
    );
    expect(error.type).toBe('auth');
    expect(error.retryable).toBe(false);
    expect(error.httpStatus).toBe(400);
  });

  it('anthropic: a 400 about the request itself stays invalid_request', () => {
    const error = anthropic400('messages: roles must alternate between "user" and "assistant", but found multiple "user" roles in a row');
    expect(error.type).toBe('invalid_request');
    expect(error.httpStatus).toBe(400);
  });

  it("anthropic: the SDK's rendering of a body with no message is not read for a refusal", () => {
    // With no top-level message, the SDK renders the whole body into error.message, echo and all.
    const body = { detail: [{ msg: 'field required', input: 'Your credit balance is too low; prompt is too long for the context window' }] };
    const error = anthropicHandled(new Anthropic.APIError(400, body, undefined, undefined as never));
    expect(error.message).toContain('credit balance is too low');
    expect(error.type).toBe('invalid_request');
  });

  it('anthropic: a plain-text body the SDK could not parse is still read', () => {
    const error = anthropicHandled(new Anthropic.APIError(400, undefined, '400 prompt is too long: 210123 tokens > 200000 maximum', undefined as never));
    expect(error.type).toBe('context_length');
    // The disabled organization is reported only as text with a 400.
    const refusal = anthropicHandled(new Anthropic.APIError(400, undefined, '400 This organization has been disabled.', undefined as never));
    expect(refusal.type).toBe('auth');
    expect(refusal.httpStatus).toBe(400);
  });

  it('a 400 whose body echoes a refusal outside any message stays invalid_request', async () => {
    stubHttpFailure(400, {
      error: {
        code: 400,
        status: 'INVALID_ARGUMENT',
        details: [{ request: { contents: 'Your credit balance is too low to access the Anthropic API, it said' } }],
      },
    });
    const error = await failure(new GeminiAdapter({ apiKey: 'zz-key-gemini' }));
    expect(error.type).toBe('invalid_request');
    expect(error.httpStatus).toBe(400);
  });

  it("openrouter: the same refusal inside the router's wrapper is auth too", async () => {
    stubHttpFailure(400, {
      error: {
        code: 400,
        message: 'Provider returned error',
        metadata: {
          provider_name: 'Anthropic',
          raw: JSON.stringify({
            type: 'error',
            error: {
              type: 'invalid_request_error',
              message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
            },
          }),
        },
      },
    });
    const error = await failure(new OpenRouterAdapter({ apiKey: 'zz-key-openrouter' }));
    expect(error.type).toBe('auth');
    expect(error.retryable).toBe(false);
    expect(error.httpStatus).toBe(400);
    // The code is the router's own, and OpenRouter's is a number.
    expect(error.providerErrorCode).toBeUndefined();
  });
});

describe('a 429 for a quota no retry can outlast is not retryable', () => {
  /** A Gemini API 429 in the shape google-gemini/gemini-cli#9248 quotes. */
  const quota429 = (quotaId: string, quotaValue: string) => ({
    error: {
      code: 429,
      message:
        'You exceeded your current quota, please check your plan and billing details. ' +
        'For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.\n' +
        `* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: ${quotaValue}\n` +
        'Please retry in 34.074824224s.',
      status: 'RESOURCE_EXHAUSTED',
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
          violations: [
            {
              quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
              quotaId,
              quotaDimensions: { location: 'global', model: 'gemini-2.5-pro' },
              quotaValue,
            },
          ],
        },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '34s' },
      ],
    },
  });

  it('gemini: a quota with no allocation at all ("quotaValue": "0")', async () => {
    stubHttpFailure(429, quota429('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '0'));
    const error = await failure(new GeminiAdapter({ apiKey: 'zz-key-gemini' }));
    expect(error.type).toBe('rate_limit');
    expect(error.retryable).toBe(false);
    expect(error.httpStatus).toBe(429);
    expect(error.providerErrorCode).toBe('RESOURCE_EXHAUSTED');
    expect(error.retryAfterMs).toBe(34_000);
  });

  it('gemini: a daily quota, used up', async () => {
    stubHttpFailure(429, quota429('GenerateRequestsPerDayPerProjectPerModel-FreeTier', '50'));
    const error = await failure(new GeminiAdapter({ apiKey: 'zz-key-gemini' }));
    expect(error.type).toBe('rate_limit');
    expect(error.retryable).toBe(false);
  });

  it('gemini: a per-minute quota stays retryable', async () => {
    stubHttpFailure(429, quota429('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '15'));
    const error = await failure(new GeminiAdapter({ apiKey: 'zz-key-gemini' }));
    expect(error.type).toBe('rate_limit');
    expect(error.retryable).toBe(true);
  });

  it("openrouter: an upstream Google quota stays retryable, since it may be the router's own", async () => {
    stubHttpFailure(429, {
      error: {
        code: 429,
        message: 'Provider returned error',
        metadata: {
          provider_name: 'Google AI Studio',
          raw: JSON.stringify(quota429('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '0')),
        },
      },
    });
    const error = await failure(new OpenRouterAdapter({ apiKey: 'zz-key-openrouter' }));
    expect(error.type).toBe('rate_limit');
    expect(error.retryable).toBe(true);
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

describe("every shape of a provider's own message, and nothing else, types the error", () => {
  /** A Gemini 429 with the QuotaFailure violations and details given. */
  const gemini429 = (details: unknown, message = 'You exceeded your current quota, please check your plan and billing details.') => ({
    error: { code: 429, message, status: 'RESOURCE_EXHAUSTED', details },
  });
  const quotaFailure = (...violations: Array<Record<string, unknown>>) => ({
    '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
    violations: violations.map((v) => ({ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', ...v })),
  });

  async function streamFailure(adapter: { stream(request: ProviderRequest, callbacks: never): Promise<unknown> }, frame: unknown): Promise<MembraneError> {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`));
        controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })));
    try {
      await adapter.stream(request, { onChunk: () => {} } as never);
    } catch (error) {
      expect(error).toBeInstanceOf(MembraneError);
      return error as MembraneError;
    }
    throw new Error('expected the stream to reject');
  }

  // The provider's message in a string `error`, an array wrapper, or an `errors` list.
  it('a string-valued error is the provider\'s message', async () => {
    stubHttpFailure(400, { error: 'prompt is too long: 210000 tokens > 200000 maximum' });
    expect((await failure(new OpenAIAdapter({ apiKey: 'zz-key-openai' }))).type).toBe('context_length');
  });

  it('a body wrapped in an array is read from its first entry', async () => {
    stubHttpFailure(400, [{ error: { code: 400, message: 'The input token count (1048577) exceeds the maximum number of tokens allowed (1048576).', status: 'INVALID_ARGUMENT' } }]);
    const error = await failure(new GeminiAdapter({ apiKey: 'zz-key-gemini' }));
    expect(error.type).toBe('context_length');
    expect(error.providerErrorCode).toBe('INVALID_ARGUMENT');
  });

  it("the first of an errors list is the provider's message", async () => {
    stubHttpFailure(400, { errors: [{ message: 'Input is too long for requested model.' }] });
    expect((await failure(new OpenAIAdapter({ apiKey: 'zz-key-openai' }))).type).toBe('context_length');
  });

  // A router's upstream body is read only as its own message.
  it("openrouter: an upstream body with no message of its own isn't read, though it echoes a refusal or an overflow", async () => {
    for (const echo of [
      'Your credit balance is too low to access the Anthropic API',
      'This organization has been disabled.',
      'This credential is only authorized for use with Claude Code and cannot be used for other API requests.',
      'my prompt is too long for the context window',
    ]) {
      stubHttpFailure(400, {
        error: {
          code: 400,
          message: 'Provider returned error',
          metadata: { provider_name: 'Anthropic', raw: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', input: echo } }) },
        },
      });
      const error = await failure(new OpenRouterAdapter({ apiKey: 'zz-key-openrouter' }));
      expect(error.type, echo).toBe('invalid_request');
    }
  });

  // What the quota rule reads.
  it('gemini: a quota whose id names a Daily window is not retryable', async () => {
    stubHttpFailure(429, gemini429([quotaFailure({ quotaId: 'GenerateContentDailyRequestsPerProject-FreeTier', quotaValue: '50' })]));
    expect((await failure(new GeminiAdapter({ apiKey: 'zz-key-gemini' }))).retryable).toBe(false);
  });

  it('gemini: any one terminal violation decides, in any QuotaFailure of the details', async () => {
    const minute = { quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier', quotaValue: '15' };
    const day = { quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaValue: '50' };
    stubHttpFailure(429, gemini429([quotaFailure(minute, day)]));
    expect((await failure(new GeminiAdapter({ apiKey: 'zz-key-gemini' }))).retryable, 'second violation').toBe(false);
    stubHttpFailure(429, gemini429([quotaFailure(minute), quotaFailure(day)]));
    expect((await failure(new GeminiAdapter({ apiKey: 'zz-key-gemini' }))).retryable, 'second QuotaFailure').toBe(false);
    stubHttpFailure(429, gemini429([quotaFailure(minute), quotaFailure({ ...minute, quotaValue: '30' })]));
    expect((await failure(new GeminiAdapter({ apiKey: 'zz-key-gemini' }))).retryable, 'per-minute only').toBe(true);
  });

  it('gemini: a zero allocation written as a number is not retryable either', async () => {
    stubHttpFailure(429, gemini429([quotaFailure({ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier', quotaValue: 0 })]));
    expect((await failure(new GeminiAdapter({ apiKey: 'zz-key-gemini' }))).retryable).toBe(false);
  });

  it('gemini: details that are not a list, or entries of another type, leave the 429 retryable', async () => {
    stubHttpFailure(429, gemini429({ violations: [{ quotaValue: '0' }] }));
    const notAList = await failure(new GeminiAdapter({ apiKey: 'zz-key-gemini' }));
    expect(notAList.type).toBe('rate_limit');
    expect(notAList.retryable).toBe(true);
    // Still read field by field: a throw while reading a parsed body would fall
    // back to the raw text, losing the code.
    expect(notAList.providerErrorCode).toBe('RESOURCE_EXHAUSTED');
    stubHttpFailure(429, gemini429([{ '@type': 'type.googleapis.com/google.rpc.PreconditionFailure', violations: [{ quotaValue: '0', quotaId: 'PerDay' }] }]));
    expect((await failure(new GeminiAdapter({ apiKey: 'zz-key-gemini' }))).retryable).toBe(true);
  });

  // The stream error frame passes its body to the same rules.
  it('gemini: an SSE error frame with a zero allocation is not retryable', async () => {
    const frame = gemini429([quotaFailure({ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier', quotaValue: '0' })]);
    const error = await streamFailure(new GeminiAdapter({ apiKey: 'zz-key-gemini' }), frame);
    expect(error.type).toBe('rate_limit');
    expect(error.retryable).toBe(false);
  });

  it("a 400 error frame with no message isn't read for a refusal, though its rendering echoes one", async () => {
    const frame = { error: { code: 400, status: 'INVALID_ARGUMENT', details: [{ request: 'Your credit balance is too low to access the Anthropic API, it said' }] } };
    const error = await streamFailure(new GeminiAdapter({ apiKey: 'zz-key-gemini' }), frame);
    expect(error.type).toBe('invalid_request');
    expect(error.httpStatus).toBe(400);
  });

  // The overflow forms that stay, on both paths.
  it('"input is too long", and the forms without "is", are a context overflow with a status and without one', async () => {
    for (const message of ['Input is too long for requested model.', 'input too long for this model', 'Prompt too long: 210000 tokens']) {
      stubHttpFailure(400, { error: { message } });
      expect((await failure(new OpenAIAdapter({ apiKey: 'zz-key-openai' }))).type, message).toBe('context_length');
      expect(classifyError(new Error(message)).type, `${message} (no status)`).toBe('context_length');
    }
    expect(classifyError(new Error("Invalid 'input': string too long. Expected a string with maximum length 10")).type).not.toBe('context_length');
  });

  // Without a status, the echo-sensitive forms read the provider's own message too.
  it('without a status, a refusal in the provider\'s own message is auth, as with one', () => {
    for (const message of [
      'Your credit balance is too low to access the Anthropic API.',
      'This organization has been disabled.',
      'This credential is only authorized for use with Claude Code and cannot be used for other API requests.',
    ]) {
      expect(classifyError(new Error(message)), message).toMatchObject({ type: 'auth', retryable: false });
    }
  });

  it("without a status, a frame with no message of its own isn't read for an overflow or a refusal", async () => {
    for (const echo of [
      'my prompt is too long for the context window',
      'Your credit balance is too low to access the Anthropic API',
      'This organization has been disabled.',
      'This credential is only authorized for use with Claude Code and cannot be used for other API requests.',
    ]) {
      const error = await streamFailure(new GeminiAdapter({ apiKey: 'zz-key-gemini' }), { error: { details: [{ request: echo }] } });
      expect(error.httpStatus, echo).toBeUndefined();
      expect(error.type, echo).not.toBe('context_length');
      expect(error.type, echo).not.toBe('auth');
    }
  });

  // A 429 no retry can outlast states no wait in prose.
  it("a 429 that isn't retryable takes no wait from its prose, though its own RetryInfo is still reported", async () => {
    const zero = quotaFailure({ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier', quotaValue: '0' });
    stubHttpFailure(429, gemini429([zero], 'Quota exceeded. Please retry after 30 seconds.'));
    const prose = await failure(new GeminiAdapter({ apiKey: 'zz-key-gemini' }));
    expect(prose.retryable).toBe(false);
    expect(prose.retryAfterMs).toBeUndefined();
    stubHttpFailure(429, gemini429([zero, { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '34s' }]));
    expect((await failure(new GeminiAdapter({ apiKey: 'zz-key-gemini' }))).retryAfterMs).toBe(34_000);
    stubHttpFailure(429, { error: { code: 'insufficient_quota', message: 'You exceeded your current quota. Please retry after 20 seconds.' } });
    const billing = await failure(new OpenAIAdapter({ apiKey: 'zz-key-openai' }));
    expect(billing.retryable).toBe(false);
    expect(billing.retryAfterMs).toBeUndefined();
  });
});
