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
import { MembraneError, extractProviderErrorFields, statedWaitFromHeaders } from '../../src/types/index.js';
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

/** The wait an SSE error frame carrying these fields states. */
function frameWait(fields: Record<string, unknown>): number | undefined {
  try {
    throwOnStreamErrorFrame({ error: { type: 'rate_limit_error', message: 'zz-slow down', ...fields } }, 'zz-provider');
  } catch (error) {
    expect(error).toBeInstanceOf(MembraneError);
    return (error as MembraneError).retryAfterMs;
  }
  throw new Error('expected the frame to throw');
}

/** The wait an error body carrying these fields states. */
const bodyWait = (body: Record<string, unknown>) => extractProviderErrorFields(body).retryAfterMs;

describe('a body and a frame read the same forms of a stated wait', () => {
  it('milliseconds as a number or a numeric string, in snake or camel case', () => {
    for (const fields of [
      { retry_after_ms: 1_500 },
      { retry_after_ms: '1500' },
      { retryAfterMs: 1_500 },
      { retryAfterMs: ' 1500 ' },
      { retry_after_ms: '1499.6' },
    ]) {
      expect(bodyWait({ error: { message: 'zz-slow down', ...fields } }), JSON.stringify(fields)).toBe(1_500);
      expect(bodyWait({ error: { message: 'zz-slow down' }, ...fields }), JSON.stringify(fields)).toBe(1_500);
      expect(frameWait(fields), JSON.stringify(fields)).toBe(1_500);
    }
  });

  it('seconds as a number, a numeric string, or one with an s', () => {
    for (const fields of [{ retry_after: 2.5 }, { retry_after: '2.5' }, { retryAfter: '2.5s' }]) {
      expect(bodyWait({ error: { message: 'zz-slow down', ...fields } }), JSON.stringify(fields)).toBe(2_500);
      expect(frameWait(fields), JSON.stringify(fields)).toBe(2_500);
    }
    expect(frameWait({ retryDelay: '2.5s' })).toBe(2_500);
    expect(bodyWait({ error: { message: 'zz-slow down', details: [{ retryDelay: '2.5s' }] } })).toBe(2_500);
  });

  it('a negative numeric string is over (0), and no later field is read in its place', () => {
    for (const fields of [
      { retry_after_ms: '-1000', retry_after: 120 },
      { retryAfterMs: '-1000', retry_after: 120 },
      { retry_after: '-3' },
      { retryAfter: '-3s' },
    ]) {
      expect(bodyWait({ error: { message: 'zz-slow down', ...fields } }), JSON.stringify(fields)).toBe(0);
      expect(frameWait(fields), JSON.stringify(fields)).toBe(0);
    }
    expect(bodyWait({ error: { message: 'zz-slow down', details: [{ retryDelay: '-3s' }] } })).toBe(0);
  });

  it('a 429 whose body states its wait as a numeric string, or in camel case, waits it out', async () => {
    for (const body of [{ retry_after_ms: '700' }, { retryAfterMs: 700 }]) {
      const sent = network([rateLimited(body), completion]);
      const { membrane, waits } = overCompat();
      await membrane.complete(zzRequest);
      expect(sent.calls(), JSON.stringify(body)).toBe(2);
      expect(waits, JSON.stringify(body)).toEqual([700]);
    }
  });

  it('a date in a body or frame field states nothing: a date is a header form', () => {
    const later = new Date(Date.now() + 60_000).toUTCString();
    const earlier = new Date(Date.now() - 60_000).toUTCString();
    for (const date of [later, earlier]) {
      expect(bodyWait({ error: { message: 'zz-slow down', retry_after: date } }), date).toBeUndefined();
      expect(frameWait({ retry_after: date }), date).toBeUndefined();
    }
    expect(statedWaitFromHeaders(new Headers({ 'retry-after': earlier }))).toBe(0);
  });

  it('a value that is not a finite number, in any form, states nothing and the next field is read', () => {
    for (const unusable of ['Infinity', 'NaN', 'zz-soon', `1${'0'.repeat(400)}`]) {
      expect(bodyWait({ error: { message: 'zz-slow down', retry_after_ms: unusable, retry_after: 2 } }), unusable).toBe(2_000);
      expect(frameWait({ retry_after_ms: unusable, retry_after: 2 }), unusable).toBe(2_000);
    }
  });
});

describe('a seconds value whose milliseconds overflow states nothing', () => {
  it('in a header, a body or a frame; a negative one is still over (0)', () => {
    expect(statedWaitFromHeaders(new Headers({ 'retry-after': `1${'0'.repeat(306)}` }))).toBeUndefined();
    expect(statedWaitFromHeaders(new Headers({ 'retry-after': `-1${'0'.repeat(306)}` }))).toBe(0);
    expect(bodyWait({ error: { message: 'zz-slow down', retry_after: 1e306 } })).toBeUndefined();
    expect(frameWait({ retry_after: 1e306 })).toBeUndefined();
    expect(frameWait({ retry_after: -1e306 })).toBe(0);
    // A finite wait, however long, is still a wait (control).
    expect(statedWaitFromHeaders(new Headers({ 'retry-after': `1${'0'.repeat(300)}` }))).toBe(1e303);
  });
});

describe('a header value is read in the grammar a body or frame field is', () => {
  it('decimal digits, with a sign and a fraction; hex and exponent forms state nothing, as a numeric string does in a body', () => {
    expect(statedWaitFromHeaders(new Headers({ 'retry-after': '2.5' }))).toBe(2500);
    expect(statedWaitFromHeaders(new Headers({ 'retry-after-ms': '1500' }))).toBe(1500);
    expect(statedWaitFromHeaders(new Headers({ 'retry-after': '0x3C' }))).toBeUndefined();
    expect(statedWaitFromHeaders(new Headers({ 'retry-after-ms': '1e3' }))).toBeUndefined();
    expect(bodyWait({ error: { message: 'zz-slow down', retry_after_ms: '1e3' } })).toBeUndefined();
  });

  it('a date is read only in an HTTP-date form, so a rejected number or an ISO date states nothing', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-11-01T00:00:00Z'));
    try {
      for (const value of ['1.', '.5', '+1.', '2026-11-08', '2026-11-08T00:00:00Z']) {
        expect(statedWaitFromHeaders(new Headers({ 'retry-after': value }))).toBeUndefined();
      }
      expect(statedWaitFromHeaders(new Headers({ 'retry-after': 'Sun, 01 Nov 2026 00:01:00 GMT' }))).toBe(60_000);
      expect(statedWaitFromHeaders(new Headers({ 'retry-after': 'Sunday, 01-Nov-26 00:01:00 GMT' }))).toBe(60_000);
      expect(statedWaitFromHeaders(new Headers({ 'retry-after': 'Sun Nov  1 00:01:00 2026' }))).toBe(60_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
