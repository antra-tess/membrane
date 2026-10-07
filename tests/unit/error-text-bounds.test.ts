/**
 * Bounded provider-derived error text, at the boundaries and consumers.
 *
 * A provider's error body is arbitrary remote text, and some providers echo
 * the entire rejected request in it (an OpenAI-compatible 400 returned a
 * ~1.7 MB body). Before the bound, that text became the MembraneError's
 * message, its stack and its rawError, and from there every log line, hook
 * payload and agent-facing failure notice built from the error.
 *
 * This file uses only long-standing exports, so it runs unchanged on the
 * commit before the bound: the bound assertions fail there, and the
 * classification and consumer comparisons are controls that must hold both
 * before and after. Each case drives the same failure twice, with a small
 * body and with a ~1 MB echo, and requires every decision to match:
 *   - each boundary that builds errors from remote text (HTTP bodies on the
 *     fetch adapters, an SDK APIError, Bedrock, an SSE error frame);
 *   - the consumers that read an error after construction (the retry loop,
 *     the overload schedule and the stream abort disposition).
 * The bound's own unit tests are in error-text-bound-helpers.test.ts.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { Membrane } from '../../src/membrane.js';
import { isAbortedResponse } from '../../src/types/response.js';
import { OpenAICompatibleAdapter } from '../../src/providers/openai-compatible.js';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { BedrockAdapter } from '../../src/providers/bedrock.js';
import { MembraneError } from '../../src/types/errors.js';
import type { NormalizedRequest } from '../../src/types/index.js';
import type { ProviderRequest } from '../../src/types/provider.js';
import { sseResponse } from '../helpers/sse-fixtures.js';

// The documented bounds (src/types/errors.ts), restated so this file does not
// depend on the new exports.
const MAX_ERROR_MESSAGE_CHARS = 2_000;
const MAX_RAW_ERROR_JSON_BYTES = 16 * 1024;
/** Length of the omission marker the bound inserts, at these sizes. */
const MARKER_ALLOWANCE = 64;
/** A bounded stack: the bounded message plus a modest frame list. */
const STACK_ALLOWANCE = MAX_ERROR_MESSAGE_CHARS + MARKER_ALLOWANCE + 8_000;

const echo = (n: number, word = '') => `${'zz-echo '.repeat(Math.ceil(n / 16))}${word}${'zz-echo '.repeat(Math.ceil(n / 16))}`;
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The boundaries that build errors from remote text
// ---------------------------------------------------------------------------

const providerRequest: ProviderRequest = {
  model: 'zz-model-1',
  messages: [{ role: 'user', content: 'zz-prompt' }],
  maxTokens: 16,
};

/** The three body shapes an echoing provider produces. */
const echoShapes = {
  'JSON body, echo beside error.message': (echoed: string) => ({
    text: JSON.stringify({ error: { message: 'Image inputs are not supported for this model', type: 'invalid_request_error' }, request: { text: echoed } }),
    type: 'application/json',
    code: 'invalid_request_error',
  }),
  'JSON body, echo inside error.message': (echoed: string) => ({
    text: JSON.stringify({ error: { message: `Image inputs are not supported for this model. Request: ${echoed}`, type: 'invalid_request_error' } }),
    type: 'application/json',
    code: 'invalid_request_error',
  }),
  'text body, echo inline': (echoed: string) => ({
    text: `Bad Request: image inputs are not supported. Request was: ${echoed}`,
    type: 'text/plain',
    code: undefined,
  }),
} as const;

function stubEcho(status: number, make: (echoed: string) => { text: string; type: string }, echoed: string) {
  const fetchMock = vi.fn(async () => {
    const { text, type } = make(echoed);
    return new Response(text, { status, headers: { 'content-type': type } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function expectBounded(error: MembraneError) {
  expect(error.message.length).toBeLessThanOrEqual(MAX_ERROR_MESSAGE_CHARS);
  expect((error.stack ?? '').length).toBeLessThanOrEqual(STACK_ALLOWANCE);
  expect(Buffer.byteLength(JSON.stringify(error.rawError ?? null), 'utf8')).toBeLessThanOrEqual(MAX_RAW_ERROR_JSON_BYTES);
}

describe('fetch boundary: an echoing 400 on openai-compatible', () => {
  const adapter = () => new OpenAICompatibleAdapter({ apiKey: 'zz-key', baseURL: 'https://zz-compat.invalid/v1' });

  for (const [shape, make] of Object.entries(echoShapes)) {
    for (const method of ['complete', 'stream'] as const) {
      it(`${shape} (${method}): bounded, classified as for a small body`, async () => {
        const call = async (echoed: string) => {
          stubEcho(400, make, echoed);
          try {
            if (method === 'complete') await adapter().complete(providerRequest);
            else await adapter().stream(providerRequest, { onChunk: () => {} });
          } catch (error) {
            expect(error).toBeInstanceOf(MembraneError);
            return error as MembraneError;
          }
          throw new Error('expected a rejection');
        };
        const small = await call('zz-small-echo');
        const large = await call(echo(1_000_000));
        expectBounded(large);
        for (const field of ['type', 'retryable', 'httpStatus', 'providerErrorCode', 'retryAfterMs'] as const) {
          expect(large[field]).toEqual(small[field]);
        }
        expect(large.type).toBe('invalid_request');
        expect(large.httpStatus).toBe(400);
        expect(large.providerErrorCode).toEqual(make('').code);
      });
    }
  }

  it('summarizes the raw body so an identical body is recognizable by sha256', async () => {
    const echoed = echo(1_000_000);
    stubEcho(400, echoShapes['JSON body, echo beside error.message'], echoed);
    const error = await adapter().complete(providerRequest).then(
      () => { throw new Error('expected a rejection'); },
      (e: MembraneError) => e,
    );
    const bodyText = echoShapes['JSON body, echo beside error.message'](echoed).text;
    expect(error.rawError).toMatchObject({ truncated: true, bytes: Buffer.byteLength(bodyText, 'utf8'), sha256: sha256(bodyText) });
    expect(error.message).toContain('Image inputs are not supported for this model');
  });
});

describe('other boundaries that carry remote text', () => {
  it('an Anthropic SDK APIError with a huge body', () => {
    const adapter = new AnthropicAdapter({ apiKey: 'zz-key-anthropic' });
    const handle = (body: unknown) => (adapter as unknown as { handleError(e: unknown): MembraneError })
      .handleError(new Anthropic.APIError(400, body, undefined, undefined as never));
    const small = handle({ type: 'error', error: { type: 'invalid_request_error', message: 'zz-short' } });
    const large = handle({ type: 'error', error: { type: 'invalid_request_error', message: echo(1_000_000) } });
    expectBounded(large);
    expect([large.type, large.retryable, large.httpStatus, large.providerErrorCode])
      .toEqual([small.type, small.retryable, small.httpStatus, small.providerErrorCode]);
  });

  it('a Bedrock 400 with a huge body', async () => {
    const adapter = new BedrockAdapter({ accessKeyId: 'zz-access-key', secretAccessKey: 'zz-secret-key', region: 'zz-region-1' });
    const call = async (message: string) => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(
        JSON.stringify({ message, __type: 'ValidationException' }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      )));
      return adapter.complete(providerRequest).then(
        () => { throw new Error('expected a rejection'); },
        (e: MembraneError) => e,
      );
    };
    const small = await call('zz-short');
    const large = await call(echo(1_000_000));
    expectBounded(large);
    expect([large.type, large.retryable, large.httpStatus, large.providerErrorCode])
      .toEqual([small.type, small.retryable, small.httpStatus, small.providerErrorCode]);
  });

  it('an SSE error frame with a huge message', async () => {
    const adapter = new OpenAICompatibleAdapter({ apiKey: 'zz-key', baseURL: 'https://zz-compat.invalid/v1' });
    const call = async (message: string) => {
      vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
        JSON.stringify({ error: { message, code: 400, type: 'invalid_request_error' } }),
      ])));
      return adapter.stream(providerRequest, { onChunk: () => {} }).then(
        () => { throw new Error('expected a rejection'); },
        (e: MembraneError) => e,
      );
    };
    const small = await call('zz-short');
    const large = await call(echo(1_000_000));
    expectBounded(large);
    expect([large.type, large.retryable, large.httpStatus, large.providerErrorCode])
      .toEqual([small.type, small.retryable, small.httpStatus, small.providerErrorCode]);
  });
});

// ---------------------------------------------------------------------------
// The consumers that read an error after construction
// ---------------------------------------------------------------------------

const request: NormalizedRequest = {
  messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz-prompt' }] }],
  config: { model: 'zz-model-1', maxTokens: 16 },
};

interface Observed {
  httpCalls: number;
  delaysMs: number[];
  outcome: string;
  type?: string;
  retryable?: boolean;
  httpStatus?: number;
}

/**
 * Drive one failure through the real Membrane over openai-compatible and
 * report what the consumers decided: how many HTTP calls, which waits, and
 * whether complete/stream rejected or returned an aborted response.
 */
async function observe(
  method: 'complete' | 'stream',
  status: number,
  bodyFor: (echoed: string) => string,
  echoed: string,
  headers: Record<string, string> = {},
): Promise<Observed> {
  let httpCalls = 0;
  vi.stubGlobal('fetch', vi.fn(async () => {
    httpCalls++;
    return new Response(bodyFor(echoed), { status, headers: { 'content-type': 'application/json', ...headers } });
  }));
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  const membrane = new Membrane(new OpenAICompatibleAdapter({ apiKey: 'zz-key', baseURL: 'https://zz-compat.invalid/v1' }));
  const delaysMs: number[] = [];
  (membrane as unknown as { sleep(ms: number): Promise<void> }).sleep = async (ms: number) => { delaysMs.push(ms); };
  try {
    const result = method === 'complete'
      ? await membrane.complete(request)
      : await membrane.stream(request, {});
    return { httpCalls, delaysMs, outcome: isAbortedResponse(result) ? 'aborted-response' : 'resolved' };
  } catch (error) {
    const e = error as MembraneError;
    return { httpCalls, delaysMs, outcome: 'rejected', type: e.type, retryable: e.retryable, httpStatus: e.httpStatus };
  }
}

const echoBody = (echoed: string) => JSON.stringify({ error: { message: `Bad request. Request: ${echoed}`, type: 'invalid_request_error' } });
const overloadBody = (echoed: string) => JSON.stringify({ error: { message: `Overloaded while handling: ${echoed}`, type: 'overloaded_error' } });
const rateBody = (echoed: string) => JSON.stringify({ error: { message: `Slow down. Request: ${echoed}`, type: 'rate_limit_error' } });

describe('consumers decide as they do for the same failure with a small body', () => {
  for (const word of ['generate a separate rate limit', '1290385291234529 overloaded_error', 'abort the mission', 'request was aborted']) {
    for (const method of ['complete', 'stream'] as const) {
      it(`a 400 echoing "${word}" mid-body (${method}): one call, rejected, no retry or abort`, async () => {
        const small = await observe(method, 400, echoBody, word);
        const large = await observe(method, 400, echoBody, `${echo(500_000)}${word}${echo(500_000)}`);
        expect(large).toEqual(small);
        expect(large).toMatchObject({ httpCalls: 1, outcome: 'rejected', type: 'invalid_request', retryable: false, httpStatus: 400 });
      });
    }
  }

  it('a 529 with a huge body keeps the overload schedule chosen by its status', async () => {
    const small = await observe('complete', 529, overloadBody, 'zz-small');
    const large = await observe('complete', 529, overloadBody, echo(1_000_000));
    expect(large).toEqual(small);
    expect(large.httpCalls).toBeGreaterThan(1);
  });

  it('a 429 with a huge body and retry-after keeps its retry policy', async () => {
    const small = await observe('complete', 429, rateBody, 'zz-small', { 'retry-after': '2' });
    const large = await observe('complete', 429, rateBody, echo(1_000_000), { 'retry-after': '2' });
    expect(large).toEqual(small);
    expect(large.httpCalls).toBe(5);
    expect(large.delaysMs.every((ms) => ms >= 2_000)).toBe(true);
  });
});
