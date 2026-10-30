import { describe, expect, it } from 'vitest';
import { OpenAIResponsesFormatter } from '../../src/formatters/openai-responses.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { FidelityNotes } from '../../src/utils/fidelity.js';

const options = {
  participantMode: 'multiuser' as const,
  assistantParticipant: 'Agent',
  systemPrompt: 'sys',
};
const png = { type: 'base64' as const, mediaType: 'image/png', data: 'iVBORw0KGgo=' };
const call = (id: string) => ({ type: 'tool_use', id, name: 'read_file', input: { path: 'notes.txt' } });
const result = (id: string, content: unknown = 'notes: the meeting is at noon.', isError?: boolean) =>
  ({ type: 'tool_result', toolUseId: id, content, ...(isError ? { isError } : {}) });
const user = (text: string) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });

function build(messages: unknown[]) {
  const fidelity = new FidelityNotes();
  const built = new OpenAIResponsesFormatter().buildMessages(messages as any, { ...options, fidelity } as any);
  return { items: built.messages as any[], altered: [...fidelity.altered] };
}

describe('Responses: a tool result whose call no input item carries', () => {
  it('goes out as user text in its place among its message\'s blocks, labelled as the native formatter labels one', () => {
    const { items } = build([
      { participant: 'User', content: [{ type: 'text', text: 'Before.' }, result('call_9'), { type: 'text', text: 'After.' }] },
    ]);
    expect(items).toEqual([
      user('Before.'),
      user('[orphan tool_result for call_9]: notes: the meeting is at noon.'),
      user('After.'),
    ]);
  });

  it('reports each conversion against its own message', () => {
    const { altered } = build([
      { participant: 'User', content: [{ type: 'text', text: 'Please read both.' }] },
      { participant: 'User', content: [result('call_8')] },
      { participant: 'Agent', content: [{ type: 'text', text: 'Reading.' }] },
      { participant: 'User', content: [result('call_9')] },
    ]);
    expect(altered).toEqual([1, 3]);
  });

  it('labels an error, and renders a list of blocks as the native formatter renders it, an image as its note', () => {
    const { items } = build([
      { participant: 'User', content: [result('call_9', [{ type: 'text', text: 'line one' }, { type: 'text', text: 'line two' }], true)] },
      { participant: 'User', content: [result('call_8', [{ type: 'text', text: 'first-person view' }, { type: 'image', source: png }])] },
    ]);
    expect(items[0]).toEqual(user('[orphan tool_result for call_9, an error]: line one\nline two'));
    expect(items[1]).toEqual(user('[orphan tool_result for call_8]: first-person view\n[Image: image/png, ~0KB, not shown to you]'));
  });

  it('renders each kind of image as the native formatter renders it in an orphan', () => {
    const kinds = [
      { type: 'image', source: { type: 'url', url: 'data:image/png;base64,iVBORw0KGgo=' } },
      { type: 'image', source: { type: 'url', url: 'https://example.com/view.png' } },
      { type: 'image', source: { type: 'base64', mediaType: 'image/jpeg', data: 'iVBORw0KGgo=' } },
      { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
    ];
    for (const image of kinds) {
      const messages = [{ participant: 'User', content: [result('call_9', [{ type: 'text', text: 'view' }, image])] }];
      const responses = build(messages).items[0].content[0].text as string;
      const native = new NativeFormatter().buildMessages(messages as any, options as any).messages as any[];
      const nativeText = native.flatMap((m) => m.content).find((b: any) => b.type === 'text' && b.text.startsWith('[orphan tool_result for call_9]')).text;
      expect(responses).toBe(nativeText);
    }
  });

  it('is sent as before when its call is anywhere in the input, before or after it', () => {
    const { items, altered } = build([
      { participant: 'User', content: [result('call_1')] },
      { participant: 'Agent', content: [call('call_1')] },
      { participant: 'Agent', content: [call('call_2')] },
      { participant: 'User', content: [result('call_2')] },
    ]);
    const sent = (id: string) => ({ type: 'function_call_output', call_id: id, output: 'notes: the meeting is at noon.' });
    const called = (id: string) => ({ type: 'function_call', call_id: id, name: 'read_file', arguments: '{"path":"notes.txt"}' });
    expect(items).toEqual([sent('call_1'), called('call_1'), called('call_2'), sent('call_2')]);
    expect(altered).toEqual([]);
  });

  it('leaves a paired result as it is beside a call-less one', () => {
    const { items, altered } = build([
      { participant: 'Agent', content: [call('call_1')] },
      { participant: 'User', content: [result('call_1'), result('call_9')] },
    ]);
    expect(items).toEqual([
      { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"notes.txt"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'notes: the meeting is at noon.' },
      user('[orphan tool_result for call_9]: notes: the meeting is at noon.'),
    ]);
    expect(altered).toEqual([1]);
  });

  it('pairs with a call carried as a native item, on a block or in a message, of any call type', () => {
    const native = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file', arguments: '{}' };
    const custom = { type: 'custom_tool_call', id: 'ctc_3', call_id: 'call_3', name: 'shell', input: 'ls' };
    const { items } = build([
      { participant: 'Agent', content: [{ ...call('call_1'), rawItem: native }] },
      { participant: 'Agent', content: [], metadata: { openaiResponsesItems: [{ ...native, id: 'fc_2', call_id: 'call_2' }, custom] } },
      { participant: 'User', content: [result('call_1'), result('call_2'), result('call_3')] },
    ]);
    expect(items.filter((item) => item.type === 'function_call_output').map((item) => item.call_id)).toEqual(['call_1', 'call_2', 'call_3']);
  });

  it('leaves native outputs as they are, on a block or in a message, and pairs nothing with one', () => {
    const onBlock = { type: 'function_call_output', call_id: 'call_9', output: 'carried' };
    const inMessage = { type: 'function_call_output', call_id: 'call_9', output: 'carried too' };
    const { items } = build([
      { participant: 'User', content: [{ ...result('call_9'), rawItem: onBlock }] },
      { participant: 'User', content: [], metadata: { openaiResponsesItems: [inMessage] } },
      { participant: 'User', content: [result('call_9')] },
    ]);
    expect(items).toEqual([onBlock, inMessage, user('[orphan tool_result for call_9]: notes: the meeting is at noon.')]);
  });
});
