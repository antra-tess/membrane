/**
 * Every reader of a provider's stated wait gives it one meaning.
 *
 * A wait below zero, or a date already past, is over: 0, whether it came in
 * a header, an error body or an SSE error frame. So a 429 with
 * `retry_after_ms: -1000` recovers on the backoff, as it did before the
 * in-call rule began ending calls over unusable waits (slimepriestess's
 * review of #102, which found the regression). And `retry-after-ms` is read
 * before `retry-after` at the shared HTTP boundary, as on the Anthropic
 * adapter, so a wait stated only in milliseconds is honored by every adapter.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { OpenAICompatibleAdapter } from '../../src/providers/openai-compatible.js';
import { throwOnStreamErrorFrame } from '../../src/providers/utils.js';
import { MembraneError, statedWaitFromHeaders } from '../../src/types/index.js';
import type { NormalizedRequest } from '../../src/types/index.js';

const zzRequest: NormalizedRequest = {
  messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz-prompt' }] }],
  config: { model: 'zz-model-1', maxTokens: 64 },
};

const completion = () => new Response(JSON.stringify({
  id: 'zz-cmpl', object: 'chat.completion', created: 0, model: 'zz-model-1',
  choices: [{ index: 0, message: { role: 'assistant', content: 'zz-recovered' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
}), { status: 200, headers: { 'content-type': 'application/json' } });

const rateLimited = (body: Record<string, unknown>, headers: Record<string, string> = {}) => () => new Response(
  JSON.stringify({ error: { message: 'zz-slow down', type: 'rate_limit_error' }, ...body }),
  { status: 429, headers: { 'content-type': 'application/json', ...headers } },
);

/** Each attempt is answered by the next entry, the last one repeating. */
function network(script: Array<() => Response>): { calls: () => number } {
  let calls = 0;
  vi.stubGlobal('fetch', vi.fn(async () => {
    calls++;
    return script[Math.min(calls, script.length) - 1]!();
  }));
  return { calls: () => calls };
}

/** A real Membrane over the OpenAI-compatible adapter, its waits recorded instead of taken. */
function overCompat() {
  const membrane = new Membrane(
    new OpenAICompatibleAdapter({ apiKey: 'zz-key', baseURL: 'https://zz-compat.invalid/v1' }),
    { retry: { maxRetries: 3, retryDelayMs: 50, maxRetryDelayMs: 2_000 } },
  );
  const waits: number[] = [];
  (membrane as unknown as { sleep(ms: number): Promise<void> }).sleep = async (ms: number) => { waits.push(ms); };
  return { membrane, waits };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a negative stated wait is over, wherever it is read', () => {
  it('a 429 whose body says retry_after_ms: -1000 recovers on the backoff', async () => {
    const sent = network([rateLimited({ retry_after_ms: -1_000 }), completion]);
    const { membrane, waits } = overCompat();
    const response = await membrane.complete(zzRequest);
    expect(response.content[0]).toMatchObject({ type: 'text', text: 'zz-recovered' });
    expect(sent.calls()).toBe(2);
    expect(waits).toEqual([50]);
  });

  it('an error body stating a negative wait, in milliseconds or seconds, reads as 0', async () => {
    const adapter = new OpenAICompatibleAdapter({ apiKey: 'zz-key', baseURL: 'https://zz-compat.invalid/v1' });
    const request = { model: 'zz-model-1', messages: [{ role: 'user', content: 'zz-prompt' }], maxTokens: 16 };
    for (const body of [{ retry_after_ms: -1_000 }, { retry_after: -3 }]) {
      network([rateLimited(body)]);
      const error = await adapter.complete(request).then(() => undefined, (e: MembraneError) => e);
      expect(error, JSON.stringify(body)).toBeInstanceOf(MembraneError);
      expect(error, JSON.stringify(body)).toMatchObject({ type: 'rate_limit', httpStatus: 429, retryAfterMs: 0 });
    }
  });

  it('an SSE error frame with a negative retry_after_ms carries a wait of 0', () => {
    const thrown = (() => {
      try {
        throwOnStreamErrorFrame({ error: { type: 'rate_limit_error', message: 'zz-slow down', retry_after_ms: -1_000 } }, 'zz-provider');
      } catch (error) {
        return error as MembraneError;
      }
      return undefined;
    })();
    expect(thrown).toBeInstanceOf(MembraneError);
    expect(thrown).toMatchObject({ type: 'rate_limit', retryAfterMs: 0 });
  });

  it('an SSE error frame with a negative retry_after in seconds carries a wait of 0', () => {
    const thrown = (() => {
      try {
        throwOnStreamErrorFrame({ error: { type: 'rate_limit_error', message: 'zz-slow down', retry_after: -5 } }, 'zz-provider');
      } catch (error) {
        return error as MembraneError;
      }
      return undefined;
    })();
    expect(thrown).toBeInstanceOf(MembraneError);
    expect(thrown).toMatchObject({ type: 'rate_limit', retryAfterMs: 0 });
  });

  it('a negative retry-after header, in seconds or milliseconds, reads as 0', () => {
    expect(statedWaitFromHeaders(new Headers({ 'retry-after': '-5' }))).toBe(0);
    expect(statedWaitFromHeaders(new Headers({ 'retry-after-ms': '-5', 'retry-after': '120' }))).toBe(0);
    expect(statedWaitFromHeaders(new Headers({ 'retry-after': new Date(Date.now() - 60_000).toUTCString() }))).toBe(0);
  });
});

describe('retry-after-ms at the shared HTTP boundary', () => {
  it('is read before retry-after, in whole milliseconds', () => {
    expect(statedWaitFromHeaders(new Headers({ 'retry-after-ms': '700' }))).toBe(700);
    expect(statedWaitFromHeaders(new Headers({ 'retry-after-ms': '700.6', 'retry-after': '120' }))).toBe(701);
    expect(statedWaitFromHeaders(new Headers({ 'retry-after-ms': 'zz-soon', 'retry-after': '2' }))).toBe(2_000);
    expect(statedWaitFromHeaders(new Headers({}))).toBeUndefined();
  });

  it('a fetch adapter waits out a wait stated only in retry-after-ms', async () => {
    const sent = network([rateLimited({}, { 'retry-after-ms': '700' }), completion]);
    const { membrane, waits } = overCompat();
    await membrane.complete(zzRequest);
    expect(sent.calls()).toBe(2);
    expect(waits).toEqual([700]);
  });

  it('a fetch adapter ends the call over a retry-after-ms beyond the budget, the wait intact', async () => {
    const sent = network([rateLimited({}, { 'retry-after-ms': '120000' }), completion]);
    const { membrane, waits } = overCompat();
    const error = await membrane.complete(zzRequest).then(() => undefined, (e: MembraneError) => e);
    expect(error).toMatchObject({ type: 'rate_limit', retryAfterMs: 120_000 });
    expect(sent.calls()).toBe(1);
    expect(waits).toEqual([]);
  });
});
