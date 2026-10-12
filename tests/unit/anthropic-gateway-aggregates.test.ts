import { describe, expect, it } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { MembraneError, statusForProviderCode } from '../../src/types/errors.js';
import type { ProviderRequest } from '../../src/types/index.js';

const wire: ProviderRequest = { model: 'zz-review-model', messages: [{ role: 'user', content: 'go' }], maxTokens: 16 };

// ---------------------------------------------------------------------------
// Vercel AI Gateway aggregates on the Anthropic adapter: main's precedence.
// ---------------------------------------------------------------------------

describe('Anthropic gateway aggregates keep main precedence', () => {
  const adapter = () => new AnthropicAdapter({ apiKey: 'zz-key', cacheKeepalive: { enabled: false } });
  const classify = (error: unknown) => (adapter() as any).handleError(error, wire);
  const marked = 'providerMetadata: modelAttempts trace';
  const apiError = (status: number | undefined, type: string | undefined, message: string, headers: Record<string, string> = {}) =>
    new Anthropic.APIError(status, type === undefined ? { message } : { error: { type, message } }, undefined, new Headers(headers));

  it.each([
    [403, 'permission_error'],
    [404, 'not_found_error'],
    [409, 'zz_gateway_conflict'],
    [413, 'request_too_large'],
    [422, 'zz_gateway_unprocessable'],
  ] as const)('retries a %s / %s aggregate, keeping its evidence', (status, code) => {
    const error = apiError(status, code, marked, { 'retry-after': '7' });
    const got = classify(error);
    expect(got).toBeInstanceOf(MembraneError);
    expect(got).toMatchObject({
      type: 'server', retryable: true, httpStatus: status, providerErrorCode: code, retryAfterMs: 7000, rawRequest: wire,
    });
    // MembraneError stores a serialized copy; the SDK error's text and body survive.
    expect(got.rawError).toMatchObject({ message: error.message, error: error.error });
  });
  it('retries a status-less aggregate whose code implies a non-authoritative status', () => {
    expect(classify(apiError(undefined, 'not_found_error', 'fallbacksAvailable: false'))).toMatchObject({
      type: 'server', retryable: true, httpStatus: 404, providerErrorCode: 'not_found_error',
    });
  });
  it('keeps main fallback status choices for an aggregate', () => {
    expect(classify(apiError(404, 'not_found_error', 'modelAttempts: overloaded'))).toMatchObject({ type: 'server', retryable: true, httpStatus: 529 });
    expect(classify(apiError(undefined, undefined, 'no_providers_available'))).toMatchObject({ type: 'server', retryable: true, httpStatus: 503 });
  });
  it.each([
    ['authentication_error', 'auth', false, 401],
    ['invalid_request_error', 'invalid_request', false, 400],
    ['rate_limit_error', 'rate_limit', true, 429],
  ] as const)('lets a status-less %s body win over gateway metadata', (code, type, retryable, status) => {
    expect(classify(apiError(undefined, code, marked))).toMatchObject({ type, retryable, httpStatus: status, providerErrorCode: code });
  });
  it('reads a code-implied status from own table entries only', () => {
    expect(statusForProviderCode('Rate_Limit_Error')).toBe(429);
    expect(statusForProviderCode('constructor')).toBeUndefined();
    expect(statusForProviderCode(undefined)).toBeUndefined();
  });
  it.each([
    [403, 'permission_error', 'auth'],
    [404, 'not_found_error', 'invalid_request'],
    [409, 'zz_gateway_conflict', 'invalid_request'],
    [413, 'request_too_large', 'context_length'],
    [422, 'zz_gateway_unprocessable', 'invalid_request'],
  ] as const)('classifies %s / %s normally without gateway metadata', (status, code, type) => {
    expect(classify(apiError(status, code, 'plain provider failure'))).toMatchObject({ type, retryable: false, httpStatus: status, providerErrorCode: code });
  });
});

// ---------------------------------------------------------------------------
// A wait read from prose belongs to the guarded reader alone.
// ---------------------------------------------------------------------------

describe('the Anthropic adapter reads no loose prose wait', () => {
  const adapter = () => new AnthropicAdapter({ apiKey: 'zz-key', cacheKeepalive: { enabled: false } });
  const classify = (error: unknown) => (adapter() as any).handleError(error, wire);
  const apiError = (status: number | undefined, type: string, message: string, headers: Record<string, string> = {}) =>
    new Anthropic.APIError(status, { error: { type, message } }, undefined, new Headers(headers));

  it('a 400 saying "do not retry after 3 attempts" states no wait', () => {
    const got = classify(apiError(400, 'invalid_request_error', 'invalid model; do not retry after 3 attempts'));
    expect(got).toMatchObject({ type: 'invalid_request', retryable: false });
    expect(got.retryAfterMs).toBeUndefined();
  });

  it('a mid-stream "retry after 5 minutes" states no wait in seconds', () => {
    const got = classify(apiError(undefined, 'overloaded_error', 'Please retry after 5 minutes.'));
    expect(got).toMatchObject({ retryable: true });
    expect(got.retryAfterMs).toBeUndefined();
  });

  it('a mid-stream retryable error stating its wait in seconds is still read, by the guarded reader (control)', () => {
    expect(classify(apiError(undefined, 'overloaded_error', 'Please retry after 5 seconds.'))).toMatchObject({ retryable: true, retryAfterMs: 5000 });
  });

  it('a retry-after header is still the wait (control)', () => {
    expect(classify(apiError(429, 'rate_limit_error', 'zz slow down', { 'retry-after': '7' }))).toMatchObject({ type: 'rate_limit', retryAfterMs: 7000 });
  });
});
