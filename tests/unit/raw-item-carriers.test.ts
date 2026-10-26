/** The Anthropic API refuses a request that holds an empty text block, with a 400. */

import { describe, it, expect } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { OpenAIResponsesFormatter } from '../../src/formatters/openai-responses.js';
import { MockAdapter } from '../../src/providers/mock.js';
import { toAnthropicContent } from '../../src/providers/anthropic.js';
import type { NormalizedMessage, NormalizedRequest } from '../../src/types/index.js';

const compactionItem = { type: 'compaction', id: 'cmp_1', encrypted_content: 'opaque-payload' };
const customToolItem = { type: 'custom_tool_call_output', id: 'ct_1', output: 'opaque-output' };

const historyWithCarriers: NormalizedMessage[] = [
  { participant: 'User', content: [{ type: 'text', text: 'hello' }] },
  {
    participant: 'Claude',
    content: [
      { type: 'text', text: '', rawItem: compactionItem },
      { type: 'text', text: 'real answer' },
    ],
  },
  {
    participant: 'User',
    content: [
      { type: 'text', text: '', rawItem: customToolItem },
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
    const participantPrefixOnly = /^\S+: $/;
    expect(block.text).not.toMatch(participantPrefixOnly);
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

  it('are replayed verbatim as raw items by the OpenAI Responses formatter, which keeps the system prompt', () => {
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
    expect(result.systemContent).toBe('sys');
  });
});
