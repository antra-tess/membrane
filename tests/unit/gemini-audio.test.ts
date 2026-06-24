/**
 * Unit coverage for audio input in the Gemini provider.
 *
 * The provider routes `audio` blocks via inlineData (same mechanism as images).
 * This is provider-level plumbing only — which models actually accept/understand
 * audio is the caller's concern, not membrane's. These assert that an `audio`
 * block becomes an inlineData part in the outgoing request, captured via the
 * `onRequest` hook so no network call is made. Image path checked as a regression.
 */
import { describe, it, expect } from 'vitest';
import { GeminiAdapter } from '../../src/providers/gemini.js';

/** Build the outgoing Gemini request for `content`, captured before fetch. */
async function buildRequest(content: unknown[]): Promise<any> {
  const adapter = new GeminiAdapter({ apiKey: 'test-key-not-used' });
  let captured: any;
  try {
    await adapter.complete(
      { model: 'gemini-2.5-flash', maxTokens: 64, messages: [{ role: 'user', content }] } as any,
      { onRequest: (r: any) => { captured = r; throw new Error('__ABORT_BEFORE_FETCH__'); } } as any,
    );
  } catch (e: any) {
    if (!String(e?.message).includes('__ABORT_BEFORE_FETCH__')) throw e;
  }
  return captured;
}

describe('GeminiAdapter audio input', () => {
  it('converts an audio block to an inlineData part', async () => {
    const req = await buildRequest([
      { type: 'audio', source: { type: 'base64', data: 'QUJDRA==', mediaType: 'audio/mp3' } },
      { type: 'text', text: 'describe' },
    ]);
    expect(req.contents[0].parts).toContainEqual({
      inlineData: { mimeType: 'audio/mp3', data: 'QUJDRA==' },
    });
  });

  it('accepts the snake_case media_type field too', async () => {
    const req = await buildRequest([
      { type: 'audio', source: { type: 'base64', data: 'QUJDRA==', media_type: 'audio/wav' } },
    ]);
    expect(req.contents[0].parts).toContainEqual({
      inlineData: { mimeType: 'audio/wav', data: 'QUJDRA==' },
    });
  });

  it('falls back to audio/mpeg when no MIME is given', async () => {
    const req = await buildRequest([
      { type: 'audio', source: { type: 'base64', data: 'QUJDRA==' } },
    ]);
    expect(req.contents[0].parts).toContainEqual({
      inlineData: { mimeType: 'audio/mpeg', data: 'QUJDRA==' },
    });
  });

  it('still converts image blocks (regression)', async () => {
    const req = await buildRequest([
      { type: 'image', source: { type: 'base64', data: 'SU1HAA==', media_type: 'image/png' } },
    ]);
    expect(req.contents[0].parts).toContainEqual({
      inlineData: { mimeType: 'image/png', data: 'SU1HAA==' },
    });
  });
});
