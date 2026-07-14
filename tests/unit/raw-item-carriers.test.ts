/**
 * Zero-width rawItem carrier blocks.
 *
 * Opaque provider-native items (e.g. OpenAI Responses compaction records or
 * custom tool records) have no normalized ContentBlock equivalent, so
 * `parseProviderContent` persists them as `{ type: 'text', text: '', rawItem }`
 * carriers. Two invariants:
 *
 *   1. Anthropic-bound conversion paths must FILTER them (and empty text
 *      blocks generally) — the Anthropic API 400s on empty text blocks, which
 *      previously produced a crash loop on provider switch. The filter must
 *      run BEFORE participant-name prefixing, which would otherwise make the
 *      carrier text non-empty and leak "Name: " junk instead.
 *
 *   2. The OpenAI Responses formatter must PRESERVE them — the rawItem is
 *      replayed verbatim as an input item.
 */

import { describe, it, expect } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { OpenAIResponsesFormatter } from '../../src/formatters/openai-responses.js';
import { MockAdapter } from '../../src/providers/mock.js';
import { toAnthropicContent } from '../../src/providers/anthropic.js';
import type { NormalizedMessage, NormalizedRequest } from '../../src/types/index.js';

const compactionItem = { type: 'compaction', id: 'cmp_1', encrypted_content: 'opaque-payload' };
const customToolItem = { type: 'custom_tool_call_output', id: 'ct_1', output: 'opaque-output' };

/** History as persisted after a Responses turn: assistant and user messages
 *  each contain a zero-width carrier next to real text. */
const historyWithCarriers: NormalizedMessage[] = [
  { participant: 'User', content: [{ type: 'text', text: 'hello' }] },
  {
    participant: 'Claude',
    content: [
      { type: 'text', text: '', rawItem: compactionItem }, // zero-width carrier
      { type: 'text', text: 'real answer' },
    ],
  },
  {
    participant: 'User',
    content: [
      { type: 'text', text: '', rawItem: customToolItem }, // zero-width carrier
      { type: 'text', text: 'next turn' },
    ],
  },
];

function textBlocksOf(providerMessages: any[]): any[] {
  return providerMessages.flatMap((msg: any) =>
    (Array.isArray(msg.content) ? msg.content : []).filter((b: any) => b?.type === 'text'));
}

function expectNoEmptyOrCarrierText(providerMessages: any[]): void {
  const texts = textBlocksOf(providerMessages);
  expect(texts.length).toBeGreaterThan(0);
  for (const block of texts) {
    expect(block.text).not.toBe('');
    // A carrier resurrected by name prefixing would surface as exactly "Name: "
    expect(block.text).not.toMatch(/^\S+: $/);
  }
  expect(JSON.stringify(providerMessages)).not.toContain('opaque-payload');
  expect(JSON.stringify(providerMessages)).not.toContain('opaque-output');
}

describe('zero-width rawItem carrier blocks', () => {
  it('never reach an Anthropic-bound request via the formatter path', async () => {
    let captured: any;
    const membrane = new Membrane(new MockAdapter({ defaultResponse: 'ok' }), {
      formatter: new NativeFormatter(),
    });

    await membrane.complete({
      messages: historyWithCarriers,
      config: { model: 'claude-haiku-4-5-20251001', maxTokens: 100 },
    }, { onRequest: (req: any) => { captured = req; } });

    expectNoEmptyOrCarrierText(captured.messages);
  });

  it('never reach an Anthropic-bound request via the native-tools path', () => {
    const membrane = new Membrane(new MockAdapter(), { formatter: new NativeFormatter() });
    const request: NormalizedRequest = {
      messages: historyWithCarriers,
      config: { model: 'claude-haiku-4-5-20251001', maxTokens: 100 },
    };

    const providerRequest = (membrane as any).buildNativeToolRequest(request, request.messages);

    expectNoEmptyOrCarrierText(providerRequest.messages);
  });

  it('are dropped by toAnthropicContent (direct sends)', () => {
    const result = toAnthropicContent([
      { type: 'text', text: '', rawItem: compactionItem },
      { type: 'text', text: 'real answer' },
    ]);

    expect(result).toEqual([{ type: 'text', text: 'real answer' }]);
  });

  it('are replayed verbatim as raw items by the OpenAI Responses formatter', () => {
    const result = new OpenAIResponsesFormatter().buildMessages(historyWithCarriers, {
      participantMode: 'multiuser',
      assistantParticipant: 'Claude',
      systemPrompt: 'sys',
    });

    expect(result.messages).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
      compactionItem,
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'real answer' }] },
      customToolItem,
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'next turn' }] },
    ]);
    // Not an imported history — the system prompt (→ `instructions`) survives.
    expect(result.systemContent).toBe('sys');
  });
});
