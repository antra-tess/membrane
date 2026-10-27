import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
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
import { MembraneError, abortError, serializeError } from '../../src/types/errors.js';
import type { ProviderAdapter, ProviderRequest } from '../../src/types/provider.js';

const request: ProviderRequest = { model: 'zz-model-1', messages: [{ role: 'user', content: 'zz-prompt' }], maxTokens: 16 };

let server: Server;
let base = '';
let onArrival: (() => void) | undefined;
beforeAll(async () => {
  server = createServer(() => { onArrival?.(); });
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
  ['a string', () => 'zz caller gave up'],
  ['a TimeoutError, as AbortSignal.timeout() gives', () => new DOMException('zz caller timed out', 'TimeoutError')],
  ['no reason, so the platform\'s AbortError', () => undefined],
];

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
      for (const when of ['before the call', 'while the request is out'] as const) {
        for (const method of ['complete', 'stream'] as const) {
          it(`${name} ${method}, ${what}, ${when}`, async () => {
            const given = reason();
            const controller = new AbortController();
            if (when === 'before the call') controller.abort(given);
            else onArrival = () => controller.abort(given);
            let sent: unknown;
            try {
              const error = await rejection(make(base), method, controller.signal, (built) => { sent = built; });
              expect(error).toBeInstanceOf(MembraneError);
              expect({ type: error.type, retryable: error.retryable, message: error.message })
                .toEqual({ type: 'abort', retryable: false, message: 'Request was aborted' });
              expect(sent).toBeDefined();
              expect(error.rawRequest).toBe(sent);
              // fetch rejects with the signal's reason itself; the Anthropic SDK with its own error.
              if (name !== 'anthropic') expect(error.rawError).toEqual(serializeError(controller.signal.reason));
              else expect(error.rawError).toMatchObject({ name: 'Error', message: 'Request was aborted.' });
            } finally {
              onArrival = undefined;
            }
          }, 10_000);
        }
      }
    }
  }
});

describe('a reason that is already an abort membrane typed is kept', () => {
  for (const [name, make] of adapters.filter(([adapterName]) => adapterName !== 'anthropic')) {
    it(name, async () => {
      const controller = new AbortController();
      controller.abort(abortError('zz superseded'));
      const error = await rejection(make(base), 'complete', controller.signal);
      expect({ type: error.type, retryable: error.retryable, message: error.message })
        .toEqual({ type: 'abort', retryable: false, message: 'zz superseded' });
    });
  }
});
