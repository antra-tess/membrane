/**
 * Providers reject unknown request parameters, such as membrane's internal
 * `normalizedMessages`, with a 400.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { BedrockAdapter } from '../../src/providers/bedrock.js';
import { GeminiAdapter } from '../../src/providers/gemini.js';
import { OpenAIAdapter } from '../../src/providers/openai.js';
import { OpenAICompatibleAdapter } from '../../src/providers/openai-compatible.js';
import { OpenAICompletionsAdapter } from '../../src/providers/openai-completions.js';
import { OpenAIResponsesAdapter } from '../../src/providers/openai-responses.js';
import { OpenAIResponsesAPIAdapter } from '../../src/providers/openai-responses-api.js';
import { OpenRouterAdapter } from '../../src/providers/openrouter.js';
import type { ProviderAdapter, ProviderRequest } from '../../src/types/provider.js';

const adapters: Array<[string, () => ProviderAdapter]> = [
  ['anthropic', () => new AnthropicAdapter({ apiKey: 'zz-key', maxRetries: 0, cacheKeepalive: { enabled: false } })],
  ['bedrock', () => new BedrockAdapter({ region: 'us-east-1', accessKeyId: 'zz-key-id', secretAccessKey: 'zz-secret' })],
  ['gemini', () => new GeminiAdapter({ apiKey: 'zz-key' })],
  ['openai', () => new OpenAIAdapter({ apiKey: 'zz-key' })],
  ['openai-compatible', () => new OpenAICompatibleAdapter({ apiKey: 'zz-key', baseURL: 'http://zz-host.invalid/v1' })],
  ['openai-responses', () => new OpenAIResponsesAdapter({ apiKey: 'zz-key' })],
  ['openai-responses-api', () => new OpenAIResponsesAPIAdapter({ apiKey: 'zz-key' })],
  ['openrouter', () => new OpenRouterAdapter({ apiKey: 'zz-key' })],
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("an adapter sends a caller's extra params, and none of membrane's own", () => {
  for (const [name, make] of adapters) {
    it(name, async () => {
      const bodies: string[] = [];
      vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
        bodies.push(String(init?.body));
        return new Response(JSON.stringify({ error: { message: 'zz refused' } }), { status: 400, headers: { 'content-type': 'application/json' } });
      });
      const request: ProviderRequest = {
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: 'zz hello' }],
        maxTokens: 16,
        extra: {
          normalizedMessages: [{ participant: 'zz-internal-participant', content: [] }],
          prompt: 'zz-internal-prompt',
          zz_custom_param: 'zz-custom-value',
        },
      };
      await make().complete(request).catch(() => undefined);

      expect(bodies.length).toBeGreaterThan(0);
      for (const body of bodies) {
        expect(body).not.toContain('normalizedMessages');
        expect(body).not.toContain('zz-internal-participant');
        expect(body).not.toContain('zz-internal-prompt');
        expect(body).toContain('"zz_custom_param":"zz-custom-value"');
      }
    });
  }

  it('openai-completions, which builds its prompt from normalizedMessages', async () => {
    const bodies: string[] = [];
    vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response(JSON.stringify({ error: { message: 'zz refused' } }), { status: 400, headers: { 'content-type': 'application/json' } });
    });
    const adapter = new OpenAICompletionsAdapter({ baseURL: 'http://zz-host.invalid/v1', apiKey: 'zz-key' });
    await adapter.complete({
      model: 'zz-base-model',
      messages: [{ role: 'user', content: 'zz hello' }],
      maxTokens: 16,
      extra: {
        normalizedMessages: [{ participant: 'User', content: [{ type: 'text', text: 'zz hello' }] }],
        zz_custom_param: 'zz-custom-value',
      },
    }).catch(() => undefined);

    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body).not.toContain('normalizedMessages');
      expect(body).toContain('"zz_custom_param":"zz-custom-value"');
    }
  });
});
