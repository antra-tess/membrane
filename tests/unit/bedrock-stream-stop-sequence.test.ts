/**
 * Regression test: the Bedrock streaming adapter must surface WHICH stop
 * sequence fired, not just that stop_reason was 'stop_sequence'.
 *
 * Dropping delta.stop_sequence broke prefill/XML tool use on Bedrock
 * entirely: membrane's tool gate matches stopSequence === '</function_calls>',
 * so tool calls were never parsed or executed, the harness never restored the
 * close tag, and the turn continuation looped forever on the dangling block
 * (~6 output tokens per full-prefill round — observed live on Ash,
 * 2026-07-26: 43 consecutive 172k-token retries).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { BedrockAdapter } from '../../src/providers/bedrock.js';
import { chunkFrame, streamBody } from '../helpers/bedrock-event-stream.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BedrockAdapter streaming stop_sequence', () => {
  it('surfaces which stop sequence fired (tool-gate contract)', async () => {
    const frames = [
      chunkFrame({ type: 'message_start', message: { usage: { input_tokens: 100 } } }),
      chunkFrame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      chunkFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '<function_calls>\n<invoke name="ping"/>\n' } }),
      chunkFrame({ type: 'content_block_stop', index: 0 }),
      chunkFrame({
        type: 'message_delta',
        delta: { stop_reason: 'stop_sequence', stop_sequence: '</function_calls>' },
        usage: { output_tokens: 12 },
      }),
      chunkFrame({ type: 'message_stop' }),
    ];

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      body: streamBody(frames),
    })));

    const adapter = new BedrockAdapter({
      accessKeyId: 'test-key',
      secretAccessKey: 'test-secret',
      region: 'ap-southeast-1',
    });

    const result = await adapter.stream(
      {
        model: 'apac.anthropic.claude-3-5-sonnet-20241022-v2:0',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 100,
        stopSequences: ['</function_calls>'],
      } as any,
      { onChunk: () => {} }
    );

    expect(result.stopReason).toBe('stop_sequence');
    // The contract the tool loop depends on:
    expect(result.stopSequence).toBe('</function_calls>');
    expect(result.usage.outputTokens).toBe(12);
  });

  it('leaves stopSequence undefined on end_turn', async () => {
    const frames = [
      chunkFrame({ type: 'message_start', message: { usage: { input_tokens: 10 } } }),
      chunkFrame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      chunkFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } }),
      chunkFrame({ type: 'content_block_stop', index: 0 }),
      chunkFrame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }),
      chunkFrame({ type: 'message_stop' }),
    ];

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      body: streamBody(frames),
    })));

    const adapter = new BedrockAdapter({
      accessKeyId: 'test-key',
      secretAccessKey: 'test-secret',
      region: 'ap-southeast-1',
    });

    const result = await adapter.stream(
      {
        model: 'apac.anthropic.claude-3-5-sonnet-20241022-v2:0',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 100,
      } as any,
      { onChunk: () => {} }
    );

    expect(result.stopReason).toBe('end_turn');
    expect(result.stopSequence).toBeUndefined();
  });
});
