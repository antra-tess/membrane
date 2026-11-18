/**
 * OpenAI's Responses API reports a prompt-cache write as
 * `usage.input_tokens_details.cache_write_tokens`, inside `input_tokens`, and
 * bills it at 1.25× input from GPT-5.6 on (prompt-caching guide). The adapter
 * carries it as `cacheCreationTokens`; membrane's cache-inclusive
 * normalization takes it out of `inputTokens`; the GPT-5.6+ rows price it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIResponsesAPIAdapter } from '../../src/providers/openai-responses-api.js';
import { Membrane } from '../../src/membrane.js';
import { OpenAIResponsesFormatter } from '../../src/formatters/openai-responses.js';
import { getDefaultPricing } from '../../src/registry/default-pricing.js';

afterEach(() => { vi.unstubAllGlobals(); });

// The guide's own example: 12,000 input, 4,000 read, 7,000 written, 1,000 ordinary.
const GUIDE_USAGE = {
  input_tokens: 12_000,
  output_tokens: 25,
  total_tokens: 12_025,
  input_tokens_details: {
    cached_tokens: 4_000,
    cache_write_tokens: 7_000,
    cache_write_tokens_details: { ttl_30m_tokens: 3_000, ttl_12h_tokens: 4_000 },
  },
};

function stubResponse(usage: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
    new Response(JSON.stringify({
      id: 'resp_cw',
      model: 'gpt-5.6-sol',
      status: 'completed',
      output: [{
        type: 'message', id: 'msg_cw', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'ok' }],
      }],
      usage,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  ));
}

describe('OpenAI Responses cache writes', () => {
  it('reach normalized usage as cacheCreationTokens', async () => {
    stubResponse(GUIDE_USAGE);
    const adapter = new OpenAIResponsesAPIAdapter({ apiKey: 'sk-test' });
    const response = await adapter.complete({ model: 'gpt-5.6-sol', messages: [], maxTokens: 10 });
    expect(response.usage).toEqual({
      inputTokens: 12_000, outputTokens: 25, cacheReadTokens: 4_000, cacheCreationTokens: 7_000,
    });
  });

  it('stay absent when the provider reports no write', async () => {
    stubResponse({ input_tokens: 100, output_tokens: 25, input_tokens_details: { cached_tokens: 40 } });
    const adapter = new OpenAIResponsesAPIAdapter({ apiKey: 'sk-test' });
    const response = await adapter.complete({ model: 'gpt-5.6-sol', messages: [], maxTokens: 10 });
    expect(response.usage).toEqual({ inputTokens: 100, outputTokens: 25, cacheReadTokens: 40 });
  });

  it('leave 1,000 ordinary input tokens after normalization, and are priced at 1.25× input', async () => {
    stubResponse(GUIDE_USAGE);
    const membrane = new Membrane(new OpenAIResponsesAPIAdapter({ apiKey: 'sk-test' }), {
      formatter: new OpenAIResponsesFormatter(), assistantParticipant: 'Sol',
    });
    const response = await membrane.complete({
      messages: [{ participant: 'User', content: [{ type: 'text', text: 'hi' }] }],
      config: { model: 'gpt-5.6-sol', maxTokens: 10 },
    });
    expect(response.usage).toMatchObject({ inputTokens: 1_000, cacheReadTokens: 4_000, cacheCreationTokens: 7_000 });
    const cost = response.usage.estimatedCost!;
    // gpt-5.6-sol: $4 input, $5 write, $0.40 read, $20 output.
    expect(cost.input).toBeCloseTo(1_000 * 4 / 1e6, 12);
    expect(cost.cacheWrite).toBeCloseTo(7_000 * 5 / 1e6, 12);
    expect(cost.cacheRead).toBeCloseTo(4_000 * 0.40 / 1e6, 12);
    expect(cost.total).toBeCloseTo((1_000 * 4 + 7_000 * 5 + 4_000 * 0.40 + 25 * 20) / 1e6, 12);
  });
});

describe('OpenAI rows', () => {
  it('price a write at 1.25× input from GPT-5.6 on, and not before', () => {
    for (const id of ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
      const row = getDefaultPricing(id)!;
      expect(row.cacheWritePerMillion, id).toBeCloseTo(row.inputPerMillion * 1.25, 12);
    }
    for (const id of ['gpt-5.5', 'gpt-5.4', 'gpt-5.1', 'gpt-4o']) {
      expect(getDefaultPricing(id)!.cacheWritePerMillion, id).toBeUndefined();
    }
  });
});
