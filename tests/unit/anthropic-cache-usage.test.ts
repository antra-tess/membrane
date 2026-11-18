import { describe, expect, it } from 'vitest';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';

function fakeStream(events: unknown[]) {
  return {
    controller: { abort() { } },
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next() {
          return index < events.length
            ? { value: events[index++], done: false }
            : { value: undefined, done: true };
        },
      };
    },
  };
}

describe('AnthropicAdapter streaming usage metadata', () => {
  it('preserves authoritative cache-write TTL buckets for downstream billing', async () => {
    const adapter = new AnthropicAdapter({ apiKey: 'sk-test' });
    (adapter as any).client = {
      withOptions() { return this; },
      messages: {
        stream: async () => fakeStream([
          {
            type: 'message_start',
            message: {
              model: 'claude-fable-5',
              usage: {
                input_tokens: 2,
                cache_creation_input_tokens: 336_010,
                cache_read_input_tokens: 0,
                cache_creation: {
                  ephemeral_5m_input_tokens: 0,
                  ephemeral_1h_input_tokens: 336_010,
                },
                service_tier: 'standard',
                inference_geo: 'global',
              },
            },
          },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 10, cache_creation_input_tokens: 336_010 },
          },
        ]),
      },
    };

    const response = await adapter.stream(
      {
        model: 'claude-fable-5',
        messages: [{ role: 'user', content: 'hi' } as any],
        maxTokens: 100,
      } as any,
      { onChunk: () => {} },
    );

    expect(response.usage).toMatchObject({
      cacheCreationTokens: 336_010,
      cacheCreation1hTokens: 336_010,
    });
    expect((response.raw as any).usage).toMatchObject({
      cache_creation_input_tokens: 336_010,
      cache_creation: {
        ephemeral_5m_input_tokens: 0,
        ephemeral_1h_input_tokens: 336_010,
      },
      service_tier: 'standard',
      inference_geo: 'global',
    });
  });
});

describe('AnthropicAdapter non-streaming usage metadata', () => {
  const request = {
    model: 'claude-fable-5',
    messages: [{ role: 'user', content: 'hi' } as any],
    maxTokens: 100,
  } as any;

  function adapterReturning(usage: Record<string, unknown>) {
    const adapter = new AnthropicAdapter({ apiKey: 'sk-test', cacheKeepalive: { enabled: false } });
    (adapter as any).client = {
      messages: {
        create: async () => ({
          id: 'msg_1',
          model: 'claude-fable-5',
          content: [{ type: 'text', text: 'done' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage,
        }),
      },
    };
    return adapter;
  }

  it('carries the 1-hour share of cache writes into normalized usage', async () => {
    const response = await adapterReturning({
      input_tokens: 2,
      output_tokens: 10,
      cache_creation_input_tokens: 5_000,
      cache_read_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 1_000, ephemeral_1h_input_tokens: 4_000 },
    }).complete(request);
    expect(response.usage).toMatchObject({ cacheCreationTokens: 5_000, cacheCreation1hTokens: 4_000 });
  });

  it('leaves the split unknown when the provider reports no breakdown', async () => {
    const response = await adapterReturning({
      input_tokens: 2,
      output_tokens: 10,
      cache_creation_input_tokens: 5_000,
      cache_read_input_tokens: 0,
    }).complete(request);
    expect(response.usage.cacheCreationTokens).toBe(5_000);
    expect('cacheCreation1hTokens' in response.usage).toBe(false);
  });
});
