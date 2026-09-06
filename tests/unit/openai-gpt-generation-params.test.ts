/**
 * `OpenAIAdapter` picks the request parameter surface by model generation.
 *
 * GPT-5 and later reject `max_tokens` ("Unsupported parameter: 'max_tokens' is
 * not supported with this model. Use 'max_completion_tokens' instead."), and
 * accept only default temperature/top_p and no stop sequences. The adapter
 * used to recognise this family by listing `gpt-5` prefixes, so the first
 * GPT-6 model (gpt-6-astra) fell through to the legacy parameters and every
 * request 400'd. Detection is now by major version.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { OpenAIAdapter } from '../../src/providers/openai.js';
import { stubFetchWithSseLines, capturedRequestBody } from '../helpers/sse-fixtures.js';

afterEach(() => vi.unstubAllGlobals());

const adapter = () => new OpenAIAdapter({ apiKey: 'zz-key' });

async function bodyFor(model: string) {
  const fetchMock = stubFetchWithSseLines([
    '{"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}',
    '[DONE]',
  ]);
  const request = {
    model,
    maxTokens: 64,
    temperature: 0.7,
    topP: 0.9,
    stopSequences: ['zz-stop'],
    messages: [{ role: 'user', content: 'zz prompt' }],
  };
  await adapter().stream(request as any, { onChunk: () => {} } as any);
  return capturedRequestBody(fetchMock);
}

describe('OpenAIAdapter parameter surface by GPT generation', () => {
  it.each(['gpt-6-astra', 'gpt-6', 'gpt-6o', 'gpt-5', 'gpt-5.6-sol', 'gpt-5-mini', 'gpt-7-zz'])(
    '%s sends max_completion_tokens and drops temperature/top_p/stop',
    async (model) => {
      const body = await bodyFor(model);
      expect(body.max_completion_tokens).toBe(64);
      expect(body).not.toHaveProperty('max_tokens');
      expect(body).not.toHaveProperty('temperature');
      expect(body).not.toHaveProperty('top_p');
      expect(body).not.toHaveProperty('stop');
    },
  );

  it.each(['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4-turbo', 'chatgpt-4o-latest'])(
    '%s keeps the legacy max_tokens surface',
    async (model) => {
      const body = await bodyFor(model);
      expect(body.max_tokens).toBe(64);
      expect(body).not.toHaveProperty('max_completion_tokens');
      expect(body.temperature).toBe(0.7);
      expect(body.top_p).toBe(0.9);
      expect(body.stop).toEqual(['zz-stop']);
    },
  );

  it('o-series still uses max_completion_tokens', async () => {
    const o3 = await bodyFor('o3');
    expect(o3.max_completion_tokens).toBe(64);
    expect(o3).not.toHaveProperty('max_tokens');
    expect(o3).not.toHaveProperty('stop');
    const o1 = await bodyFor('o1-mini');
    expect(o1.max_completion_tokens).toBe(64);
    expect(o1).not.toHaveProperty('temperature');
  });
});
