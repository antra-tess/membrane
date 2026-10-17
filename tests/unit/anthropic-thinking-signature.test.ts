/**
 * Regression test for Bug C: thinking-block signatures must round-trip
 * through the Anthropic adapter.
 *
 * Coverage:
 *   - Inbound streaming path: signature_delta events are accumulated onto
 *     contentBlocks[idx].signature during for-await on the SSE stream.
 *   - Inbound non-streaming path: fromAnthropicContent captures signature.
 *   - Outbound path: toAnthropicContent emits signature when present, omits
 *     it when absent.
 *
 * Background: prior to this fix, the streaming accumulator dropped
 * signature_delta events and the outbound serializer stripped the signature
 * field. End result: a thinking block authored by the model could never be
 * faithfully re-sent in history, and any session running with extended
 * thinking enabled would 400 the moment a thinking block landed in a
 * compression chunk or got re-shipped on a tool-result follow-up.
 */

import { describe, it, expect } from 'vitest';
import {
  AnthropicAdapter,
  toAnthropicContent,
  fromAnthropicContent,
} from '../../src/providers/anthropic.js';
import type { ContentBlock } from '../../src/types/index.js';

// ---------------------------------------------------------------------------
// Fake SSE stream — async iterable with the minimal surface area the adapter
// touches (Symbol.asyncIterator + .controller.abort()).
// ---------------------------------------------------------------------------

function fakeStream(events: any[]) {
  return {
    controller: { abort() { /* noop */ } },
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i < events.length) return { value: events[i++], done: false };
          return { value: undefined, done: true };
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Streaming accumulator — signature_delta lands on the thinking block
// ---------------------------------------------------------------------------

describe('AnthropicAdapter streaming: signature_delta', () => {
  it('accumulates signature_delta onto the active thinking block', async () => {
    const adapter = new AnthropicAdapter({ apiKey: 'sk-test' });

    // Replace the SDK client with a stub that returns our scripted stream.
    (adapter as any).client = {
      withOptions() { return this; },
      messages: {
        stream: async (_req: any, _opts: any) => fakeStream([
          {
            type: 'message_start',
            message: { model: 'claude-sonnet-4-5-20250929', usage: { input_tokens: 10 } },
          },
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'thinking', thinking: '' },
          },
          { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me think. ' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'About this.' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-part-A' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-part-B' } },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'text', text: '' },
          },
          { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Answer.' } },
          { type: 'content_block_stop', index: 1 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
        ]),
      },
    };

    const response = await adapter.stream(
      {
        model: 'claude-sonnet-4-5-20250929',
        messages: [{ role: 'user', content: 'hi' } as any],
        maxTokens: 100,
      } as any,
      { onChunk: () => {} },
    );

    const blocks = response.content as Array<Record<string, any>>;
    expect(blocks.length).toBe(2);

    const thinking = blocks[0];
    expect(thinking.type).toBe('thinking');
    expect(thinking.thinking).toBe('Let me think. About this.');
    expect(thinking.signature).toBe('sig-part-Asig-part-B');

    const text = blocks[1];
    expect(text.type).toBe('text');
    expect(text.text).toBe('Answer.');
  });

  it('does not break on signature_delta when no thinking block is active', async () => {
    // Defensive: stray/out-of-order signature_delta on a text block must not
    // throw or corrupt the text block. (Should not happen per protocol, but
    // we don't want to be brittle.)
    const adapter = new AnthropicAdapter({ apiKey: 'sk-test' });

    (adapter as any).client = {
      withOptions() { return this; },
      messages: {
        stream: async () => fakeStream([
          { type: 'message_start', message: { model: 'claude-x', usage: { input_tokens: 1 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'stray' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        ]),
      },
    };

    const response = await adapter.stream(
      {
        model: 'claude-x',
        messages: [{ role: 'user', content: 'hi' } as any],
        maxTokens: 10,
      } as any,
      { onChunk: () => {} },
    );

    const block = (response.content as any[])[0];
    expect(block.type).toBe('text');
    expect(block.text).toBe('hi');
    expect(block.signature).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. fromAnthropicContent — non-streaming inbound path
// ---------------------------------------------------------------------------

describe('fromAnthropicContent: thinking signature', () => {
  it('captures signature on non-streaming inbound thinking blocks', () => {
    const normalized = fromAnthropicContent([
      { type: 'thinking', thinking: 'reasoning here', signature: 'abc-123' } as any,
      { type: 'text', text: 'final answer' } as any,
    ]);

    expect(normalized.length).toBe(2);
    const thinking = normalized[0] as Extract<ContentBlock, { type: 'thinking' }>;
    expect(thinking.type).toBe('thinking');
    expect(thinking.thinking).toBe('reasoning here');
    expect(thinking.signature).toBe('abc-123');
  });
});

// ---------------------------------------------------------------------------
// 3. toAnthropicContent — outbound serialization
// ---------------------------------------------------------------------------

describe('toAnthropicContent: thinking signature', () => {
  it('emits the signature field when present', () => {
    const out = toAnthropicContent([
      { type: 'thinking', thinking: 'past reasoning', signature: 'sig-xyz' },
    ]);
    expect(out.length).toBe(1);
    const block = out[0] as any;
    expect(block.type).toBe('thinking');
    expect(block.thinking).toBe('past reasoning');
    expect(block.signature).toBe('sig-xyz');
  });

  it('omits the signature field when absent', () => {
    const out = toAnthropicContent([
      { type: 'thinking', thinking: 'no sig' },
    ]);
    const block = out[0] as any;
    expect(block.type).toBe('thinking');
    expect(block.thinking).toBe('no sig');
    expect('signature' in block).toBe(false);
  });

  it('omits the signature field when empty string', () => {
    // An empty signature is just as invalid to the API as a missing one
    // (HTTP 400 "Invalid signature in thinking block"). Don't ship it.
    const out = toAnthropicContent([
      { type: 'thinking', thinking: 'empty sig', signature: '' },
    ]);
    const block = out[0] as any;
    expect('signature' in block).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Round-trip — chain the three above
// ---------------------------------------------------------------------------

describe('Anthropic adapter: signature round-trip', () => {
  it('preserves signature from inbound through outbound', () => {
    // Simulate: API returned a thinking block with signature → normalized →
    // stored → re-serialized on the next outbound request.
    const inbound = fromAnthropicContent([
      { type: 'thinking', thinking: 'inner monologue', signature: 'sig-rt' } as any,
    ]);
    const outbound = toAnthropicContent(inbound);
    const block = outbound[0] as any;
    expect(block.signature).toBe('sig-rt');
  });
});
