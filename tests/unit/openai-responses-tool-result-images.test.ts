import { describe, expect, it } from 'vitest';
import { OpenAIResponsesFormatter } from '../../src/formatters/openai-responses.js';
import { normalizeResponsesInput, responsesToolOutput } from '../../src/providers/responses-input.js';

const options = {
  participantMode: 'multiuser' as const,
  assistantParticipant: 'Agent',
  systemPrompt: 'sys',
};

const png = { type: 'base64' as const, mediaType: 'image/png', data: 'iVBORw0KGgo=' };

describe('tool results carrying images (Responses)', () => {
  it('formatter emits native input_text/input_image parts, not base64-as-text', () => {
    const formatter = new OpenAIResponsesFormatter();
    const result = formatter.buildMessages([
      { participant: 'Agent', content: [{ type: 'tool_use', id: 'call_1', name: 'snapshot', input: {} }] },
      {
        participant: 'user',
        content: [{
          type: 'tool_result', toolUseId: 'call_1',
          content: [{ type: 'text', text: 'first-person view' }, { type: 'image', source: png }],
        }],
      },
    ] as any, options);

    const output = (result.messages as any[]).find((m) => m.type === 'function_call_output');
    expect(output).toEqual({
      type: 'function_call_output',
      call_id: 'call_1',
      output: [
        { type: 'input_text', text: 'first-person view' },
        { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=' },
      ],
    });
  });

  it('formatter keeps the legacy string form for image-free array content', () => {
    const formatter = new OpenAIResponsesFormatter();
    const content = [{ type: 'text', text: 'just text' }];
    const result = formatter.buildMessages([
      { participant: 'Agent', content: [{ type: 'tool_use', id: 'call_2', name: 'look', input: {} }] },
      { participant: 'user', content: [{ type: 'tool_result', toolUseId: 'call_2', content }] },
    ] as any, options);
    const output = (result.messages as any[]).find((m) => m.type === 'function_call_output');
    expect(output.output).toBe(JSON.stringify(content));
  });

  it('subscription normalizer converts normalized tool_result images the same way', () => {
    const items = normalizeResponsesInput([
      {
        role: 'user',
        content: [{
          type: 'tool_result', toolUseId: 'call_3',
          content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } }],
        }],
      },
      { type: 'function_call', call_id: 'call_3', name: 'shot', arguments: '{}' },
    ] as any);
    expect(items).toEqual([{
      type: 'function_call_output',
      call_id: 'call_3',
      output: [{ type: 'input_image', image_url: 'https://example.com/a.png' }],
    }, { type: 'function_call', call_id: 'call_3', name: 'shot', arguments: '{}' }]);
  });

  it('helper: the string form for strings and image-free arrays; placeholder for unusable image sources', () => {
    expect(responsesToolOutput('plain')).toEqual({ output: 'plain', loses: false });
    expect(responsesToolOutput([{ type: 'text', text: 'x' }])).toEqual({ output: '[{"type":"text","text":"x"}]', loses: false });
    expect(responsesToolOutput([
      { type: 'image', source: { type: 'file', path: '/tmp/x.png' } },
      { type: 'image', source: png },
      { type: 'other', value: 1 },
    ])).toEqual({
      output: [
        { type: 'input_text', text: "[system: an image in this tool result was NOT shown to you. This request couldn't carry it, so you are not seeing it.]" },
        { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=' },
        { type: 'input_text', text: '{"type":"other","value":1}' },
      ],
      loses: true,
    });
  });

  it('helper: the same stand-in, which names no cause, for an empty URL and for base64 outside the source; empty base64 data in a source is decided, and gets the note that it came without its data', () => {
    const standIn = { type: 'input_text', text: "[system: an image in this tool result was NOT shown to you. This request couldn't carry it, so you are not seeing it.]" };
    expect(responsesToolOutput([
      { type: 'image', source: { type: 'base64', data: '', mediaType: 'image/png' } },
      { type: 'image', source: { type: 'url', url: '' } },
      { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
    ])).toEqual({
      output: [
        { type: 'input_text', text: expect.stringContaining('it came without its data') },
        standIn,
        standIn,
      ],
      loses: true,
    });
  });
});
