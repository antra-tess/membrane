import { describe, expect, it } from 'vitest';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';

function fakeStream(events: unknown[]) {
  return {
    controller: { abort() { /* noop */ } },
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
