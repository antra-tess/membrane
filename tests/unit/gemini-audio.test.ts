import { describe, it, expect } from 'vitest';
import { GeminiAdapter } from '../../src/providers/gemini.js';

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
      { type: 'image', source: { type: 'base64', data: 'iVBORw0KGgo=', media_type: 'image/png' } },
    ]);
    expect(req.contents[0].parts).toContainEqual({
      inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' },
    });
  });

  it('labels a canonical image block (mediaType) by its own type, not as JPEG', async () => {
    const req = await buildRequest([
      { type: 'image', source: { type: 'base64', data: 'iVBORw0KGgo=', mediaType: 'image/png' } },
    ]);
    expect(req.contents[0].parts).toContainEqual({
      inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' },
    });
  });
});
