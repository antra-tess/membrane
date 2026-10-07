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

describe('a carrier in a message of the wrong role keeps its speaker', () => {
  // A user-labelled message holding the assistant's attempt, and an
  // assistant-labelled one holding the harness's notice.
  const MISROLED: NormalizedMessage[] = [
    { participant: 'User', content: [{ type: 'text', text: 'Update the board.' }, { type: 'tool_attempt', rawXml: ATTEMPT }] },
    { participant: 'Claude', content: [{ type: 'text', text: 'Hmm.' }, { type: 'tool_notice', notices: [REFUSED] }] },
    { participant: 'User', content: [{ type: 'text', text: 'Again.' }] },
  ];

  it('native formatter', () => {
    const built = new NativeFormatter().buildMessages(MISROLED, {
      assistantParticipant: 'Claude',
      participantMode: 'simple',
      humanParticipant: 'User',
    });
    const summary = (built.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>).map(
      (message) => [message.role, message.content.map((block) => `${block.type}:${String(block.text)}`)],
    );
    expect(summary).toEqual([
      ['user', ['text:Update the board.']],
      ['assistant', [`text:${ATTEMPT}`, 'text:Hmm.']],
      ['user', [`text:${REFUSED_TEXT}`, 'text:Again.']],
    ]);
  });

  it('Responses formatter', () => {
    const built = new OpenAIResponsesFormatter().buildMessages(MISROLED, { assistantParticipant: 'Claude' });
    const summary = (built.messages as Array<Record<string, unknown>>).map(
      (item) => `${String(item.role)}:${(item.content as Array<{ type: string; text: string }>).map((part) => `${part.type}=${part.text}`).join('|')}`,
    );
    expect(summary).toEqual([
      'user:input_text=Update the board.',
      `assistant:output_text=${ATTEMPT}`,
      'assistant:output_text=Hmm.',
      `user:input_text=${REFUSED_TEXT}`,
      'user:input_text=Again.',
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

// ---------------------------------------------------------------------------
// Membrane's native tool loop builds its own requests (buildNativeToolRequest),
// first and on every continuation; it must carry both blocks as the formatter does.
// ---------------------------------------------------------------------------

import { Membrane } from '../../src/membrane.js';
import type { NormalizedRequest, ToolResult } from '../../src/types/index.js';
import type { ProviderAdapter, ProviderRequest, ProviderResponse } from '../../src/types/provider.js';
import type { StreamCallbacks } from '../../src/types/streaming.js';

/** Round 1 calls a native tool; round 2 ends the turn. Records every request. */
class NativeToolAdapter implements ProviderAdapter {
  readonly name = 'native-scripted';
  readonly requests: ProviderRequest[] = [];
  supportsModel(): boolean {
    return true;
  }
  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    return this.respond(request);
  }
  async stream(request: ProviderRequest, callbacks: StreamCallbacks): Promise<ProviderResponse> {
    const response = this.respond(request);
    if (response.stopReason === 'end_turn') callbacks.onChunk('Done.');
    return response;
  }
  private respond(request: ProviderRequest): ProviderResponse {
    this.requests.push(request);
    const first = this.requests.length === 1;
    return {
      content: first
        ? [{ type: 'tool_use', id: 'toolu_1', name: 'board_update', input: { item: 'x' } }]
        : [{ type: 'text', text: 'Done.' }],
      stopReason: first ? 'tool_use' : 'end_turn',
      usage: { inputTokens: 10, outputTokens: 5 },
      model: request.model,
      rawRequest: request,
      raw: {},
    };
  }
}

const NATIVE_REQUEST: NormalizedRequest = {
  messages: [
    { participant: 'User', content: [{ type: 'text', text: 'Update the board.' }] },
    { participant: 'Claude', content: TURN },
    { participant: 'User', content: [{ type: 'text', text: 'Once more.' }] },
  ],
  config: { model: 'test-model', maxTokens: 100 },
  tools: [{ name: 'board_update', description: 'Update a board item.', inputSchema: { type: 'object', properties: { item: { type: 'string' } } } }],
  toolMode: 'native',
  assistantParticipant: 'Claude',
};

/** The sent history up to the live user message, as role + block summaries. */
function sentHistory(request: ProviderRequest): Summary {
  const messages = request.messages as Array<{ role: string; content: Array<Record<string, unknown>> | string }>;
  return messages.map((message) => [
    message.role,
    (typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content).map(
      (block) => `${block.type}:${String(block.text ?? block.id ?? block.tool_use_id)}`,
    ),
  ]);
}

const EXPECTED_HISTORY: Summary = [
  ['user', ['text:User: Update the board.']],
  ['assistant', ['text:Updating.', `text:${ATTEMPT}`]],
  ['user', [`text:${REFUSED_TEXT}`]],
  ['assistant', ['text:Resending.', 'tool_use:t1']],
  ['user', ['tool_result:t1', `text:${WARNED_TEXT}`]],
  ['assistant', ['text:Done.']],
];

describe("membrane's native tool loop", () => {
  const result = (call: { id: string }): ToolResult => ({ toolUseId: call.id, content: 'saved', isError: false });

  it('callback loop: carries the attempt and the notices, on the first request and the continuation', async () => {
    const adapter = new NativeToolAdapter();
    await new Membrane(adapter).stream(NATIVE_REQUEST, { onToolCalls: async (calls) => calls.map(result) });

    expect(adapter.requests).toHaveLength(2);
    for (const sent of adapter.requests) {
      const history = sentHistory(sent);
      expect(history.slice(0, EXPECTED_HISTORY.length)).toEqual(EXPECTED_HISTORY);
      expect(JSON.stringify(sent.messages)).not.toContain('"tool_notice"');
      expect(JSON.stringify(sent.messages)).not.toContain('"tool_attempt"');
    }
  });

  it('keeps a carrier on its speaker’s side when its message has the wrong role', async () => {
    const adapter = new NativeToolAdapter();
    const misroled: NormalizedRequest = {
      ...NATIVE_REQUEST,
      messages: [
        { participant: 'User', content: [{ type: 'text', text: 'Update the board.' }, { type: 'tool_attempt', rawXml: ATTEMPT }] },
        { participant: 'Claude', content: [{ type: 'text', text: 'Hmm.' }, { type: 'tool_notice', notices: [REFUSED] }] },
        { participant: 'User', content: [{ type: 'text', text: 'Again.' }] },
      ],
    };
    await new Membrane(adapter).stream(misroled, { onToolCalls: async (calls) => calls.map(result) });

    for (const sent of adapter.requests) {
      expect(sentHistory(sent).slice(0, 3)).toEqual([
        ['user', ['text:User: Update the board.']],
        ['assistant', [`text:${ATTEMPT}`, 'text:Hmm.']],
        ['user', [`text:${REFUSED_TEXT}`, 'text:User: Again.']],
      ]);
    }
  });

  it('yielding loop: carries the attempt and the notices, on the first request and the continuation', async () => {
    const adapter = new NativeToolAdapter();
    const stream = new Membrane(adapter).streamYielding(NATIVE_REQUEST);
    for await (const event of stream) {
      if (event.type === 'tool-calls') stream.provideToolResults(event.calls.map(result));
    }

    expect(adapter.requests).toHaveLength(2);
    for (const sent of adapter.requests) {
      expect(sentHistory(sent).slice(0, EXPECTED_HISTORY.length)).toEqual(EXPECTED_HISTORY);
    }
  });
});
