import { afterEach, describe, expect, it, vi } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { OpenAIAdapter } from '../../src/providers/openai.js';
import { isOverloadedError } from '../../src/types/errors.js';
import type { NormalizedRequest } from '../../src/types/index.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const request: NormalizedRequest = {
  config: { model: 'zz-review-model', maxTokens: 16 }, toolMode: 'native',
  messages: [{ participant: 'User', content: [{ type: 'text', text: 'go' }] }],
};
function sse(frames: unknown[]) {
  return new Response(frames.map(frame => 'data: ' + (typeof frame === 'string' ? frame : JSON.stringify(frame)) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } });
}

// ---------------------------------------------------------------------------
// The overload schedule is chosen by a known status; prose decides only when
// no status exists.
// ---------------------------------------------------------------------------

describe('overload policy reads a known status before prose', () => {
  const prose = 'upstream returned 529 overloaded_error';
  it.each([
    ['explicit 529', { httpStatus: 529, message: 'capacity' }, true],
    ['explicit 429 with overload prose', { httpStatus: 429, message: prose }, false],
    ['explicit 503 with overload prose', { httpStatus: 503, message: prose }, false],
    ['status-less overload prose', { httpStatus: undefined, message: prose }, true],
    ['status-less digits inside another number', { httpStatus: undefined, message: 'timeout after 5290 ms' }, false],
  ] as const)('%s', (_label, fields, expected) => {
    expect(isOverloadedError({ type: 'server', retryable: true, ...fields })).toBe(expected);
  });
  it('never treats a terminal error as an overload', () => {
    expect(isOverloadedError({ type: 'server', retryable: false, httpStatus: 529, message: 'capacity' })).toBe(false);
  });

  // Base schedule waits 1ms; the overload schedule waits 50..100ms. Recording
  // the waits shows which schedule an actual public retry chose.
  function membrane(status: number) {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: { body: string }) => {
      if (++calls === 1) {
        return new Response(JSON.stringify({ error: { code: status === 429 ? 'rate_limit_exceeded' : 'server_error', message: prose } }), { status });
      }
      return JSON.parse(init.body).stream
        ? sse([{ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }, '[DONE]'])
        : new Response(JSON.stringify({ choices: [{ message: { content: 'done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    }));
    const instance = new Membrane(new OpenAIAdapter({ apiKey: 'zz-key' }), {
      formatter: new NativeFormatter(),
      retry: { maxRetries: 0, retryDelayMs: 1, overloaded: { retryDelayMs: 100, maxRetryDelayMs: 100, backoffMultiplier: 1 } },
    });
    const waits: number[] = [];
    (instance as any).sleep = async (ms: number) => { waits.push(ms); };
    return { instance, waits, calls: () => calls };
  }
  it('complete keeps an explicit 429 on the rate-limit schedule despite overload prose', async () => {
    const { instance, waits, calls } = membrane(429);
    await instance.complete(request);
    expect(calls()).toBe(2);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeLessThan(50);
  });
  it('callback stream keeps an explicit 429 on the rate-limit schedule despite overload prose', async () => {
    const { instance, waits, calls } = membrane(429);
    await instance.stream(request);
    expect(calls()).toBe(2);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeLessThan(50);
  });
  it('complete gives an explicit 503 no overload allowance from prose', async () => {
    const { instance, waits, calls } = membrane(503);
    await expect(instance.complete(request)).rejects.toMatchObject({ type: 'server', retryable: true, httpStatus: 503 });
    expect(calls()).toBe(1);
    expect(waits).toEqual([]);
  });
  it('callback stream gives an explicit 503 no overload allowance from prose', async () => {
    const { instance, calls } = membrane(503);
    await expect(instance.stream(request)).rejects.toMatchObject({ type: 'server', retryable: true, httpStatus: 503 });
    expect(calls()).toBe(1);
  });
});
