/**
 * Regression tests for transient-error classification.
 *
 * overloaded_error (Anthropic 529) most commonly arrives MID-STREAM as an
 * SSE `error` event, which the SDK rethrows as APIError with
 * status === undefined (sdk core/streaming.js). Before the fix, that fell
 * through every status branch in handleError into
 * `unknown, retryable: false` — so framework-level retry policies
 * (exponential backoff) never fired and the inference failed ungracefully.
 */

import { describe, it, expect } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { classifyError, MembraneError } from '../../src/types/errors.js';

function handleError(error: unknown): MembraneError {
  const adapter = new AnthropicAdapter({ apiKey: 'test-key' });
  return (adapter as unknown as {
    handleError(error: unknown, rawRequest?: unknown): MembraneError;
  }).handleError(error);
}

/** Mirror of the SDK's mid-stream throw: APIError with undefined status. */
function sseApiError(body: unknown): Anthropic.APIError {
  return new Anthropic.APIError(undefined as never, body, undefined, undefined as never);
}

describe('Anthropic handleError: mid-stream SSE errors (status === undefined)', () => {
  it('classifies overloaded_error as a retryable server error', () => {
    const err = handleError(sseApiError({
      type: 'error',
      error: { type: 'overloaded_error', message: 'Overloaded' },
    }));
    expect(err.type).toBe('server');
    expect(err.retryable).toBe(true);
    expect(err.httpStatus).toBe(529);
  });

  it('classifies api_error as a retryable server error', () => {
    const err = handleError(sseApiError({
      type: 'error',
      error: { type: 'api_error', message: 'Internal server error' },
    }));
    expect(err.type).toBe('server');
    expect(err.retryable).toBe(true);
    expect(err.httpStatus).toBe(500);
  });

  it('classifies rate_limit_error as retryable rate_limit', () => {
    const err = handleError(sseApiError({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'Rate limited' },
    }));
    expect(err.type).toBe('rate_limit');
    expect(err.retryable).toBe(true);
  });

  it('keeps invalid_request_error non-retryable', () => {
    const err = handleError(sseApiError({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'bad payload' },
    }));
    expect(err.type).toBe('invalid_request');
    expect(err.retryable).toBe(false);
  });

  it('falls back to message matching when the body is an unparsed string', () => {
    const err = handleError(sseApiError('Overloaded'));
    expect(err.type).toBe('server');
    expect(err.retryable).toBe(true);
    expect(err.httpStatus).toBe(529);
  });
});

describe('Anthropic handleError: request-time errors keep their classification', () => {
  it('529 at request time stays a retryable server error', () => {
    const err = handleError(new Anthropic.APIError(
      529 as never,
      { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
      'Overloaded',
      undefined as never,
    ));
    expect(err.type).toBe('server');
    expect(err.retryable).toBe(true);
  });

  it('unknown errors without a recognizable shape remain non-retryable', () => {
    const err = handleError(new Error('something inexplicable'));
    expect(err.type).toBe('unknown');
    expect(err.retryable).toBe(false);
  });
});

describe('classifyError generic fallback', () => {
  it('treats overloaded/529 messages as retryable server errors', () => {
    expect(classifyError(new Error('overloaded_error: try again later'))).toMatchObject({
      type: 'server',
      retryable: true,
    });
    expect(classifyError(new Error('HTTP 529 from upstream'))).toMatchObject({
      type: 'server',
      retryable: true,
    });
  });

  it('does not promote unrelated "overloaded" messages to retryable', () => {
    // The generic fallback matches the exact `overloaded_error` type token,
    // not a bare 'overloaded' — a non-Anthropic capacity message must not be
    // silently reclassified as a retryable server error.
    expect(classifyError(new Error('worker pool overloaded'))).toMatchObject({
      type: 'unknown',
      retryable: false,
    });
  });
});

describe('Anthropic handleError: context-length heuristic gated on HTTP 400 (issue #17)', () => {
  // Context-length is a client-side request-shape problem — it only ever
  // arrives as a 400. Before the guard, any error whose message contained
  // "context" or "too long" (including transient 5xx bodies) became
  // non-retryable context_length, silently suppressing retries.
  it('keeps a 500 whose message mentions "context" a retryable server error', () => {
    const err = handleError(new Anthropic.APIError(
      500 as never,
      { type: 'error', error: { type: 'api_error', message: 'Internal error: context processing failed' } },
      'Internal error: context processing failed',
      undefined as never,
    ));
    expect(err.type).toBe('server');
    expect(err.retryable).toBe(true);
  });

  it('keeps a 529 whose message mentions "too long" a retryable server error', () => {
    const err = handleError(new Anthropic.APIError(
      529 as never,
      { type: 'error', error: { type: 'overloaded_error', message: 'Backend took too long to respond' } },
      'Backend took too long to respond',
      undefined as never,
    ));
    expect(err.type).toBe('server');
    expect(err.retryable).toBe(true);
  });

  it('still classifies a real 400 prompt-too-long as context_length', () => {
    const err = handleError(new Anthropic.APIError(
      400 as never,
      { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 250000 tokens > 200000 maximum' } },
      'prompt is too long: 250000 tokens > 200000 maximum',
      undefined as never,
    ));
    expect(err.type).toBe('context_length');
    expect(err.retryable).toBe(false);
  });

  it('classifies a mid-stream invalid_request_error mentioning "too long" as context_length (status recovered from body type)', () => {
    const err = handleError(sseApiError({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'prompt is too long: 250000 tokens > 200000 maximum' },
    }));
    expect(err.type).toBe('context_length');
    expect(err.retryable).toBe(false);
  });
});

describe('Anthropic handleError: abort classification (fleet incident 2026-07-20)', () => {
  // The SSE idle watchdog aborts a stalled stream via AbortController; the
  // SDK surfaces that as APIUserAbortError ("Request was aborted."), whose
  // .name is NOT 'AbortError'. Before the fix it fell through to
  // `unknown, retryable: false`, and membrane's message-sniffing then
  // relabeled it a *user* abort — terminal, never retried, and reported as
  // "Stream aborted: user" on agents nobody touched (Cairn, 2026-07-20).
  it('classifies the real SDK APIUserAbortError as abort, not unknown', () => {
    const err = handleError(new Anthropic.APIUserAbortError());
    expect(err.type).toBe('abort');
  });

  // The adapter boundary is the last place the laundering could survive, and
  // it survived at exactly one string: a plain Error whose message equalled
  // the SDK's abort text was converted into a cancellation even though
  // nothing about its TYPE said abort. Any caller can produce that string —
  // a tool, a proxy, a wrapped upstream error — and the turn then resolved as
  // a user cancellation with the real error destroyed. It must stay an
  // ordinary unclassified error.
  it('does NOT classify a plain Error carrying the exact SDK abort text as abort', () => {
    const err = handleError(new Error('Request was aborted.'));
    expect(err.type).not.toBe('abort');
    expect(err.type).toBe('unknown');
    expect(err.retryable).toBe(false);
    expect(err.message).toBe('Request was aborted.');
  });

  it('still classifies standard AbortError as abort', () => {
    const e = new Error('The operation was aborted');
    e.name = 'AbortError';
    expect(handleError(e).type).toBe('abort');
  });
});
