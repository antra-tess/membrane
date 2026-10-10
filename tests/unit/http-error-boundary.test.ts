/**
 * HTTP-boundary error classification.
 *
 * Every adapter holds a live Response — status, headers — at the moment a
 * call fails, and used to throw it away in favour of a rendered string that
 * its own handleError re-derived a classification from by substring. That
 * round trip fabricated statuses (503 -> 500), erased them entirely
 * (402/403/404/413/422 -> undefined), dropped retry-after and the provider's
 * own error code, and promoted unrelated bodies by accident ("no completion
 * was generated" -> rate_limit).
 *
 * These probes drive each adapter through a stubbed fetch and assert on what
 * reaches the caller.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIAdapter } from '../../src/providers/openai.js';
import { OpenAICompatibleAdapter } from '../../src/providers/openai-compatible.js';
import { OpenAICompletionsAdapter } from '../../src/providers/openai-completions.js';
import { OpenRouterAdapter } from '../../src/providers/openrouter.js';
import { GeminiAdapter } from '../../src/providers/gemini.js';
import { BedrockAdapter } from '../../src/providers/bedrock.js';
import { OpenAIResponsesAPIAdapter } from '../../src/providers/openai-responses-api.js';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import Anthropic from '@anthropic-ai/sdk';
import { MembraneError, isOverloadedError, classifyError } from '../../src/types/errors.js';
import type { ProviderRequest } from '../../src/types/provider.js';

const zzRequest: ProviderRequest = {
  model: 'zz-model-1',
  messages: [{ role: 'user', content: 'zz-prompt' }],
  maxTokens: 16,
};

function stubHttpFailure(status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(text, { status, headers })));
}

async function captureCompleteError(
  adapter: { complete(request: ProviderRequest): Promise<unknown> },
): Promise<MembraneError> {
  try {
    await adapter.complete(zzRequest);
  } catch (error) {
    expect(error).toBeInstanceOf(MembraneError);
    return error as MembraneError;
  }
  throw new Error('expected the adapter call to reject');
}

const openai = () => new OpenAIAdapter({ apiKey: 'zz-key-openai' });
const compatible = () =>
  new OpenAICompatibleAdapter({ apiKey: 'zz-key-compat', baseURL: 'https://zz-compat.invalid/v1' });
const completions = () =>
  new OpenAICompletionsAdapter({ apiKey: 'zz-key-completions', baseURL: 'https://zz-completions.invalid/v1' });
const openrouter = () => new OpenRouterAdapter({ apiKey: 'zz-key-openrouter' });
const gemini = () => new GeminiAdapter({ apiKey: 'zz-key-gemini' });
const bedrock = () =>
  new BedrockAdapter({ accessKeyId: 'zz-access-key', secretAccessKey: 'zz-secret-key', region: 'zz-region-1' });
const responsesApi = () => new OpenAIResponsesAPIAdapter({ apiKey: 'zz-key-responses' });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('status is preserved verbatim', () => {
  it('reports a 503 as 503, not a fabricated 500', async () => {
    stubHttpFailure(503, { error: { message: 'zz-upstream is unavailable', type: 'server_error' } });
    const error = await captureCompleteError(openai());
    expect(error.httpStatus).toBe(503);
    expect(error.type).toBe('server');
    expect(error.retryable).toBe(true);
  });

  it('keeps a 403 instead of erasing it into unknown', async () => {
    stubHttpFailure(403, {
      error: { message: 'zz-tenant is not permitted to use zz-model-1', code: 'permission_denied' },
    });
    const error = await captureCompleteError(compatible());
    expect(error.httpStatus).toBe(403);
    expect(error.type).toBe('auth');
    expect(error.providerErrorCode).toBe('permission_denied');
  });

  it('keeps a 404 for an unknown model', async () => {
    stubHttpFailure(404, { error: { code: 404, message: 'zz-model-1 is not found', status: 'NOT_FOUND' } });
    const error = await captureCompleteError(gemini());
    expect(error.httpStatus).toBe(404);
    expect(error.retryable).toBe(false);
    expect(error.providerErrorCode).toBe('NOT_FOUND');
  });

  it('keeps a 402 billing failure', async () => {
    stubHttpFailure(402, { error: { message: 'zz-account has no credits', code: 'insufficient_credits' } });
    const error = await captureCompleteError(openrouter());
    expect(error.httpStatus).toBe(402);
    expect(error.retryable).toBe(false);
  });

  it('keeps a 413 and calls it a context-length problem', async () => {
    stubHttpFailure(413, { error: { message: 'zz-request body is too large' } });
    const error = await captureCompleteError(completions());
    expect(error.httpStatus).toBe(413);
    expect(error.type).toBe('context_length');
    expect(error.retryable).toBe(false);
  });

  it('keeps a 422 as a non-retryable invalid request', async () => {
    stubHttpFailure(422, { error: { message: 'zz-field fld1 failed validation', code: 'zz_unprocessable' } });
    const error = await captureCompleteError(responsesApi());
    expect(error.httpStatus).toBe(422);
    expect(error.type).toBe('invalid_request');
    expect(error.retryable).toBe(false);
  });

  it('keeps a bedrock 503', async () => {
    stubHttpFailure(503, { message: 'zz-bedrock is unavailable', __type: 'ServiceUnavailableException' });
    const error = await captureCompleteError(bedrock());
    expect(error.httpStatus).toBe(503);
    expect(error.type).toBe('server');
    expect(error.retryable).toBe(true);
  });
});

describe('retry-after is read from the response headers', () => {
  it('carries a numeric retry-after header through as milliseconds', async () => {
    stubHttpFailure(
      429,
      { error: { message: 'zz-rate limit reached', type: 'rate_limit_error', code: 'rate_limit_exceeded' } },
      { 'retry-after': '37' },
    );
    const error = await captureCompleteError(openai());
    expect(error.httpStatus).toBe(429);
    expect(error.type).toBe('rate_limit');
    expect(error.retryable).toBe(true);
    expect(error.retryAfterMs).toBe(37_000);
    expect(error.providerErrorCode).toBe('rate_limit_exceeded');
  });

  it("reads google's body retryDelay when no header is present", async () => {
    stubHttpFailure(429, {
      error: {
        code: 429,
        message: 'zz-quota exceeded for zz-model-1',
        status: 'RESOURCE_EXHAUSTED',
        details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '21s' }],
      },
    });
    const error = await captureCompleteError(gemini());
    expect(error.retryAfterMs).toBe(21_000);
    expect(error.providerErrorCode).toBe('RESOURCE_EXHAUSTED');
  });
});

describe('the provider error code decides retryability inside 429', () => {
  it('treats insufficient_quota as a non-retryable billing failure', async () => {
    stubHttpFailure(429, {
      error: {
        message: 'You exceeded your current quota for zz-org',
        type: 'insufficient_quota',
        code: 'insufficient_quota',
      },
    });
    const error = await captureCompleteError(openai());
    expect(error.httpStatus).toBe(429);
    expect(error.providerErrorCode).toBe('insufficient_quota');
    expect(error.retryable).toBe(false);
  });

  it('keeps an ordinary 429 retryable', async () => {
    stubHttpFailure(429, { error: { message: 'zz-too many requests', code: 'rate_limit_exceeded' } });
    const error = await captureCompleteError(compatible());
    expect(error.retryable).toBe(true);
  });
});

describe('bodies no longer promote themselves by substring', () => {
  it('does not turn a 400 whose body says "generated" into a retryable 429', async () => {
    stubHttpFailure(400, { error: { message: 'no completion was generated for zz-model-1' } });
    const error = await captureCompleteError(compatible());
    expect(error.httpStatus).toBe(400);
    expect(error.type).toBe('invalid_request');
    expect(error.retryable).toBe(false);
  });

  it('does not turn a 400 saying "moderate" into a rate limit', async () => {
    stubHttpFailure(400, { error: { message: 'zz-parameter fld1 must moderate the sampler' } });
    const error = await captureCompleteError(openrouter());
    expect(error.type).toBe('invalid_request');
    expect(error.retryable).toBe(false);
  });
});

describe('a 5xx is never misread as context_length (MINOR-10)', () => {
  it('openai: a 500 whose body mentions context stays a retryable server error', async () => {
    stubHttpFailure(500, { error: { message: 'Internal error: context processing failed' } });
    const error = await captureCompleteError(openai());
    expect(error.type).toBe('server');
    expect(error.retryable).toBe(true);
    expect(error.httpStatus).toBe(500);
  });

  it('openai-compatible: a 502 mentioning "too long" stays retryable', async () => {
    stubHttpFailure(502, { error: { message: 'zz-gateway took too long to respond' } });
    const error = await captureCompleteError(compatible());
    expect(error.retryable).toBe(true);
  });

  it('openai-completions: a 503 mentioning maximum context stays retryable', async () => {
    stubHttpFailure(503, { error: { message: 'zz-shard restart during maximum context load' } });
    const error = await captureCompleteError(completions());
    expect(error.retryable).toBe(true);
  });

  it('openrouter: a 500 mentioning context stays retryable', async () => {
    stubHttpFailure(500, { error: { message: 'zz-router lost context of the upstream' } });
    const error = await captureCompleteError(openrouter());
    expect(error.retryable).toBe(true);
  });

  it('gemini: a 503 mentioning token limit stays retryable', async () => {
    stubHttpFailure(503, { error: { code: 503, message: 'zz-backend token limit sync failed', status: 'UNAVAILABLE' } });
    const error = await captureCompleteError(gemini());
    expect(error.retryable).toBe(true);
  });

  it('responses-api: a 500 mentioning context stays retryable', async () => {
    stubHttpFailure(500, { error: { message: 'zz-context service unavailable' } });
    const error = await captureCompleteError(responsesApi());
    expect(error.retryable).toBe(true);
  });

  it('bedrock: a 500 whose body merely contains "token" stays retryable', async () => {
    stubHttpFailure(500, { message: 'zz-token service failure', __type: 'InternalServerException' });
    const error = await captureCompleteError(bedrock());
    expect(error.type).toBe('server');
    expect(error.retryable).toBe(true);
  });

  it('a genuine 400 context overflow is still context_length', async () => {
    stubHttpFailure(400, {
      error: {
        message: 'This model supports at most 8192 tokens; your request used 9000',
        code: 'context_length_exceeded',
      },
    });
    const error = await captureCompleteError(openai());
    expect(error.type).toBe('context_length');
    expect(error.retryable).toBe(false);
    expect(error.httpStatus).toBe(400);
  });
});

describe("anthropic's body-type table reaches the caller (MAJOR-1c)", () => {
  function anthropicError(status: number | undefined, body: unknown): MembraneError {
    const adapter = new AnthropicAdapter({ apiKey: 'zz-key-anthropic' });
    return (adapter as unknown as { handleError(error: unknown): MembraneError }).handleError(
      new Anthropic.APIError(status as never, body, undefined, undefined as never),
    );
  }

  it('gives a permission_error its 403 instead of unknown', () => {
    const error = anthropicError(undefined, {
      type: 'error',
      error: { type: 'permission_error', message: 'zz-key may not use zz-model-1' },
    });
    expect(error.httpStatus).toBe(403);
    expect(error.type).toBe('auth');
    expect(error.retryable).toBe(false);
  });

  it('gives a not_found_error its 404', () => {
    const error = anthropicError(undefined, {
      type: 'error',
      error: { type: 'not_found_error', message: 'zz-model-1 not found' },
    });
    expect(error.httpStatus).toBe(404);
  });

  it('gives request_too_large its 413', () => {
    const error = anthropicError(undefined, {
      type: 'error',
      error: { type: 'request_too_large', message: 'zz-request too large' },
    });
    expect(error.httpStatus).toBe(413);
  });

  it('carries the provider error type as providerErrorCode', () => {
    const error = anthropicError(529, {
      type: 'error',
      error: { type: 'overloaded_error', message: 'Overloaded' },
    });
    expect(error.providerErrorCode).toBe('overloaded_error');
    expect(error.httpStatus).toBe(529);
  });
});

describe('isOverloadedError matches a status-shaped 529 only (MINOR-11)', () => {
  it('does not promote a duration that contains the digits', () => {
    expect(
      isOverloadedError({
        type: 'server',
        message: 'API error: 500 upstream timeout after 5290 ms',
        retryable: true,
        httpStatus: 500,
        rawError: undefined,
      }),
    ).toBe(false);
  });

  it('does not promote a request id that contains the digits', () => {
    expect(
      isOverloadedError({
        type: 'server',
        message: 'API error: 500 request id req-98529abc failed',
        retryable: true,
        httpStatus: 500,
        rawError: undefined,
      }),
    ).toBe(false);
  });

  it('still promotes an honest 529', () => {
    expect(isOverloadedError(classifyError(new Error('upstream returned 529')))).toBe(true);
    expect(
      isOverloadedError({
        type: 'server',
        message: 'overloaded',
        retryable: true,
        httpStatus: 529,
        rawError: undefined,
      }),
    ).toBe(true);
  });
});

describe('classifyError stays the last resort for non-HTTP throwables', () => {
  it('does not call an internal TypeError a context_length error', () => {
    const info = classifyError(new TypeError('Cannot read properties of undefined (reading \'maximum\')'));
    expect(info.type).not.toBe('context_length');
  });

  it('does not call a message containing "moderate" a rate limit', () => {
    const info = classifyError(new Error('zz-sampler must moderate the temperature'));
    expect(info.type).not.toBe('rate_limit');
  });

  it('still classifies a genuine network failure', () => {
    expect(classifyError(new Error('ECONNRESET while reading socket')).type).toBe('network');
  });
});
