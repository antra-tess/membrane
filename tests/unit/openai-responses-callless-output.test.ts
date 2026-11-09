import { describe, expect, it } from 'vitest';
import { OpenAIResponsesFormatter } from '../../src/formatters/openai-responses.js';
import { FidelityNotes } from '../../src/utils/fidelity.js';

const options = {
  participantMode: 'multiuser' as const,
  assistantParticipant: 'Agent',
  systemPrompt: 'sys',
};
const png = { type: 'base64' as const, mediaType: 'image/png', data: 'iVBORw0KGgo=' };
const call = (id: string) => ({ type: 'tool_use', id, name: 'read_file', input: { path: 'notes.txt' } });
const result = (id: unknown, content: unknown = 'notes: the meeting is at noon.', isError?: unknown) =>
  ({ type: 'tool_result', toolUseId: id, content, ...(isError !== undefined ? { isError } : {}) });
const user = (text: string) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const called = (id: string) => ({ type: 'function_call', call_id: id, name: 'read_file', arguments: '{"path":"notes.txt"}' });
const sent = (id: string) => ({ type: 'function_call_output', call_id: id, output: 'notes: the meeting is at noon.' });

function build(messages: unknown[]) {
  const fidelity = new FidelityNotes();
  const events: unknown[] = [];
  const built = new OpenAIResponsesFormatter().buildMessages(messages as any, { ...options, fidelity, onNormalize: (event: unknown) => events.push(event) } as any);
  return { items: built.messages as any[], altered: [...fidelity.altered], events };
}

describe('Responses: a tool output whose call no input item carries', () => {
  it('is left out of its message\'s items, with nothing of it sent as text, and its message reported', () => {
    const { items, altered } = build([
      { participant: 'User', content: [{ type: 'text', text: 'Before.' }, result('call_9'), { type: 'text', text: 'After.' }] },
    ]);
    expect(items).toEqual([user('Before.'), user('After.')]);
    expect(JSON.stringify(items)).not.toContain('noon');
    expect(altered).toEqual([0]);
  });

  it('reports each one against its own message', () => {
    const { items, altered } = build([
      { participant: 'User', content: [{ type: 'text', text: 'Please read both.' }] },
      { participant: 'User', content: [result('call_8')] },
      { participant: 'Agent', content: [{ type: 'text', text: 'Reading.' }] },
      { participant: 'User', content: [result('call_9')] },
    ]);
    expect(items).toEqual([user('Please read both.'), { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Reading.' }] }]);
    expect(altered).toEqual([1, 3]);
  });

  it('is left out whatever its id, error flag or content, and from the assistant participant\'s message too', () => {
    for (const block of [
      result(123),
      result(undefined),
      result('call_9', 'it failed', true),
      result('call_9', 'payload', 1),
      result('call_9', [{ type: 'text', text: 'first-person view' }, { type: 'image', source: png }]),
    ]) {
      for (const participant of ['User', 'Agent']) {
        const { items, altered } = build([{ participant, content: [block] }]);
        expect(items).toEqual([]);
        expect(altered).toEqual([0]);
      }
    }
  });

  it('is sent as before when its call is anywhere in the input, before or after it', () => {
    const { items, altered } = build([
      { participant: 'User', content: [result('call_1')] },
      { participant: 'Agent', content: [call('call_1')] },
      { participant: 'Agent', content: [call('call_2')] },
      { participant: 'User', content: [result('call_2')] },
    ]);
    expect(items).toEqual([sent('call_1'), called('call_1'), called('call_2'), sent('call_2')]);
    expect(altered).toEqual([]);
  });

  it('leaves a paired output as it is beside a call-less one', () => {
    const { items, altered } = build([
      { participant: 'Agent', content: [call('call_1')] },
      { participant: 'User', content: [result('call_1'), result('call_9')] },
    ]);
    expect(items).toEqual([called('call_1'), sent('call_1')]);
    expect(altered).toEqual([1]);
  });

  it('leaves out a later output for a call an earlier output answered, native or converted, keeping the first in input order', () => {
    const again = { type: 'function_call_output', call_id: 'call_1', output: 'carried again' };
    const { items, altered } = build([
      { participant: 'Agent', content: [call('call_1')] },
      { participant: 'User', content: [result('call_1')] },
      { participant: 'User', content: [result('call_1', 'a second answer')] },
      { participant: 'User', content: [], metadata: { openaiResponsesItems: [again] } },
    ]);
    expect(items).toEqual([called('call_1'), sent('call_1')]);
    expect(altered).toEqual([2, 3]);
  });

  it('tells the host through onNormalize, naming the result: a call-less output as an orphan, a second output as a stray its call already answered', () => {
    const { events } = build([
      { participant: 'Agent', content: [call('call_1')] },
      { participant: 'User', content: [result('call_1'), result('call_1', 'again'), result('call_9')] },
      { participant: 'User', content: [result(42)] },
    ]);
    expect(events).toEqual([
      { kind: 'stray_tool_result_dropped', toolUseId: 'call_1', reason: 'answered' },
      { kind: 'orphan_tool_result_dropped', toolUseId: 'call_9' },
      { kind: 'orphan_tool_result_dropped', toolUseId: '<missing>' },
    ]);
  });

  it('pairs with a call carried as a native item, on a block or in a message, of any call type', () => {
    const native = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file', arguments: '{}' };
    const custom = { type: 'custom_tool_call', id: 'ctc_3', call_id: 'call_3', name: 'shell', input: 'ls' };
    const { items, altered } = build([
      { participant: 'Agent', content: [{ ...call('call_1'), rawItem: native }] },
      { participant: 'Agent', content: [], metadata: { openaiResponsesItems: [{ ...native, id: 'fc_2', call_id: 'call_2' }, custom] } },
      { participant: 'User', content: [result('call_1'), result('call_2'), result('call_3')] },
    ]);
    expect(items.filter((item) => item.type === 'function_call_output').map((item) => item.call_id)).toEqual(['call_1', 'call_2', 'call_3']);
    expect(altered).toEqual([]);
  });

  it('leaves out a native output of any _output type whose call no item carries, on a block or in a message, and reports its message', () => {
    const onBlock = { type: 'function_call_output', call_id: 'call_9', output: 'carried' };
    const inMessage = { type: 'custom_tool_call_output', call_id: 'call_9', output: 'carried too' };
    const nameless = { type: 'local_shell_call_output', id: 'lsc_1', output: 'carried, naming no call' };
    const answered = { type: 'computer_call_output', call_id: 'call_1', output: { type: 'input_image', image_url: 'https://example.com/screen.png' } };
    const { items, altered } = build([
      { participant: 'Agent', content: [call('call_1')] },
      { participant: 'User', content: [{ ...result('call_9'), rawItem: onBlock }] },
      { participant: 'User', content: [], metadata: { openaiResponsesItems: [inMessage, nameless] } },
      { participant: 'User', content: [], metadata: { openaiResponsesItems: [answered] } },
    ]);
    expect(items).toEqual([called('call_1'), answered]);
    expect(altered).toEqual([1, 2]);
  });

  it('passes a native item that isn\'t an object, or whose type isn\'t a string, through as before', () => {
    const odd = [null, { type: 42, call_id: 'call_1' }];
    const { items } = build([
      { participant: 'Agent', content: [], metadata: { openaiResponsesItems: odd } },
      { participant: 'User', content: [result('call_9')] },
    ]);
    expect(items).toEqual([null, { type: 42, call_id: 'call_1' }]);
  });
});
