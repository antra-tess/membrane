import { describe, expect, it } from 'vitest';
import { OpenAIResponsesFormatter } from '../../src/formatters/openai-responses.js';
import { normalizeResponsesInput, responsesToolOutputParts } from '../../src/providers/responses-input.js';

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
    ] as any);
    expect(items).toEqual([{
      type: 'function_call_output',
      call_id: 'call_3',
      output: [{ type: 'input_image', image_url: 'https://example.com/a.png' }],
    }]);
  });

  it('helper: null for strings and image-free arrays; placeholder for unusable image sources', () => {
    expect(responsesToolOutputParts('plain')).toBeNull();
    expect(responsesToolOutputParts([{ type: 'text', text: 'x' }])).toBeNull();
    expect(responsesToolOutputParts([
      { type: 'image', source: { type: 'file', path: '/tmp/x.png' } },
      { type: 'image', source: png },
      { type: 'other', value: 1 },
    ])).toEqual([
      { type: 'input_text', text: '[image omitted: unsupported image source]' },
      { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=' },
      { type: 'input_text', text: '{"type":"other","value":1}' },
    ]);
  });
});
