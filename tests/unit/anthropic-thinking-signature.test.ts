/**
 * Regression test for Bug C: thinking-block signatures must round-trip
 * through the Anthropic adapter.
 *
 * Coverage:
 *   - Inbound streaming path: signature_delta events are accumulated onto
 *     contentBlocks[idx].signature during for-await on the SSE stream.
 *   - Inbound non-streaming path: fromAnthropicContent captures signature.
 *   - Outbound path: toAnthropicContent emits signature when present, and
 *     leaves out a thinking block with none (#191).
 *   - Request path: the Anthropic and Bedrock adapters leave out a thinking
 *     block with no signature, another provider's reasoning the API refuses,
 *     and report it (#191).
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
import { BedrockAdapter } from '../../src/providers/bedrock.js';
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

  // The API refuses a thinking block with no signature ("signature: Field
  // required") and one with an empty or made-up signature ("Invalid
  // `signature` in `thinking` block"), so another provider's reasoning has no
  // thinking form here, and as text the model would read it as what it said
  // (#191).
  it('leaves out a thinking block with no signature', () => {
    const out = toAnthropicContent([
      { type: 'thinking', thinking: 'no sig' },
      { type: 'text', text: 'answer' },
    ]);
    expect(out).toEqual([{ type: 'text', text: 'answer' }]);
  });

  it('leaves out a thinking block whose signature is empty', () => {
    const out = toAnthropicContent([
      { type: 'thinking', thinking: 'empty sig', signature: '' },
      { type: 'text', text: 'answer' },
    ]);
    expect(out).toEqual([{ type: 'text', text: 'answer' }]);
  });

  it('leaves a turn of only a thinking block with no signature empty, for the caller to drop', () => {
    expect(toAnthropicContent([{ type: 'thinking', thinking: 'no sig' }])).toEqual([]);
  });

  it('keeps a signature-only block, Anthropic\'s own with its thinking omitted', () => {
    const out = toAnthropicContent([{ type: 'thinking', thinking: '', signature: 'sig-only' }]);
    expect(out).toEqual([{ type: 'thinking', thinking: '', signature: 'sig-only' }]);
  });
});

// ---------------------------------------------------------------------------
// 3b. Request path — the adapters' own builders (#191)
// ---------------------------------------------------------------------------

/** A history whose assistant turn holds `blocks`, between two user turns. */
function history(blocks: unknown[]) {
  return {
    model: 'claude-haiku-4-5',
    maxTokens: 64,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Say hello.' }] },
      { role: 'assistant', content: blocks },
      { role: 'user', content: [{ type: 'text', text: 'Again?' }] },
    ],
  };
}

const UNSIGNED = { type: 'thinking', thinking: 'another provider\'s reasoning' };
const SIGNED = { type: 'thinking', thinking: 'mine', signature: 'sig-own' };
const SIGNATURE_ONLY = { type: 'thinking', thinking: '', signature: 'sig-only' };
const ANSWER = { type: 'text', text: 'Hello!' };

const builders: Array<[string, (request: unknown, onAltered: (block?: unknown) => void) => any]> = [
  ['AnthropicAdapter', (request, onAltered) =>
    (new AnthropicAdapter({ apiKey: 'test', cacheKeepalive: { enabled: false } }) as any).buildRequest(request, onAltered)],
  ['BedrockAdapter', (request, onAltered) =>
    (new BedrockAdapter({ accessKeyId: 'test-key', secretAccessKey: 'test-secret', region: 'us-west-2' }) as any)
      .buildRequest(request, undefined, onAltered)],
];

describe.each(builders)('%s request: a thinking block with no signature', (_name, build) => {
  it('is left out of its turn and reported, its signed siblings kept', () => {
    const heard: unknown[] = [];
    const built = build(history([UNSIGNED, SIGNED, SIGNATURE_ONLY, ANSWER]), (block) => heard.push(block));

    expect(built.messages[1].content).toEqual([SIGNED, SIGNATURE_ONLY, ANSWER]);
    // The report names the caller's own block, which Membrane's round report
    // finds by identity (utils/fidelity.ts).
    expect(heard).toHaveLength(1);
    expect(heard[0]).toBe(UNSIGNED);
  });

  it('with an empty signature is left out and reported too', () => {
    const heard: unknown[] = [];
    const empty = { ...UNSIGNED, signature: '' };
    const built = build(history([empty, ANSWER]), (block) => heard.push(block));

    expect(built.messages[1].content).toEqual([ANSWER]);
    expect(heard).toHaveLength(1);
    expect(heard[0]).toBe(empty);
  });

  it('that was its turn\'s only block leaves no empty assistant turn', () => {
    const heard: unknown[] = [];
    const built = build(history([UNSIGNED]), (block) => heard.push(block));

    expect(built.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'user']);
    expect(heard).toContain(UNSIGNED);
  });

  it('that was the final assistant turn\'s only block is refused, as an emptied final turn is', () => {
    // Dropping the turn would make a continuation a fresh reply, which the
    // empty-turn cleanup refuses (utils/empty-text.ts).
    const heard: unknown[] = [];
    const final = { ...history([UNSIGNED]), messages: history([UNSIGNED]).messages.slice(0, 2) };

    expect(() => build(final, (block) => heard.push(block))).toThrow("would change the request's final role to user");
    expect(heard).toContain(UNSIGNED);
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
