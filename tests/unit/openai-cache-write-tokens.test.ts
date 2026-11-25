/**
 * OpenAI reports a prompt-cache write inside the input count — the Responses
 * API as `usage.input_tokens_details.cache_write_tokens` (with a 30-minute /
 * 12-hour split), Chat Completions as `usage.prompt_tokens_details.
 * cache_write_tokens` — and from GPT-5.6 on bills it at 1.25× input for the
 * 30-minute cache and 2.5× for the 12-hour cache (prompt-caching guide); earlier
 * models and gpt-6-astra-law charge the input rate. The adapters carry the
 * total as `cacheCreationTokens`, and the Responses adapter the 12-hour part as
 * `cacheCreation1hTokens` (Chat Completions has the 30-minute TTL alone);
 * membrane's cache-inclusive normalization takes them out of `inputTokens`; the
 * rows price them, and a row without a write rate is warned about once.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIResponsesAPIAdapter } from '../../src/providers/openai-responses-api.js';
import { OpenAIAdapter } from '../../src/providers/openai.js';
import { stubFetchWithSseLines } from '../helpers/sse-fixtures.js';
import { resetUnpricedModelWarnings } from '../../src/utils/cost.js';
import { Membrane } from '../../src/membrane.js';
import { OpenAIResponsesFormatter } from '../../src/formatters/openai-responses.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { TurnUsageAccumulator } from '../../src/utils/usage.js';
import { PRICING_TABLE, getDefaultPricing } from '../../src/registry/default-pricing.js';
import { calculateCost } from '../../src/utils/cost.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); resetUnpricedModelWarnings(); });

// The guide's own example: 12,000 input, 4,000 read, 7,000 written (3,000 for 30 minutes,
// 4,000 for 12 hours), 1,000 ordinary.
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
      inputTokens: 12_000, outputTokens: 25, cacheReadTokens: 4_000, cacheCreationTokens: 7_000, cacheCreation1hTokens: 4_000,
    });
  });

  it('carry no long-TTL count when the provider reports no split', async () => {
    stubResponse({ input_tokens: 12_000, output_tokens: 25, input_tokens_details: { cached_tokens: 4_000, cache_write_tokens: 7_000 } });
    const adapter = new OpenAIResponsesAPIAdapter({ apiKey: 'sk-test' });
    const response = await adapter.complete({ model: 'gpt-5.6-sol', messages: [], maxTokens: 10 });
    expect(response.usage).toEqual({ inputTokens: 12_000, outputTokens: 25, cacheReadTokens: 4_000, cacheCreationTokens: 7_000 });
    expect('cacheCreation1hTokens' in response.usage).toBe(false);
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
    expect(response.usage).toEqual({ inputTokens: 12_000, outputTokens: 25, cacheReadTokens: 4_000, cacheCreationTokens: 7_000, cacheCreation1hTokens: 4_000 });
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

  it('leave 1,000 ordinary input tokens after normalization, and 30-minute writes are priced at 1.25× input', async () => {
    // The guide's counts with every write a 30-minute one: the 1.25× case alone.
    stubResponse({ ...GUIDE_USAGE, input_tokens_details: { cached_tokens: 4_000, cache_write_tokens: 7_000, cache_write_tokens_details: { ttl_30m_tokens: 7_000, ttl_12h_tokens: 0 } } });
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

  it('price the guide\'s own example as the guide does: 12-hour writes at 2.5× input, 30-minute at 1.25×', async () => {
    stubResponse(GUIDE_USAGE);
    const membrane = new Membrane(new OpenAIResponsesAPIAdapter({ apiKey: 'sk-test' }), {
      formatter: new OpenAIResponsesFormatter(), assistantParticipant: 'Sol',
    });
    const response = await membrane.complete({
      messages: [{ participant: 'User', content: [{ type: 'text', text: 'hi' }] }],
      config: { model: 'gpt-5.6-sol', maxTokens: 10 },
    });
    expect(response.usage).toMatchObject({ inputTokens: 1_000, cacheReadTokens: 4_000, cacheCreationTokens: 7_000, cacheCreation1hTokens: 4_000 });
    const cost = response.usage.estimatedCost!;
    // gpt-5.6-sol: $4 input, $5 write (30 min), $10 write (12 h), $0.40 read, $20 output.
    // The guide: 1,000 × $4 + 3,000 × $5 + 4,000 × $10 + 4,000 × $0.40 = $0.0606 on the input side.
    expect(cost.cacheWrite).toBeCloseTo((3_000 * 5 + 4_000 * 10) / 1e6, 12);
    expect(cost.input + cost.cacheWrite! + cost.cacheRead!).toBeCloseTo(0.0606, 12);
    expect(cost.total).toBeCloseTo((1_000 * 4 + 3_000 * 5 + 4_000 * 10 + 4_000 * 0.40 + 25 * 20) / 1e6, 12);
  });
});

// Chat Completions reports the same write count under prompt_tokens_details (API reference),
// without the TTL split.
const CHAT_USAGE = {
  prompt_tokens: 12_000, completion_tokens: 25, total_tokens: 12_025,
  prompt_tokens_details: { cached_tokens: 4_000, cache_write_tokens: 7_000 },
};
function stubChatResponse(usage: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
    new Response(JSON.stringify({
      id: 'chatcmpl_cw', object: 'chat.completion', model: 'gpt-5.6-sol',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  ));
}
const chatRequest = { model: 'gpt-5.6-sol', maxTokens: 10, messages: [{ role: 'user', content: 'hi' }] } as any;

describe('OpenAI Chat Completions cache writes', () => {
  it('reach the adapter\'s usage as cacheCreationTokens, inside inputTokens as the API counts them', async () => {
    stubChatResponse(CHAT_USAGE);
    const response = await new OpenAIAdapter({ apiKey: 'sk-test' }).complete(chatRequest);
    expect(response.usage).toEqual({ inputTokens: 12_000, outputTokens: 25, cacheReadTokens: 4_000, cacheCreationTokens: 7_000 });
  });

  it('keep a reported zero as zero, and stay absent when the field is not reported', async () => {
    stubChatResponse({ prompt_tokens: 100, completion_tokens: 25, prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 0 } });
    const zero = await new OpenAIAdapter({ apiKey: 'sk-test' }).complete(chatRequest);
    expect(zero.usage).toEqual({ inputTokens: 100, outputTokens: 25, cacheReadTokens: 40, cacheCreationTokens: 0 });
    stubChatResponse({ prompt_tokens: 100, completion_tokens: 25, prompt_tokens_details: { cached_tokens: 40 } });
    const absent = await new OpenAIAdapter({ apiKey: 'sk-test' }).complete(chatRequest);
    expect(absent.usage).toEqual({ inputTokens: 100, outputTokens: 25, cacheReadTokens: 40 });
    expect('cacheCreationTokens' in absent.usage).toBe(false);
  });

  it('are read from a stream\'s usage frame too', async () => {
    stubFetchWithSseLines([
      '{"choices":[{"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}',
      '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
      JSON.stringify({ choices: [], usage: CHAT_USAGE }),
      '[DONE]',
    ]);
    const response = await new OpenAIAdapter({ apiKey: 'sk-test' }).stream(chatRequest, { onChunk: () => {} } as any);
    expect(response.usage).toEqual({ inputTokens: 12_000, outputTokens: 25, cacheReadTokens: 4_000, cacheCreationTokens: 7_000 });
  });
});

describe('OpenAI rows', () => {
  it('price a 30-minute write at 1.25× and a 12-hour write at 2.5× input from GPT-5.6 on; at the input rate before, and on gpt-6-astra-law', () => {
    for (const id of ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6-cyber']) {
      const row = getDefaultPricing(id)!;
      expect(row.cacheWritePerMillion, id).toBeCloseTo(row.inputPerMillion * 1.25, 12);
      expect(row.cacheWrite1hPerMillion, id).toBeCloseTo(row.inputPerMillion * 2.5, 12);
    }
    // The legal configuration shares gpt-6-astra's input and output; its page row has no write price.
    const law = getDefaultPricing('gpt-6-astra-law')!;
    expect(law).toMatchObject({ inputPerMillion: 10, outputPerMillion: 50, cacheWritePerMillion: 10 });
    expect(law.cacheWrite1hPerMillion).toBeUndefined();
    // A GPT-5.6 id without a row is unpriced, not priced as gpt-5.
    expect(getDefaultPricing('gpt-5.6')).toBeUndefined();
    expect(getDefaultPricing('gpt-5.6-mini')).toBeUndefined();
    expect(getDefaultPricing('gpt-5.6-cyber')).toMatchObject({ inputPerMillion: 12.5, outputPerMillion: 75, cacheWritePerMillion: 15.625, cacheWrite1hPerMillion: 31.25 });
  });

  it('every built-in OpenAI row carries a write rate, and a 12-hour rate where the write is a premium — the rule the normalization rests on', () => {
    // A row without cacheWritePerMillion prices written tokens nowhere under the cache-inclusive
    // normalization; a row whose 30-minute write is above input is a GPT-5.6+ row, which the
    // Responses API can bill at the 12-hour rate too. Whichever PR adds an OpenAI row next
    // (#251's gpt-6.1-sol, #264's tiers) goes red here until the rates are in.
    for (const row of PRICING_TABLE) {
      if (!row.prefix.startsWith('gpt-') || row.pricing === null) continue;
      expect(row.pricing.cacheWritePerMillion, `${row.prefix} has no write rate`).toBeDefined();
      if (row.pricing.cacheWritePerMillion! > row.pricing.inputPerMillion) {
        expect(row.pricing.cacheWrite1hPerMillion, `${row.prefix} has a write premium and no 12-hour rate`).toBeDefined();
      }
    }
    // Each id with its own row's input rate, so a removed or renamed row can't pass on a
    // prefix neighbour's equal rates (gpt-5.1 and gpt-5 are priced the same, and are the one pair this can't tell apart).
    const earlier: Record<string, number> = {
      'gpt-5.5': 5, 'gpt-5.4-mini': 0.75, 'gpt-5.4-nano': 0.20, 'gpt-5.4': 2.50, 'gpt-5.2': 1.75, 'gpt-5.1': 1.25,
      'gpt-5-mini': 0.25, 'gpt-5-nano': 0.05, 'gpt-5': 1.25, 'gpt-4o-mini': 0.15, 'gpt-4o-2024-05-13': 5, 'gpt-4o': 2.50,
    };
    for (const [id, inputPerMillion] of Object.entries(earlier)) {
      const row = getDefaultPricing(id)!;
      expect(row.inputPerMillion, id).toBe(inputPerMillion);
      expect(row.cacheWritePerMillion, id).toBe(inputPerMillion);
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

  it('a write under a caller\'s own row with no write rate is unpriced by design, and Membrane says so once per model', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubChatResponse(CHAT_USAGE);
    const own = { inputPerMillion: 5, outputPerMillion: 15, currency: 'USD' as const };
    const membrane = new Membrane(new OpenAIAdapter({ apiKey: 'sk-test' }), {
      formatter: new NativeFormatter(), assistantParticipant: 'Sol',
      registry: { getPricing: () => own } as any,
    });
    const call = () => membrane.complete({ messages: [{ participant: 'User', content: [{ type: 'text', text: 'hi' }] }], config: { model: 'gpt-5.6-sol', maxTokens: 10 } });
    const first = await call();
    expect(first.usage.estimatedCost!.cacheWrite).toBeUndefined();
    // The request the chat adapter sent carried the message (the formatter and adapter are a real pair).
    const sent = JSON.parse(String((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body));
    expect(JSON.stringify(sent.messages)).toContain('hi');
    const ours = () => warn.mock.calls.filter(([line]) => String(line).startsWith('[membrane:cost] model "gpt-5.6-sol" wrote to the prompt cache'));
    expect(ours()).toHaveLength(1);
    stubChatResponse(CHAT_USAGE);
    await call();
    expect(ours()).toHaveLength(1);
  });

  it('on the round path, each round is priced on its own row, the long-TTL split survives the sum, and a bare row is warned about once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sol = getDefaultPricing('gpt-5.6-sol')!;
    const bare = { inputPerMillion: 5, outputPerMillion: 15, currency: 'USD' as const };
    const turn = new TurnUsageAccumulator('gpt-5.6-sol', (served) => (served === 'bare-model' ? bare : sol));
    turn.addRound('gpt-5.6-sol', { inputTokens: 1_000, outputTokens: 10, cacheReadTokens: 4_000, cacheCreationTokens: 7_000, cacheCreation1hTokens: 4_000 });
    turn.addRound('gpt-5.6-sol', { inputTokens: 500, outputTokens: 10, cacheCreationTokens: 2_000, cacheCreation1hTokens: 0 });
    const two = turn.total;
    expect(two).toMatchObject({ cacheCreationTokens: 9_000, cacheCreation1hTokens: 4_000 });
    // Round 1: 3,000 × $5 + 4,000 × $10; round 2: 2,000 × $5.
    expect(two.estimatedCost!.cacheWrite).toBeCloseTo((3_000 * 5 + 4_000 * 10 + 2_000 * 5) / 1e6, 12);
    turn.addRound('bare-model', { inputTokens: 100, outputTokens: 1, cacheCreationTokens: 50 });
    turn.addRound('bare-model', { inputTokens: 100, outputTokens: 1, cacheCreationTokens: 50 });
    const ours = warn.mock.calls.filter(([line]) => String(line).startsWith('[membrane:cost] model "bare-model" wrote to the prompt cache'));
    expect(ours).toHaveLength(1);
  });

  it('under a caller\'s own row with no write rate, the write is unpriced — calculateCost has no input-rate fallback by design', () => {
    // The rule the ModelPricing doc states: a row for a cache-inclusive provider carries a write rate.
    const own = calculateCost({ inputTokens: 3_000, outputTokens: 0, cacheCreationTokens: 7_000 }, { inputPerMillion: 5, outputPerMillion: 15, currency: 'USD' });
    expect(own.cacheWrite).toBeUndefined();
    expect(own.total).toBeCloseTo(0.015, 12);
  });
});
