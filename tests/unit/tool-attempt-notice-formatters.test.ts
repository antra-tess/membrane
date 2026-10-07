/**
 * How the non-XML formatters carry shelf-376's two history blocks.
 *
 * `tool_attempt` is the assistant's own words (a tool-call block that
 * dispatched nothing), so it stays the assistant's text. `tool_notice` is the
 * harness speaking, so it goes on the harness side, after any tool results —
 * never as the assistant's outward speech, and never as a block type a
 * provider would see. The completions formatter's history is text-only: it
 * omits every tool carrier, these included (room-221 #41867, #41888).
 */
import { describe, expect, it } from 'vitest';
import { NativeFormatter } from '../../src/formatters/native.js';
import { OpenAIResponsesFormatter } from '../../src/formatters/openai-responses.js';
import { CompletionsFormatter } from '../../src/formatters/completions.js';
import type { ContentBlock, NormalizedMessage } from '../../src/types/index.js';

const CALLS_OPEN = '<' + 'function_calls>';
const CALLS_CLOSE = '</' + 'function_calls>';
const ATTEMPT = `${CALLS_OPEN}<invoke name="board_update"></invoke>${CALLS_CLOSE}`;
const REFUSED = { invoke: 0, toolName: 'board_update', kind: 'refused' as const, message: 'nothing was sent' };
const WARNED = { invoke: 1, toolName: 'board_update', kind: 'warning' as const, message: 'odd markup' };

const TURN: ContentBlock[] = [
  { type: 'text', text: 'Updating.' },
  { type: 'tool_attempt', rawXml: ATTEMPT },
  { type: 'tool_notice', notices: [REFUSED] },
  { type: 'text', text: 'Resending.' },
  { type: 'tool_use', id: 't1', name: 'board_update', input: { item: 'x' } },
  { type: 'tool_result', toolUseId: 't1', content: 'saved' },
  { type: 'tool_notice', notices: [WARNED] },
  { type: 'text', text: 'Done.' },
];

const MESSAGES: NormalizedMessage[] = [
  { participant: 'User', content: [{ type: 'text', text: 'Update the board.' }] },
  { participant: 'Claude', content: TURN },
];

const REFUSED_TEXT = '[tool-call notice] board_update (invoke 0, refused): nothing was sent';
const WARNED_TEXT = '[tool-call notice] board_update (invoke 1, warning): odd markup';

type Summary = Array<[string, string[]]>;

describe('native formatter', () => {
  it('keeps the attempt as assistant text and puts each notice on the harness side, after the tool result', () => {
    const built = new NativeFormatter().buildMessages(MESSAGES, {
      assistantParticipant: 'Claude',
      participantMode: 'simple',
      humanParticipant: 'User',
    });
    const summary: Summary = (built.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>).map(
      (message) => [
        message.role,
        message.content.map((block) => `${block.type}:${String(block.text ?? block.id ?? block.tool_use_id)}`),
      ],
    );

    expect(summary).toEqual([
      ['user', ['text:Update the board.']],
      ['assistant', ['text:Updating.', `text:${ATTEMPT}`]],
      ['user', [`text:${REFUSED_TEXT}`]],
      ['assistant', ['text:Resending.', 'tool_use:t1']],
      ['user', ['tool_result:t1', `text:${WARNED_TEXT}`]],
      ['assistant', ['text:Done.']],
    ]);
  });
});

describe('Responses formatter', () => {
  it('keeps the attempt as output text and sends each notice as a harness message after the call output', () => {
    const built = new OpenAIResponsesFormatter().buildMessages(MESSAGES, { assistantParticipant: 'Claude' });
    const items = built.messages as Array<Record<string, unknown>>;
    const summary = items.map((item) =>
      item.type === 'message'
        ? `${String(item.role)}:${(item.content as Array<{ text: string }>).map((part) => part.text).join('|')}`
        : String(item.type),
    );

    expect(summary).toEqual([
      'user:Update the board.',
      `assistant:Updating.|${ATTEMPT}`,
      `user:${REFUSED_TEXT}`,
      'assistant:Resending.',
      'function_call',
      'function_call_output',
      `user:${WARNED_TEXT}`,
      'assistant:Done.',
    ]);
  });
});

describe('completions formatter', () => {
  it('omits the attempt and the notices along with every other tool carrier', () => {
    const built = new CompletionsFormatter().buildMessages(MESSAGES, { assistantParticipant: 'Claude' });
    const prompt = JSON.stringify(built.messages);

    expect(prompt).toContain('Updating.\\nResending.\\nDone.');
    expect(prompt).not.toContain('function_calls');
    expect(prompt).not.toContain('tool-call notice');
    expect(prompt).not.toContain('saved');
  });
});
