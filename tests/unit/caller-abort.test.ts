import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { BedrockAdapter } from '../../src/providers/bedrock.js';
import { GeminiAdapter } from '../../src/providers/gemini.js';
import { OpenAIAdapter } from '../../src/providers/openai.js';
import { OpenAICompatibleAdapter } from '../../src/providers/openai-compatible.js';
import { OpenAICompletionsAdapter } from '../../src/providers/openai-completions.js';
import { OpenAIResponsesAdapter } from '../../src/providers/openai-responses.js';
import { OpenAIResponsesAPIAdapter } from '../../src/providers/openai-responses-api.js';
import { OpenRouterAdapter } from '../../src/providers/openrouter.js';
import { MembraneError, abortError, authError, networkError, serializeError } from '../../src/types/errors.js';
import { Membrane } from '../../src/membrane.js';
import type { ProviderAdapter, ProviderRequest } from '../../src/types/provider.js';

const request: ProviderRequest = { model: 'zz-model-1', messages: [{ role: 'user', content: 'zz-prompt' }], maxTokens: 16 };

let server: Server;
let base = '';
let onArrival: ((response: ServerResponse) => void) | undefined;
beforeAll(async () => {
  server = createServer((_request, response) => { onArrival?.(response); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const adapters: Array<[string, (url: string) => ProviderAdapter]> = [
  ['anthropic', (url) => new AnthropicAdapter({ apiKey: 'zz-key', baseURL: url, maxRetries: 0 })],
  ['bedrock', (url) => new BedrockAdapter({ baseURL: url, region: 'us-east-1', accessKeyId: 'zz', secretAccessKey: 'zz' })],
  ['gemini', (url) => new GeminiAdapter({ apiKey: 'zz-key', baseURL: `${url}/v1beta` })],
  ['openai', (url) => new OpenAIAdapter({ apiKey: 'zz-key', baseURL: `${url}/v1` })],
  ['openai-compatible', (url) => new OpenAICompatibleAdapter({ apiKey: 'zz-key', baseURL: `${url}/v1` })],
  ['openai-completions', (url) => new OpenAICompletionsAdapter({ apiKey: 'zz-key', baseURL: `${url}/v1` })],
  ['openai-responses', (url) => new OpenAIResponsesAdapter({ apiKey: 'zz-key', baseURL: `${url}/v1` })],
  ['openai-responses-api', (url) => new OpenAIResponsesAPIAdapter({ apiKey: 'zz-key', baseURL: `${url}/v1` })],
  ['openrouter', (url) => new OpenRouterAdapter({ apiKey: 'zz-key', baseURL: `${url}/api/v1` })],
];

const reasons: Array<[string, () => unknown]> = [
  ['a reason coded as a reset', () => Object.assign(new Error('zz caller gave up'), { code: 'ECONNRESET' })],
  ['a reason wrapping a reset as its cause', () => new Error('zz caller gave up', { cause: Object.assign(new Error('zz underneath'), { code: 'ECONNRESET' }) })],
  ['a plain object', () => ({ code: 'ECONNRESET', message: 'zz caller gave up' })],
  ['a string', () => 'zz caller gave up'],
  ['a TimeoutError, as AbortSignal.timeout() gives', () => new DOMException('zz caller timed out', 'TimeoutError')],
  ['no reason, so the platform\'s AbortError', () => undefined],
  ['a membrane error of another type', () => networkError('zz caller gave up')],
];

const timings = ['before the call', 'while the request is out', 'once the response has begun'] as const;

function abortAt(when: (typeof timings)[number], method: 'complete' | 'stream', controller: AbortController, given: unknown): void {
  if (when === 'before the call') controller.abort(given);
  else if (when === 'while the request is out') onArrival = () => controller.abort(given);
  else {
    onArrival = (response) => {
      response.writeHead(200, { 'content-type': method === 'stream' ? 'text/event-stream' : 'application/json' });
      response.flushHeaders();
    };
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await realFetch(input, init);
      controller.abort(given);
      return response;
    });
  }
}

async function rejection(adapter: ProviderAdapter, method: 'complete' | 'stream', signal: AbortSignal, onRequest?: (sent: unknown) => void): Promise<MembraneError> {
  const call = method === 'complete'
    ? adapter.complete(request, { signal, onRequest })
    : adapter.stream(request, { onChunk: () => {} }, { signal, onRequest });
  return call.then(
    () => { throw new Error('expected the call to reject'); },
    (error: unknown) => error as MembraneError,
  );
}

describe("a call its caller's signal ends is an abort, with what was caught as its rawError, whatever the reason", () => {
  for (const [name, make] of adapters) {
    for (const [what, reason] of reasons) {
      for (const when of timings) {
        for (const method of ['complete', 'stream'] as const) {
          it(`${name} ${method}, ${what}, ${when}`, async () => {
            const given = reason();
            const controller = new AbortController();
            abortAt(when, method, controller, given);
            let sent: unknown;
            try {
              const error = await rejection(make(base), method, controller.signal, (built) => { sent = built; });
              expect(error).toBeInstanceOf(MembraneError);
              expect({ type: error.type, retryable: error.retryable, message: error.message })
                .toEqual({ type: 'abort', retryable: false, message: 'Request was aborted' });
              expect(sent).toBeDefined();
              expect(error.rawRequest).toBe(sent);
              // fetch rejects with the signal's reason itself; the Anthropic SDK with its own error, but
              // with the platform's AbortError once it reads a non-streaming response's body.
              if (name !== 'anthropic') expect(error.rawError).toEqual(serializeError(controller.signal.reason));
              else if (method === 'complete' && when === 'once the response has begun') expect(error.rawError).toMatchObject({ name: 'AbortError' });
              else expect(error.rawError).toMatchObject({ name: 'Error', message: 'Request was aborted.' });
            } finally {
              onArrival = undefined;
              vi.unstubAllGlobals();
            }
          }, 10_000);
        }
      }
    }
  }
});

describe("a caller's reason that is already a membrane abort is passed on, carrying the request", () => {
  for (const [name, make] of adapters.filter(([adapterName]) => adapterName !== 'anthropic')) {
    for (const when of timings) {
      for (const method of ['complete', 'stream'] as const) {
        it(`${name} ${method}, ${when}`, async () => {
          const given = abortError('zz superseded');
          const controller = new AbortController();
          abortAt(when, method, controller, given);
          let sent: unknown;
          try {
            const error = await rejection(make(base), method, controller.signal, (built) => { sent = built; });
            expect(error).toBe(given);
            expect(sent).toBeDefined();
            expect(error.rawRequest).toBe(sent);
          } finally {
            onArrival = undefined;
            vi.unstubAllGlobals();
          }
        }, 10_000);
      }
    }
  }
});

describe("the caller's abort wins when a deadline of the call's own fired first", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  function callerAbortsOnDeadline(controller: AbortController, given: unknown): void {
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      if (signal?.aborted) controller.abort(given);
      else signal?.addEventListener('abort', () => controller.abort(given), { once: true });
      return realFetch(input, init);
    });
  }

  for (const [name, make] of adapters) {
    for (const method of ['complete', 'stream'] as const) {
      it(`${name} ${method}, timeoutMs`, async () => {
        const controller = new AbortController();
        callerAbortsOnDeadline(controller, new Error('zz caller gave up'));
        const adapter = make(base);
        const call = method === 'complete'
          ? adapter.complete(request, { signal: controller.signal, timeoutMs: 100 })
          : adapter.stream(request, { onChunk: () => {} }, { signal: controller.signal, timeoutMs: 100 });
        const error = await call.then(() => { throw new Error('expected the call to reject'); }, (caught: unknown) => caught as MembraneError);
        expect({ type: error.type, retryable: error.retryable, message: error.message })
          .toEqual({ type: 'abort', retryable: false, message: 'Request was aborted' });
      }, 10_000);
    }
  }

  it("anthropic stream, its first-event watchdog", async () => {
    const controller = new AbortController();
    callerAbortsOnDeadline(controller, new Error('zz caller gave up'));
    const adapter = new AnthropicAdapter({ apiKey: 'zz-key', baseURL: base, maxRetries: 0 });
    const error = await adapter.stream(request, { onChunk: () => {} }, { signal: controller.signal, firstEventTimeoutMs: 100 })
      .then(() => { throw new Error('expected the call to reject'); }, (caught: unknown) => caught as MembraneError);
    expect({ type: error.type, retryable: error.retryable, message: error.message })
      .toEqual({ type: 'abort', retryable: false, message: 'Request was aborted' });
  }, 10_000);
});

describe("a deadline of the call's own stays a timeout", () => {
  const membraneRequest = { messages: [{ participant: 'user', content: [{ type: 'text' as const, text: 'zz-prompt' }] }], config: { model: 'zz-model-1', maxTokens: 16 } };

  for (const [name, make] of adapters) {
    for (const method of ['complete', 'stream'] as const) {
      it(`${name} ${method}, timeoutMs`, async () => {
        const adapter = make(base);
        const call = method === 'complete'
          ? adapter.complete(request, { timeoutMs: 100 })
          : adapter.stream(request, { onChunk: () => {} }, { timeoutMs: 100 });
        const error = await call.then(() => { throw new Error('expected the call to reject'); }, (caught: unknown) => caught as MembraneError);
        expect(error.type).toBe('timeout');
      }, 10_000);

      it(`${name} ${method}, Membrane's progress deadline`, async () => {
        const membrane = new Membrane(make(base), { retry: { maxRetries: 0 } });
        if (method === 'complete') {
          const error = await membrane.complete(membraneRequest, { progressTimeoutMs: 100 })
            .then(() => { throw new Error('expected the call to reject'); }, (caught: unknown) => caught as MembraneError);
          expect(error.type).toBe('timeout');
        } else {
          expect(await membrane.stream(membraneRequest, { progressTimeoutMs: 100 })).toMatchObject({ aborted: true, reason: 'timeout' });
        }
      }, 10_000);
    }
  }
});

describe("AnthropicAdapter's abort carries the credential failure that ended the request", () => {
  for (const method of ['complete', 'stream'] as const) {
    it(method, async () => {
      const failure = authError('zz login required');
      const controller = new AbortController();
      const adapter = new AnthropicAdapter({
        baseURL: base,
        maxRetries: 0,
        cacheKeepalive: { enabled: false },
        credentials: ({ signal }) => {
          signal?.addEventListener('abort', () => controller.abort(new Error('zz caller gave up')), { once: true });
          throw failure;
        },
      });
      const error = await rejection(adapter, method, controller.signal);
      expect({ type: error.type, retryable: error.retryable, message: error.message })
        .toEqual({ type: 'abort', retryable: false, message: 'Request was aborted' });
      expect(error.rawError).toMatchObject({ message: 'zz login required', type: 'auth' });
    }, 10_000);
  }
});
