/**
 * Unit coverage for audio pass-through in the NativeFormatter.
 *
 * The formatter used to treat `audio` as unsupported media (throwing under the
 * default `unsupportedMedia: 'error'`), which meant audio never reached the
 * provider adapters even though Gemini (inlineData) and OpenRouter (input_audio)
 * can convert it. Audio blocks now pass through in the same shape as images:
 * `{ type: 'audio', source: { type: 'base64', media_type, data } }` — the
 * snake_case `media_type` the providers read (with camelCase fallback).
 * Documents remain unsupported media (error/strip as configured).
 */
import { describe, it, expect, vi } from 'vitest';
import { NativeFormatter } from '../../src/formatters/native.js';
import type { NormalizedMessage } from '../../src/types/index.js';

const buildOptions = {
  participantMode: 'simple' as const,
  assistantParticipant: 'Claude',
  humanParticipant: 'Human',
};

describe('NativeFormatter audio pass-through', () => {
  it('passes an audio block through intact alongside text, order preserved', () => {
    const formatter = new NativeFormatter();
    const messages: NormalizedMessage[] = [
      {
        participant: 'Human',
        content: [
          { type: 'text', text: 'before' },
          { type: 'audio', source: { type: 'base64', data: 'QUJDRA==', mediaType: 'audio/mp3' } },
          { type: 'text', text: 'after' },
        ],
      },
    ];

    const result = formatter.buildMessages(messages, buildOptions);

    const content = result.messages[0]?.content as any[];
    expect(content).toEqual([
      { type: 'text', text: 'before' },
      { type: 'audio', source: { type: 'base64', media_type: 'audio/mp3', data: 'QUJDRA==' } },
      { type: 'text', text: 'after' },
    ]);
  });

  it('does not throw for audio under the default unsupportedMedia: error config', () => {
    const formatter = new NativeFormatter(); // default: unsupportedMedia 'error'
    const messages: NormalizedMessage[] = [
      {
        participant: 'Human',
        content: [
          { type: 'audio', source: { type: 'base64', data: 'QUJDRA==', mediaType: 'audio/wav' } },
        ],
      },
    ];

    expect(() => formatter.buildMessages(messages, buildOptions)).not.toThrow();
  });

  it('still errors on document blocks (regression guard)', () => {
    const formatter = new NativeFormatter(); // default: unsupportedMedia 'error'
    const messages: NormalizedMessage[] = [
      {
        participant: 'Human',
        content: [
          { type: 'text', text: 'see attached' },
          { type: 'document', source: { type: 'base64', data: 'UERGAA==', mediaType: 'application/pdf' } },
        ],
      },
    ];

    expect(() => formatter.buildMessages(messages, buildOptions)).toThrow(/unsupported media/);
  });

  it('strip mode still strips documents but passes audio through', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const formatter = new NativeFormatter({ unsupportedMedia: 'strip' });
    const messages: NormalizedMessage[] = [
      {
        participant: 'Human',
        content: [
          { type: 'audio', source: { type: 'base64', data: 'QUJDRA==', mediaType: 'audio/mp3' } },
          { type: 'document', source: { type: 'base64', data: 'UERGAA==', mediaType: 'application/pdf' } },
          { type: 'text', text: 'hello' },
        ],
      },
    ];

    const result = formatter.buildMessages(messages, buildOptions);

    const content = result.messages[0]?.content as any[];
    expect(content.some((b) => b.type === 'audio')).toBe(true);
    expect(content.some((b) => b.type === 'document')).toBe(false);
    expect(content.some((b) => b.type === 'text' && b.text === 'hello')).toBe(true);
    // The strip warning fires for the document, not the audio
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Stripped unsupported media'));
    warn.mockRestore();
  });
});
