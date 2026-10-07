/**
 * `OpenAICompatibleAdapter` pointed at OpenAI itself (baseURL
 * https://api.openai.com/v1) must send OpenAI's parameter surface for
 * OpenAI's reasoning-generation models. It used to send `max_tokens` for every
 * model, so GPT-5+ and o-series requests 400'd at the wire: "Unsupported
 * parameter: 'max_tokens' is not supported with this model. Use
 * 'max_completion_tokens' instead." Model detection is shared with
 * OpenAIAdapter; any other model id keeps the legacy parameters that generic
 * OpenAI-compatible servers (Ollama, vLLM, ...) expect.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { OpenAICompatibleAdapter } from '../../src/providers/openai-compatible.js';
import { stubFetchWithSseLines, capturedRequestBody } from '../helpers/sse-fixtures.js';

afterEach(() => vi.unstubAllGlobals());

const adapter = () => new OpenAICompatibleAdapter({ baseURL: 'http://localhost:9/v1', apiKey: 'zz-key' });

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

describe('OpenAICompatibleAdapter parameter surface for OpenAI models', () => {
  it.each(['gpt-5', 'gpt-5.1', 'gpt-5-mini', 'gpt-6-astra'])(
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

  it('o-series uses max_completion_tokens', async () => {
    const body = await bodyFor('o3');
    expect(body.max_completion_tokens).toBe(64);
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('stop');
  });

  it.each(['llama3.1:8b', 'qwen/qwen3-32b', 'gpt-4o', 'mistral-large-latest'])(
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
});
