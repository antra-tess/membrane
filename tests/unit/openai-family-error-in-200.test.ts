/**
 * OpenRouter documents two failures inside an HTTP 200: a generation that
 * failed partway carries its `error` object on the choice, beside
 * finish_reason "error" and the partial content; and a body that is only an
 * `error` object.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { OpenAIAdapter } from '../../src/providers/openai.js';
import { OpenAICompatibleAdapter } from '../../src/providers/openai-compatible.js';
import { OpenAICompletionsAdapter } from '../../src/providers/openai-completions.js';
import { OpenRouterAdapter } from '../../src/providers/openrouter.js';
import { MembraneError } from '../../src/types/errors.js';
import type { ProviderAdapter } from '../../src/types/index.js';
import { stubFetchWithSseLines } from '../helpers/sse-fixtures.js';

afterEach(() => vi.unstubAllGlobals());

const ADAPTERS: Array<{ label: string; completions: boolean; make: () => ProviderAdapter }> = [
  { label: 'OpenRouter', completions: false, make: () => new OpenRouterAdapter({ apiKey: 'zz-key' }) },
  { label: 'OpenAI', completions: false, make: () => new OpenAIAdapter({ apiKey: 'zz-key' }) },
  {
    label: 'openai-compatible',
    completions: false,
    make: () => new OpenAICompatibleAdapter({ baseURL: 'http://localhost:9/v1', apiKey: 'zz-key' }),
  },
  {
    label: 'openai-completions',
    completions: true,
    make: () => new OpenAICompletionsAdapter({ baseURL: 'http://localhost:9/v1', eotToken: null, warnOnImageStrip: false }),
  },
];

const request = { model: 'zz/model-1', maxTokens: 64, messages: [{ role: 'user', content: 'zz prompt' }] };

function stubFetchWithJson(body: unknown): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
  ));
}

async function rejection(promise: Promise<unknown>): Promise<MembraneError> {
  const outcome = await promise.then(
    (value) => ({ settled: 'resolved' as const, value }),
    (error: unknown) => ({ settled: 'rejected' as const, error }),
  );
  if (outcome.settled === 'resolved') {
    throw new Error(`expected a rejection, got ${JSON.stringify(outcome.value)}`);
  }
  expect(outcome.error).toBeInstanceOf(MembraneError);
  return outcome.error as MembraneError;
}

describe("OpenRouter's documented failures are classified by their error object", () => {
  it('streamed: an error object at the top level of the last chunk', async () => {
    stubFetchWithSseLines([
      JSON.stringify({ choices: [{ index: 0, delta: { content: 'A summ' }, finish_reason: null }] }),
      JSON.stringify({
        error: { code: 429, message: 'zz upstream rate-limited' },
        choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }],
      }),
    ]);
    const error = await rejection(new OpenRouterAdapter({ apiKey: 'zz-key' }).stream(request as any, { onChunk: () => {} } as any));
    expect(error.type).toBe('rate_limit');
    expect(error.httpStatus).toBe(429);
  });

  it('not streamed: an error object on the choice, beside the partial content', async () => {
    const body = {
      id: 'zz-gen',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'partial output...' },
        finish_reason: 'error',
        error: { code: 502, message: 'Provider disconnected mid-stream', metadata: { error_type: 'provider_unavailable' } },
      }],
    };
    stubFetchWithJson(body);
    const error = await rejection(new OpenRouterAdapter({ apiKey: 'zz-key' }).complete(request as any));
    expect(error.type).toBe('server');
    expect(error.retryable).toBe(true);
    expect(error.httpStatus).toBe(502);
    expect(error.message).toBe('OpenRouter response error (502): Provider disconnected mid-stream');
    expect(error.rawError).toEqual(body);
  });

  it('not streamed: an error object fails the call whatever the finish reason, at the top level or on the choice', async () => {
    const object = { code: 502, message: 'zz upstream failed' };
    const message = { role: 'assistant', content: 'A complete-looking answer.' };
    for (const body of [
      { id: 'zz-gen', error: object, choices: [{ index: 0, message, finish_reason: 'stop' }] },
      { id: 'zz-gen', choices: [{ index: 0, message, finish_reason: 'stop', error: object }] },
    ]) {
      stubFetchWithJson(body);
      const error = await rejection(new OpenRouterAdapter({ apiKey: 'zz-key' }).complete(request as any));
      expect(error.httpStatus).toBe(502);
      expect(error.message).toBe('OpenRouter response error (502): zz upstream failed');
    }
  });

  it('streamed: an error object on the choice fails the call, whatever the finish reason', async () => {
    stubFetchWithSseLines([
      JSON.stringify({ choices: [{ index: 0, delta: { content: 'A summ' }, finish_reason: null }] }),
      JSON.stringify({ choices: [{ index: 0, delta: { content: 'ary' }, finish_reason: null, error: { code: 502, message: 'zz upstream failed' } }] }),
    ]);
    const error = await rejection(new OpenRouterAdapter({ apiKey: 'zz-key' }).stream(request as any, { onChunk: () => {} } as any));
    expect(error.httpStatus).toBe(502);
    expect(error.message).toBe('OpenRouter stream error (502): zz upstream failed');
  });

  it('not streamed: an error object on the choice is read as the same object at the top level is', async () => {
    const objects = [
      { code: 'server_error', message: 'Provider disconnected unexpectedly' },
      { code: 400, message: "This model's maximum context length is 128000 tokens." },
      { message: "This model's maximum context length is 128000 tokens." },
    ];
    const read = async (body: unknown) => {
      stubFetchWithJson(body);
      const { type, retryable, httpStatus, providerErrorCode, message } =
        await rejection(new OpenRouterAdapter({ apiKey: 'zz-key' }).complete(request as any));
      return { type, retryable, httpStatus, providerErrorCode, message };
    };
    for (const object of objects) {
      const atTop = await read({ id: 'zz-gen', error: object });
      const onChoice = await read({
        id: 'zz-gen',
        choices: [{ index: 0, message: { role: 'assistant', content: 'partial output...' }, finish_reason: 'error', error: object }],
      });
      expect(onChoice).toEqual(atTop);
    }
  });
});

describe.each(ADAPTERS)('$label: a provider error inside a 200', ({ label, completions, make }) => {
  const streamedChoice = (text: string, finish: string | null) =>
    completions ? { index: 0, text, finish_reason: finish } : { index: 0, delta: { content: text }, finish_reason: finish };

  it('streamed: finish_reason "error" with no error object throws a retryable server error', async () => {
    stubFetchWithSseLines([
      JSON.stringify({ choices: [streamedChoice('A summ', null)] }),
      JSON.stringify({ choices: [streamedChoice('', 'error')] }),
      '[DONE]',
    ]);
    const chunks: string[] = [];
    const error = await rejection(make().stream(request as any, { onChunk: (c: string) => chunks.push(c) } as any));
    expect(error.type).toBe('server');
    expect(error.retryable).toBe(true);
    // As the documented server_error frame gets from its code.
    expect(error.httpStatus).toBe(500);
    expect(error.message).toMatch(new RegExp(`^${label} stream error: .*finish_reason "error"`));
    expect(chunks).toEqual(['A summ']);
  });

  it('not streamed: finish_reason "error" with no error object throws a retryable server error', async () => {
    stubFetchWithJson({
      id: 'zz-gen',
      choices: [completions
        ? { index: 0, text: 'A summ', finish_reason: 'error' }
        : { index: 0, message: { role: 'assistant', content: 'A summ' }, finish_reason: 'error' }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });
    const error = await rejection(make().complete(request as any));
    expect(error.type).toBe('server');
    expect(error.retryable).toBe(true);
    expect(error.httpStatus).toBe(500);
    expect(error.message).toMatch(new RegExp(`^${label} response error: .*finish_reason "error"`));
  });

  it('not streamed: a body that is only an error object throws the provider error it holds', async () => {
    stubFetchWithJson({ id: 'zz-gen', error: { code: 'server_error', message: 'Provider disconnected unexpectedly' } });
    const error = await rejection(make().complete(request as any));
    expect(error.type).toBe('server');
    expect(error.retryable).toBe(true);
    expect(error.httpStatus).toBe(500);
    expect(error.message).toBe(`${label} response error [server_error]: Provider disconnected unexpectedly`);
  });
});
