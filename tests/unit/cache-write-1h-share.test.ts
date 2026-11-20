/**
 * The 1-hour share of cache writes (`cacheCreation1hTokens`) on its way from
 * the provider's usage report to the turn's totals: summed where the writes
 * are summed, unknown where any part wrote without a split, and taken from
 * the usage event it describes.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { TurnUsageAccumulator, cacheCreation1h, sumCacheCreation1h } from '../../src/utils/usage.js';
import { OpenRouterAdapter } from '../../src/providers/openrouter.js';
import { sseResponse } from '../helpers/sse-fixtures.js';
import type { ModelPricing, ProviderAdapter, ProviderResponse } from '../../src/types/provider.js';
import type { NormalizedRequest } from '../../src/types/index.js';

const PRICING: ModelPricing = {
  inputPerMillion: 1, outputPerMillion: 1, cacheWritePerMillion: 1.25, cacheWrite1hPerMillion: 2, currency: 'USD',
};

describe('TurnUsageAccumulator', () => {
  it('sums the 1-hour share across rounds and keeps each round\'s own', () => {
    const turn = new TurnUsageAccumulator('m', () => PRICING);
    turn.addRound('m', { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 5_000, cacheCreation1hTokens: 4_000 });
    const total = turn.addRound('m', { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 3_000, cacheCreation1hTokens: 2_000 });
    expect(total).toMatchObject({ cacheCreationTokens: 8_000, cacheCreation1hTokens: 6_000 });
    // 2k short at $1.25 + 6k at $2
    expect(total.estimatedCost?.cacheWrite).toBeCloseTo((2_000 * 1.25 + 6_000 * 2) / 1_000_000, 12);
    expect(turn.perRound.map((r) => r.usage.cacheCreation1hTokens)).toEqual([4_000, 2_000]);
  });

  it('reports no share once a round wrote without a split, and does not revive it', () => {
    const turn = new TurnUsageAccumulator('m', () => PRICING);
    turn.addRound('m', { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 100, cacheCreation1hTokens: 100 });
    const afterUnknown = turn.addRound('m', { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 100 });
    expect(afterUnknown.cacheCreationTokens).toBe(200);
    expect('cacheCreation1hTokens' in afterUnknown).toBe(false);
    const later = turn.addRound('m', { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 50, cacheCreation1hTokens: 50 });
    expect(later.cacheCreationTokens).toBe(250);
    expect('cacheCreation1hTokens' in later).toBe(false);
  });

  it('keeps the share when the split-less round wrote nothing', () => {
    const turn = new TurnUsageAccumulator('m', () => PRICING);
    turn.addRound('m', { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 100, cacheCreation1hTokens: 100 });
    const total = turn.addRound('m', { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0 });
    expect(total).toMatchObject({ cacheCreationTokens: 100, cacheCreation1hTokens: 100 });
  });
});

describe('sumCacheCreation1h', () => {
  it('is absent when neither part reported a share', () => {
    expect(sumCacheCreation1h({ cacheCreationTokens: 5 }, { cacheCreationTokens: 5 })).toEqual({});
  });
  it('is absent when a writing part has no share', () => {
    expect(sumCacheCreation1h({ cacheCreationTokens: 5, cacheCreation1hTokens: 5 }, { cacheCreationTokens: 5 })).toEqual({});
  });
  it('sums when both are known', () => {
    expect(sumCacheCreation1h({ cacheCreationTokens: 5, cacheCreation1hTokens: 2 }, { cacheCreationTokens: 0 }))
      .toEqual({ cacheCreation1hTokens: 2 });
  });
});

describe('discarded attempts', () => {
  class RefusingAdapter implements ProviderAdapter {
    readonly name = 'zz-1h';
    calls = 0;
    constructor(private readonly usages: ProviderResponse['usage'][]) {}
    supportsModel() { return true; }
    async complete(): Promise<ProviderResponse> {
      const usage = this.usages[this.calls]!;
      const refusing = this.calls < this.usages.length - 1;
      this.calls++;
      return {
        content: [{ type: 'text', text: refusing ? 'no' : 'yes' }],
        stopReason: refusing ? 'refusal' : 'end_turn',
        usage,
        raw: { response: { stop_reason: refusing ? 'refusal' : 'end_turn' } },
      } as unknown as ProviderResponse;
    }
    async stream(): Promise<ProviderResponse> { return this.complete(); }
  }
  const request: NormalizedRequest = {
    messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz' }] }],
    toolMode: 'native',
    tools: [{ name: 'zz_noop', description: 'zz', inputSchema: { type: 'object', properties: {} } }],
    config: { model: 'zz-model', maxTokens: 10 },
  };

  it('carry the 1-hour share of each abandoned attempt', async () => {
    const adapter = new RefusingAdapter([
      { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 300, cacheCreation1hTokens: 300 },
      { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 200, cacheCreation1hTokens: 100 },
      { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 50, cacheCreation1hTokens: 50 },
    ]);
    const response = await new Membrane(adapter).complete(request, { refusalRetries: 2 });
    expect(response.usage).toMatchObject({ cacheCreationTokens: 50, cacheCreation1hTokens: 50 });
    expect(response.details.usage.discardedAttempts).toMatchObject({ attempts: 2, cacheCreationTokens: 500, cacheCreation1hTokens: 400 });
  });

  it('drop the share when an abandoned attempt wrote without a split', async () => {
    const adapter = new RefusingAdapter([
      { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 300, cacheCreation1hTokens: 300 },
      { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 200 },
      { inputTokens: 1, outputTokens: 1 },
    ]);
    const response = await new Membrane(adapter).complete(request, { refusalRetries: 2 });
    const discarded = response.details.usage.discardedAttempts!;
    expect(discarded.cacheCreationTokens).toBe(500);
    expect('cacheCreation1hTokens' in discarded).toBe(false);
  });
});

describe('AnthropicAdapter streaming: the split follows the usage event it came with', () => {
  function fakeStream(events: unknown[]) {
    return {
      controller: { abort() {} },
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          async next() {
            return index < events.length ? { value: events[index++], done: false } : { value: undefined, done: true };
          },
        };
      },
    };
  }

  async function streamed(startUsage: Record<string, unknown>, deltaUsage: Record<string, unknown>) {
    const adapter = new AnthropicAdapter({ apiKey: 'sk-test', cacheKeepalive: { enabled: false } });
    (adapter as any).client = {
      withOptions() { return this; },
      messages: {
        stream: async () => fakeStream([
          { type: 'message_start', message: { model: 'claude-fable-5', usage: { input_tokens: 2, cache_read_input_tokens: 0, ...startUsage } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3, ...deltaUsage } },
        ]),
      },
    };
    return adapter.stream(
      { model: 'claude-fable-5', messages: [{ role: 'user', content: 'hi' } as any], maxTokens: 10 } as any,
      { onChunk: () => {} },
    );
  }

  const start = { cache_creation_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 100 } };

  it('takes a breakdown the delta brings over message_start\'s', async () => {
    const response = await streamed(start, {
      cache_creation_input_tokens: 200,
      cache_creation: { ephemeral_5m_input_tokens: 50, ephemeral_1h_input_tokens: 150 },
    });
    expect(response.usage).toMatchObject({ cacheCreationTokens: 200, cacheCreation1hTokens: 150 });
    expect((response.raw as any).usage.cache_creation).toEqual({ ephemeral_5m_input_tokens: 50, ephemeral_1h_input_tokens: 150 });
  });

  it('leaves the split unknown when the delta changes the total without one', async () => {
    const grew = await streamed(start, { cache_creation_input_tokens: 200 });
    expect(grew.usage.cacheCreationTokens).toBe(200);
    expect('cacheCreation1hTokens' in grew.usage).toBe(false);
    expect((grew.raw as any).usage.cache_creation).toBeUndefined();

    const shrank = await streamed(start, { cache_creation_input_tokens: 50 });
    expect(shrank.usage.cacheCreationTokens).toBe(50);
    expect('cacheCreation1hTokens' in shrank.usage).toBe(false);
  });

  it('keeps message_start\'s split when the delta repeats the same total', async () => {
    const response = await streamed(start, { cache_creation_input_tokens: 100 });
    expect(response.usage).toMatchObject({ cacheCreationTokens: 100, cacheCreation1hTokens: 100 });
  });
});

describe('the 1-hour member missing from a breakdown', () => {
  it('leaves the share unknown in complete(), not zero', async () => {
    const adapter = new AnthropicAdapter({ apiKey: 'sk-test', cacheKeepalive: { enabled: false } });
    (adapter as any).client = {
      messages: {
        create: async () => ({
          id: 'msg_5m', model: 'claude-fable-5', content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn', stop_sequence: null,
          usage: { input_tokens: 2, output_tokens: 1, cache_creation_input_tokens: 5_000, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 1_000 } },
        }),
      },
    };
    const response = await adapter.complete({ model: 'claude-fable-5', messages: [{ role: 'user', content: 'hi' } as any], maxTokens: 10 } as any);
    expect(response.usage.cacheCreationTokens).toBe(5_000);
    expect('cacheCreation1hTokens' in response.usage).toBe(false);
  });

  it('is absent from the helper, and a numeric member is kept as given', () => {
    expect(cacheCreation1h(undefined)).toEqual({});
    expect(cacheCreation1h({ ephemeral_5m_input_tokens: 10 })).toEqual({});
    expect(cacheCreation1h({ ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 0 })).toEqual({ cacheCreation1hTokens: 0 });
    expect(cacheCreation1h({ ephemeral_1h_input_tokens: 7 })).toEqual({ cacheCreation1hTokens: 7 });
  });
});

describe('OpenRouter, an Anthropic-shaped usage', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const usage = {
    prompt_tokens: 100, completion_tokens: 2,
    cache_creation_input_tokens: 1_000, cache_read_input_tokens: 0,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000 },
  };
  const request = { model: 'anthropic/claude-fable-5', messages: [{ role: 'user', content: 'hi' }], maxTokens: 10 } as any;

  it('carries the 1-hour share from complete()', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage,
    }))));
    const response = await new OpenRouterAdapter({ apiKey: 'zz-key' }).complete(request);
    expect(response.usage).toMatchObject({ cacheCreationTokens: 1_000, cacheCreation1hTokens: 1_000 });
  });

  it('carries the 1-hour share from a stream', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }], usage }),
    ])));
    const response = await new OpenRouterAdapter({ apiKey: 'zz-key' }).stream(request, { onChunk: () => {} });
    expect(response.usage).toMatchObject({ cacheCreationTokens: 1_000, cacheCreation1hTokens: 1_000 });
  });
});
