/** The API doesn't cache a cache-marked empty text block. */
import { describe, expect, it } from 'vitest';
import { NativeFormatter, withoutEmptySystemText } from '../../src/formatters/native.js';
import { Membrane } from '../../src/membrane.js';
import { MockAdapter } from '../../src/providers/mock.js';
import type { ContentBlock, NormalizedMessage } from '../../src/types/index.js';

const MESSAGES: NormalizedMessage[] = [{ participant: 'User', content: [{ type: 'text', text: 'hello' }] }];

function systemOf(systemPrompt: string | ContentBlock[] | undefined): unknown {
  return new NativeFormatter().buildMessages(MESSAGES, {
    participantMode: 'multiuser',
    assistantParticipant: 'Claude',
    promptCaching: true,
    systemPrompt,
  }).systemContent;
}

describe('native formatter: empty system prompt', () => {
  it("sends no system block for ''", () => {
    expect(systemOf('')).toBeUndefined();
  });

  it('still puts the fallback marker on a non-empty prompt', () => {
    expect(systemOf('be brief')).toEqual([
      { type: 'text', text: 'be brief', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('drops empty text blocks from an array, then marks the last block left', () => {
    expect(systemOf([
      { type: 'text', text: 'first' },
      { type: 'text', text: '' },
    ])).toEqual([{ type: 'text', text: 'first', cache_control: { type: 'ephemeral' } }]);
    expect(systemOf([{ type: 'text', text: '' }])).toBeUndefined();
  });

  it('withoutEmptySystemText keeps whitespace and non-text blocks as they are', () => {
    expect(withoutEmptySystemText('\n')).toBe('\n');
    expect(withoutEmptySystemText(undefined)).toBeUndefined();
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } } as ContentBlock;
    expect(withoutEmptySystemText([image])).toEqual([image]);
  });

  it("an empty prompt reaches the provider request with no system field", async () => {
    const adapter = new MockAdapter();
    adapter.queueResponse('ok');
    let raw: { system?: unknown } | null = null;
    await new Membrane(adapter, { formatter: new NativeFormatter() }).complete(
      { messages: MESSAGES, system: '', config: { model: 'mock', maxTokens: 16 } },
      { onRequest: (req) => { raw = req as { system?: unknown }; } },
    );
    expect(raw).not.toBeNull();
    expect(raw!.system).toBeUndefined();
  });
});
