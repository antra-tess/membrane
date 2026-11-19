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
import { calculateCost } from '../../src/utils/cost.js';

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
  it('reach the adapter\'s usage as cacheCreationTokens, inside inputTokens as the API counts them', async () => {
    stubResponse(GUIDE_USAGE);
    const adapter = new OpenAIResponsesAPIAdapter({ apiKey: 'sk-test' });
    const response = await adapter.complete({ model: 'gpt-5.6-sol', messages: [], maxTokens: 10 });
    expect(response.usage).toEqual({
      inputTokens: 12_000, outputTokens: 25, cacheReadTokens: 4_000, cacheCreationTokens: 7_000,
    });
  });

  it('keep a reported zero as zero', async () => {
    stubResponse({ input_tokens: 100, output_tokens: 25, input_tokens_details: { cached_tokens: 40, cache_write_tokens: 0 } });
    const adapter = new OpenAIResponsesAPIAdapter({ apiKey: 'sk-test' });
    const response = await adapter.complete({ model: 'gpt-5.6-sol', messages: [], maxTokens: 10 });
    expect(response.usage).toEqual({ inputTokens: 100, outputTokens: 25, cacheReadTokens: 40, cacheCreationTokens: 0 });
  });

  it('are read from a stream\'s terminal response too', async () => {
    const output = [{
      type: 'message', id: 'msg_s', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'ok', annotations: [] }],
    }];
    const events = [
      { type: 'response.output_item.added', output_index: 0, item: { ...output[0], status: 'in_progress', content: [] } },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'msg_s', delta: 'ok' },
      { type: 'response.output_item.done', output_index: 0, item: output[0] },
      { type: 'response.completed', response: { id: 'resp_s', model: 'gpt-5.6-sol', status: 'completed', output, usage: GUIDE_USAGE } },
    ];
    const sse = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(sse, { status: 200 })));
    const adapter = new OpenAIResponsesAPIAdapter({ apiKey: 'sk-test' });
    const response = await adapter.stream({ model: 'gpt-5.6-sol', messages: [], maxTokens: 10 }, { onChunk: () => {} });
    expect(response.usage).toEqual({ inputTokens: 12_000, outputTokens: 25, cacheReadTokens: 4_000, cacheCreationTokens: 7_000 });
  });

  it('stay absent when the provider reports no write, with or without input_tokens_details', async () => {
    stubResponse({ input_tokens: 100, output_tokens: 25, input_tokens_details: { cached_tokens: 40 } });
    const adapter = new OpenAIResponsesAPIAdapter({ apiKey: 'sk-test' });
    const withDetails = await adapter.complete({ model: 'gpt-5.6-sol', messages: [], maxTokens: 10 });
    expect(withDetails.usage).toEqual({ inputTokens: 100, outputTokens: 25, cacheReadTokens: 40 });
    expect('cacheCreationTokens' in withDetails.usage).toBe(false);
    stubResponse({ input_tokens: 100, output_tokens: 25 });
    const noDetails = await adapter.complete({ model: 'gpt-5.6-sol', messages: [], maxTokens: 10 });
    expect(noDetails.usage).toEqual({ inputTokens: 100, outputTokens: 25 });
    expect('cacheCreationTokens' in noDetails.usage).toBe(false);
    expect('cacheReadTokens' in noDetails.usage).toBe(false);
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
  it('price a write at 1.25× input from GPT-5.6 on, and at the input rate before', () => {
    for (const id of ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
      const row = getDefaultPricing(id)!;
      expect(row.cacheWritePerMillion, id).toBeCloseTo(row.inputPerMillion * 1.25, 12);
    }
    for (const id of ['gpt-5.5', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5.4', 'gpt-5.2', 'gpt-5.1', 'gpt-5-mini', 'gpt-5-nano', 'gpt-5', 'gpt-4o-mini', 'gpt-4o-2024-05-13', 'gpt-4o']) {
      const row = getDefaultPricing(id)!;
      expect(row.cacheWritePerMillion, id).toBe(row.inputPerMillion);
    }
  });

  it('bill a write on an earlier model exactly as the input it was before this change', () => {
    // 10,000 input of which 7,000 written, no reads: $5 input on gpt-5.5 → $0.05
    // whether the 7,000 sit in inputTokens (before) or in cacheCreationTokens (now).
    const cost = calculateCost({ inputTokens: 3_000, outputTokens: 0, cacheCreationTokens: 7_000 }, getDefaultPricing('gpt-5.5')!);
    expect(cost.input).toBeCloseTo(0.015, 12);
    expect(cost.cacheWrite).toBeCloseTo(0.035, 12);
    expect(cost.total).toBeCloseTo(0.05, 12);
  });

  it('under a caller\'s own row with no write rate, the write is unpriced — calculateCost has no input-rate fallback by design', () => {
    // The rule the ModelPricing doc states: a row for a cache-inclusive provider carries a write rate.
    const own = calculateCost({ inputTokens: 3_000, outputTokens: 0, cacheCreationTokens: 7_000 }, { inputPerMillion: 5, outputPerMillion: 15, currency: 'USD' });
    expect(own.cacheWrite).toBeUndefined();
    expect(own.total).toBeCloseTo(0.015, 12);
  });
});
