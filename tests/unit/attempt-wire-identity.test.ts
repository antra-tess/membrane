/**
 * An attempt record observes; it never changes what's sent. With
 * `onAttempt` set, Membrane core passes each adapter `onProgress` and
 * `onSend`, which it doesn't pass otherwise (with no progress deadline). So
 * for every built-in adapter, on `complete()` and on `stream()`, the request
 * each one puts on the wire is captured at `fetch` with and without
 * `onAttempt`, and they must be the same bytes: URL, method, headers and body.
 * (Bedrock signs each request with the time, so its signature headers are
 * left out of the comparison; the clock is held still for it anyway.)
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

const SIGNED = new Set(['authorization', 'x-amz-date', 'x-amz-content-sha256', 'x-amz-security-token']);

async function capture(input: unknown, init?: RequestInit): Promise<Wire> {
  const request = new Request(input as RequestInfo, init);
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => { if (!SIGNED.has(key)) headers[key] = value; });
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

async function wireOf(
  build: () => ProviderAdapter,
  formatter: () => PrefillFormatter,
  model: string,
  method: 'complete' | 'stream',
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
  const call = method === 'complete' ? membrane.complete(request(model)) : membrane.stream(request(model));
  await call.catch(() => undefined);
  return { wire, records };
}

describe('the wire is the same with and without onAttempt', () => {
  for (const [name, build, model, formatter] of ADAPTERS) {
    for (const method of ['complete', 'stream'] as const) {
      it(`${name}, ${method}()`, async () => {
        vi.useFakeTimers({ now: Date.parse('2026-10-24T12:00:00Z'), toFake: ['Date'] });
        const without = await wireOf(build, formatter, model, method, false);
        const withRecord = await wireOf(build, formatter, model, method, true);

        expect(without.wire.length).toBeGreaterThan(0);
        expect(withRecord.wire).toEqual(without.wire);
        // And the observer did observe: one record per request sent.
        expect(withRecord.records).toHaveLength(withRecord.wire.length);
      });
    }
  }
});
