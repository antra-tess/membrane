import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIResponsesFormatter } from '../../src/formatters/openai-responses.js';
import { normalizeResponsesInput } from '../../src/providers/responses-input.js';
import { OpenAIResponsesAPIAdapter } from '../../src/providers/openai-responses-api.js';
import { FidelityNotes } from '../../src/utils/fidelity.js';

afterEach(() => { vi.unstubAllGlobals(); });

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

  it('keeps the first of one native output object carried twice for its call, on blocks or in messages, and reports where the second was', () => {
    const output = { type: 'function_call_output', call_id: 'call_1', output: 'carried' };
    for (const messages of [
      [
        { participant: 'Agent', content: [call('call_1')] },
        { participant: 'User', content: [], metadata: { openaiResponsesItems: [output] } },
        { participant: 'User', content: [], metadata: { openaiResponsesItems: [output] } },
      ],
      [
        { participant: 'Agent', content: [call('call_1')] },
        { participant: 'User', content: [{ ...result('call_1'), rawItem: output }] },
        { participant: 'User', content: [{ ...result('call_1'), rawItem: output }] },
      ],
    ]) {
      const { items, altered, events } = build(messages);
      expect(items).toEqual([called('call_1'), output]);
      expect(altered).toEqual([2]);
      expect(events).toEqual([{ kind: 'stray_tool_result_dropped', toolUseId: 'call_1', reason: 'answered' }]);
    }
  });

  it('reports each message that carried one call-less native output object', () => {
    const output = { type: 'function_call_output', call_id: 'call_9', output: 'carried' };
    const { items, altered } = build([
      { participant: 'User', content: [{ type: 'text', text: 'Before.' }] },
      { participant: 'User', content: [], metadata: { openaiResponsesItems: [output] } },
      { participant: 'User', content: [], metadata: { openaiResponsesItems: [output] } },
    ]);
    expect(items).toEqual([user('Before.')]);
    expect(altered).toEqual([1, 2]);
  });

  it('sends an output for each call that reuses an id, and leaves out one more than the calls', () => {
    const { items, events } = build([
      { participant: 'Agent', content: [call('call_1')] },
      { participant: 'User', content: [result('call_1', 'first')] },
      { participant: 'Agent', content: [call('call_1')] },
      { participant: 'User', content: [result('call_1', 'second'), result('call_1', 'third')] },
    ]);
    expect(items.filter((item) => item.type === 'function_call_output').map((item) => item.output)).toEqual(['first', 'second']);
    expect(events).toEqual([{ kind: 'stray_tool_result_dropped', toolUseId: 'call_1', reason: 'answered' }]);
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

describe('the subscription adapter\'s own conversion of messages in normalized form', () => {
  const wireCall = (id: string) => ({ type: 'tool_use', id, name: 'read_file', input: { path: 'notes.txt' } });
  const wireResult = (id: string, content = 'notes: the meeting is at noon.') => ({ type: 'tool_result', tool_use_id: id, content });

  it('leaves out a tool_result whose call no input item carries, and a second for an answered call, telling onDropped the block each came from', () => {
    const orphan = wireResult('call_9', 'zz-orphan');
    const again = wireResult('call_1', 'zz-again');
    const standalone = { type: 'function_call_output', call_id: 'call_7', output: 'zz-standalone' };
    const heard: unknown[] = [];
    const items = normalizeResponsesInput([
      { role: 'user', content: [{ type: 'text', text: 'Read it.' }] },
      { role: 'assistant', content: [wireCall('call_1')] },
      { role: 'user', content: [wireResult('call_1'), again, orphan] },
      standalone,
    ] as any, (block) => heard.push(block));
    expect(items.map((item: any) => item.type)).toEqual(['message', 'function_call', 'function_call_output']);
    expect((items[2] as any).call_id).toBe('call_1');
    expect(JSON.stringify(items)).not.toContain('zz-');
    expect(heard).toEqual([again, orphan, standalone]);
  });

  it('keeps the first of one output object handed in twice for its call, and leaves out one more than the calls that reuse an id', () => {
    const standalone = { type: 'function_call_output', call_id: 'call_1', output: 'zz-standalone' };
    const heard: unknown[] = [];
    const items = normalizeResponsesInput([
      { role: 'assistant', content: [wireCall('call_1')] },
      standalone,
      standalone,
      { role: 'assistant', content: [wireCall('call_2')] },
      { role: 'user', content: [wireResult('call_2', 'zz-first')] },
      { role: 'assistant', content: [wireCall('call_2')] },
      { role: 'user', content: [wireResult('call_2', 'zz-second')] },
    ] as any, (block) => heard.push(block));
    expect(items.map((item: any) => item.type)).toEqual(['function_call', 'function_call_output', 'function_call', 'function_call_output', 'function_call', 'function_call_output']);
    expect(items.filter((item: any) => item.type === 'function_call_output').map((item: any) => item.output)).toEqual(['zz-standalone', 'zz-first', 'zz-second']);
    expect(heard).toEqual([standalone]);
  });

  it('leaves out an output that names no call though a call names none either', () => {
    const nameless = { type: 'tool_result', content: 'zz-nameless' };
    const heard: unknown[] = [];
    const items = normalizeResponsesInput([
      { role: 'assistant', content: [{ type: 'tool_use', name: 'read_file', input: {} }] },
      { role: 'user', content: [nameless] },
    ] as any, (block) => heard.push(block));
    expect(items.map((item: any) => item.type)).toEqual(['function_call']);
    expect(heard).toEqual([nameless]);
  });

  it('keeps an output whose call is anywhere in the input, and sends nothing else differently', () => {
    const heard: unknown[] = [];
    const items = normalizeResponsesInput([
      { role: 'user', content: [wireResult('call_1')] },
      { role: 'assistant', content: [wireCall('call_1')] },
    ] as any, (block) => heard.push(block));
    expect(items.map((item: any) => item.type)).toEqual(['function_call_output', 'function_call']);
    expect(heard).toEqual([]);
  });

  it('sends the request without it, and onContentAltered hears the block the host handed in', async () => {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response('', { status: 500 });
    }));
    const orphan = wireResult('call_9', 'zz-orphan');
    const heard: unknown[] = [];
    await new OpenAIResponsesAPIAdapter({ mode: 'subscription', credentials: async () => ({ token: 'zz-token' }) }).complete({
      model: 'gpt-5.4', maxTokens: 32,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Read it.' }, orphan] }],
    } as any, { onContentAltered: (block) => heard.push(block) }).catch(() => undefined);
    expect(bodies.length).toBeGreaterThan(0);
    expect(JSON.stringify(bodies[0].input)).not.toContain('zz-orphan');
    expect(bodies[0].input.some((item: any) => item.type === 'function_call_output')).toBe(false);
    expect(heard).toContain(orphan);
  });
});

describe('Responses: a local shell output, and a call id used again', () => {
  const shellCall = { type: 'local_shell_call', id: 'lsc_1', call_id: 'call_1', action: { type: 'exec', command: ['ls'], env: {} }, status: 'completed' };
  for (const [which, id] of [['call_id', 'call_1'], ['id', 'lsc_1']] as const) {
    it(`sends a local_shell_call_output whose id is its call's ${which}, as it has no call_id`, () => {
      const output = { type: 'local_shell_call_output', id, output: '{"output":"notes.txt"}' };
      const { items, altered, events } = build([
        { participant: 'Agent', content: [], metadata: { openaiResponsesItems: [shellCall] } },
        { participant: 'User', content: [], metadata: { openaiResponsesItems: [output] } },
      ]);
      expect(items).toEqual([shellCall, output]);
      expect(altered).toEqual([]);
      expect(events).toEqual([]);
    });
  }

  it('sends one output for a local shell call answered under each of its ids, leaving out the second', () => {
    const byCallId = { type: 'local_shell_call_output', id: 'call_1', output: '{"output":"notes.txt"}' };
    const byId = { type: 'local_shell_call_output', id: 'lsc_1', output: '{"output":"again"}' };
    const { items, events } = build([
      { participant: 'Agent', content: [], metadata: { openaiResponsesItems: [shellCall] } },
      { participant: 'User', content: [], metadata: { openaiResponsesItems: [byCallId, byId] } },
    ]);
    expect(items).toEqual([shellCall, byCallId]);
    expect(events).toEqual([{ kind: 'stray_tool_result_dropped', toolUseId: 'lsc_1', reason: 'answered' }]);
  });

  it('leaves out a local_shell_call_output whose id names no call, reporting that id', () => {
    const output = { type: 'local_shell_call_output', id: 'lsc_9', output: '{}' };
    const { items, events } = build([
      { participant: 'Agent', content: [], metadata: { openaiResponsesItems: [shellCall] } },
      { participant: 'User', content: [], metadata: { openaiResponsesItems: [output] } },
    ]);
    expect(items).toEqual([shellCall]);
    expect(events).toEqual([{ kind: 'orphan_tool_result_dropped', toolUseId: 'lsc_9' }]);
  });

  it('judges a second output for a call id by the calls before it, so an id used again keeps the later call\'s output', () => {
    const fc = (n: number) => ({ type: 'function_call', id: `fc_${n}`, call_id: 'x', name: 'read_file', arguments: '{}' });
    const out = (output: string) => ({ type: 'function_call_output', call_id: 'x', output });
    const { items, events } = build([
      { participant: 'Agent', content: [], metadata: { openaiResponsesItems: [fc(1)] } },
      { participant: 'User', content: [], metadata: { openaiResponsesItems: [out('first'), out('again')] } },
      { participant: 'Agent', content: [], metadata: { openaiResponsesItems: [fc(2)] } },
      { participant: 'User', content: [], metadata: { openaiResponsesItems: [out('second')] } },
    ]);
    expect(items).toEqual([fc(1), out('first'), fc(2), out('second')]);
    expect(events).toEqual([{ kind: 'stray_tool_result_dropped', toolUseId: 'x', reason: 'answered' }]);
  });

  it('still sends one output stored ahead of its only call', () => {
    const fc = { type: 'function_call', id: 'fc_1', call_id: 'y', name: 'read_file', arguments: '{}' };
    const out = { type: 'function_call_output', call_id: 'y', output: 'early' };
    const { items, events } = build([
      { participant: 'User', content: [], metadata: { openaiResponsesItems: [out] } },
      { participant: 'Agent', content: [], metadata: { openaiResponsesItems: [fc] } },
    ]);
    expect(items).toEqual([out, fc]);
    expect(events).toEqual([]);
  });
});
