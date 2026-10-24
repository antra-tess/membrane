/**
 * An attempt record observes; it never changes what's sent. With
 * `onAttempt` set, Membrane core passes each adapter `onSend`, and an
 * `onProgress` that observes, where without it core passes none, or the
 * progress deadline's own renew. So for every built-in adapter, on
 * `complete()`, `stream()` and `streamYielding()`, with no progress deadline
 * and with one (and a purpose and a requestId), the request each one puts on
 * the wire is captured at `fetch` with and without `onAttempt`, and they must
 * be the same bytes: URL, method, headers and body.
 * (Bedrock signs each request with the time, so the clock is held still and
 * its signature is compared with the rest.)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { CompletionsFormatter } from '../../src/formatters/completions.js';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { BedrockAdapter } from '../../src/providers/bedrock.js';
import { GeminiAdapter } from '../../src/providers/gemini.js';
import { OpenAIAdapter } from '../../src/providers/openai.js';
import { OpenAICompatibleAdapter } from '../../src/providers/openai-compatible.js';
import { OpenAICompletionsAdapter } from '../../src/providers/openai-completions.js';
import { OpenAIResponsesAdapter } from '../../src/providers/openai-responses.js';
import { OpenAIResponsesAPIAdapter } from '../../src/providers/openai-responses-api.js';
import { OpenRouterAdapter } from '../../src/providers/openrouter.js';
import type { AttemptRecord, NormalizedRequest, ProviderAdapter } from '../../src/types/index.js';
import type { PrefillFormatter } from '../../src/formatters/types.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

interface Wire { url: string; method: string; headers: Record<string, string>; body: string }

async function capture(input: unknown, init: RequestInit | undefined): Promise<Wire> {
  const request = new Request(input as RequestInfo, init);
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => { headers[key] = value; });
  return { url: request.url, method: request.method, headers, body: await request.text() };
}

const ADAPTERS: Array<[string, () => ProviderAdapter, string, () => PrefillFormatter]> = [
  ['anthropic', () => new AnthropicAdapter({ apiKey: 'zz-key', cacheKeepalive: { enabled: false } }), 'claude-sonnet-4-5', () => new NativeFormatter()],
  ['bedrock', () => new BedrockAdapter({ accessKeyId: 'zz-key-id', secretAccessKey: 'zz-secret', region: 'us-east-1' }), 'claude-sonnet-4-5', () => new NativeFormatter()],
  ['gemini', () => new GeminiAdapter({ apiKey: 'zz-key' }), 'gemini-2.5-pro', () => new NativeFormatter()],
  ['openai', () => new OpenAIAdapter({ apiKey: 'zz-key' }), 'gpt-4o', () => new NativeFormatter()],
  ['openai-compatible', () => new OpenAICompatibleAdapter({ baseURL: 'http://zz-host.invalid/v1', apiKey: 'zz-key' }), 'zz-model', () => new NativeFormatter()],
  ['openai-completions', () => new OpenAICompletionsAdapter({ baseURL: 'http://zz-host.invalid/v1', apiKey: 'zz-key' }), 'zz-model', () => new CompletionsFormatter()],
  ['openai-responses', () => new OpenAIResponsesAdapter({ apiKey: 'zz-key', promptFormat: 'transcript', transcriptPreamble: '' }), 'gpt-image-1', () => new NativeFormatter()],
  ['openai-responses-api', () => new OpenAIResponsesAPIAdapter({ apiKey: 'zz-key' }), 'gpt-5.4', () => new NativeFormatter()],
  ['openrouter', () => new OpenRouterAdapter({ apiKey: 'zz-key' }), 'zz/model', () => new NativeFormatter()],
];

function request(model: string): NormalizedRequest {
  return {
    messages: [{ participant: 'User', cacheBreakpoint: true, content: [{ type: 'text', text: 'zz hello' }] }],
    system: 'zz system',
    config: { model, maxTokens: 64, temperature: 0.5 },
    toolMode: 'native',
  };
}

type Method = 'complete' | 'stream' | 'streamYielding';

/** With a progress deadline, core passes onProgress whether or not it observes, and the call names itself. */
const DEADLINED = { progressTimeoutMs: 60_000, purpose: 'turn' as const, requestId: 'zz-req-1' };

async function wireOf(
  build: () => ProviderAdapter,
  formatter: () => PrefillFormatter,
  model: string,
  method: Method,
  deadlined: boolean,
  observe: boolean,
): Promise<{ wire: Wire[]; records: AttemptRecord[] }> {
  const wire: Wire[] = [];
  // The provider refuses every request: only what was sent matters here.
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    wire.push(await capture(input, init));
    return new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'zz refused' } }), {
      status: 400, headers: { 'content-type': 'application/json' },
    });
  }));
  const records: AttemptRecord[] = [];
  const membrane = new Membrane(build(), {
    formatter: formatter(),
    ...(observe ? { onAttempt: (record: AttemptRecord) => { records.push(record); } } : {}),
  });
  const options = deadlined ? DEADLINED : {};
  if (method === 'complete') await membrane.complete(request(model), options).catch(() => undefined);
  else if (method === 'stream') await membrane.stream(request(model), options).catch(() => undefined);
  else for await (const _event of membrane.streamYielding(request(model), options)) { /* the 400 ends it as an error event */ }
  return { wire, records };
}

describe('the wire is the same with and without onAttempt', () => {
  for (const [name, build, model, formatter] of ADAPTERS) {
    for (const method of ['complete', 'stream', 'streamYielding'] as const) {
      for (const deadlined of [false, true]) {
        it(`${name}, ${method}()${deadlined ? ', with a progress deadline, a purpose and a requestId' : ''}`, async () => {
          vi.useFakeTimers({ now: Date.parse('2026-10-24T12:00:00Z'), toFake: ['Date'] });
          const without = await wireOf(build, formatter, model, method, deadlined, false);
          const withRecord = await wireOf(build, formatter, model, method, deadlined, true);

          expect(without.wire.length).toBeGreaterThan(0);
          // Bedrock's comparison covers its signature, which signs the rest.
          if (name === 'bedrock') expect(without.wire[0]!.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
          expect(withRecord.wire).toEqual(without.wire);
          // And the observer did observe: one record per request sent.
          expect(withRecord.records).toHaveLength(withRecord.wire.length);
        });
      }
    }
  }
});
