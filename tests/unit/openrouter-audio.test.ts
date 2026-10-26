import { describe, it, expect, vi } from 'vitest';
import { OpenRouterAdapter } from '../../src/providers/openrouter.js';

async function buildRequest(content: unknown[]): Promise<any> {
  const adapter = new OpenRouterAdapter({ apiKey: 'test-key-not-used' });
  let captured: any;
  try {
    await adapter.complete(
      { model: 'openai/gpt-4o-audio-preview', maxTokens: 64, messages: [{ role: 'user', content }] } as any,
      { onRequest: (r: any) => { captured = r; throw new Error('__ABORT_BEFORE_FETCH__'); } } as any,
    );
  } catch (e: any) {
    if (!String(e?.message).includes('__ABORT_BEFORE_FETCH__')) throw e;
  }
  return captured;
}

describe('OpenRouterAdapter audio input', () => {
  it('converts an audio block to an input_audio part (mp3)', async () => {
    const req = await buildRequest([
      { type: 'audio', source: { type: 'base64', data: 'QUJDRA==', mediaType: 'audio/mp3' } },
      { type: 'text', text: 'describe' },
    ]);
    expect(req.messages[0].content).toContainEqual({
      type: 'input_audio', input_audio: { data: 'QUJDRA==', format: 'mp3' },
    });
  });

  it('maps audio/mpeg to the mp3 format', async () => {
    const req = await buildRequest([
      { type: 'audio', source: { type: 'base64', data: 'QUJDRA==', mediaType: 'audio/mpeg' } },
    ]);
    expect(req.messages[0].content).toContainEqual({
      type: 'input_audio', input_audio: { data: 'QUJDRA==', format: 'mp3' },
    });
  });

  it('maps the legacy audio/mpeg3 alias to the mp3 format', async () => {
    const req = await buildRequest([
      { type: 'audio', source: { type: 'base64', data: 'QUJDRA==', mediaType: 'audio/mpeg3' } },
    ]);
    expect(req.messages[0].content).toContainEqual({
      type: 'input_audio', input_audio: { data: 'QUJDRA==', format: 'mp3' },
    });
  });

  it('ignores MIME parameters when mapping', async () => {
    const req = await buildRequest([
      { type: 'audio', source: { type: 'base64', data: 'QUJDRA==', mediaType: 'audio/mpeg; rate=16000' } },
    ]);
    expect(req.messages[0].content).toContainEqual({
      type: 'input_audio', input_audio: { data: 'QUJDRA==', format: 'mp3' },
    });
  });

  it('maps audio/wav to the wav format', async () => {
    const req = await buildRequest([
      { type: 'audio', source: { type: 'base64', data: 'V0FWRA==', mediaType: 'audio/wav' } },
    ]);
    expect(req.messages[0].content).toContainEqual({
      type: 'input_audio', input_audio: { data: 'V0FWRA==', format: 'wav' },
    });
  });

  it('maps the audio/x-wav alias to the wav format', async () => {
    const req = await buildRequest([
      { type: 'audio', source: { type: 'base64', data: 'V0FWRA==', mediaType: 'audio/x-wav' } },
    ]);
    expect(req.messages[0].content).toContainEqual({
      type: 'input_audio', input_audio: { data: 'V0FWRA==', format: 'wav' },
    });
  });

  it('accepts the snake_case media_type field too', async () => {
    const req = await buildRequest([
      { type: 'audio', source: { type: 'base64', data: 'QUJDRA==', media_type: 'audio/wav' } },
    ]);
    expect(req.messages[0].content).toContainEqual({
      type: 'input_audio', input_audio: { data: 'QUJDRA==', format: 'wav' },
    });
  });

  it('skips audio with an unknown MIME type and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const req = await buildRequest([
      { type: 'audio', source: { type: 'base64', data: 'QUJDRA==', mediaType: 'audio/weird' } },
      { type: 'text', text: 'hello' },
    ]);
    const parts = Array.isArray(req.messages[0].content) ? req.messages[0].content : [];
    expect(parts.some((p: any) => p.type === 'input_audio')).toBe(false);
    const content = req.messages[0].content;
    if (typeof content === 'string') {
      expect(content).toContain('hello');
    } else {
      expect(content).toContainEqual({ type: 'text', text: 'hello' });
    }
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('audio/weird'));
    warn.mockRestore();
  });

  it('preserves order and text in mixed text+audio content', async () => {
    const req = await buildRequest([
      { type: 'text', text: 'before' },
      { type: 'audio', source: { type: 'base64', data: 'QUJDRA==', mediaType: 'audio/mp3' } },
      { type: 'text', text: 'after' },
    ]);
    expect(req.messages[0].content).toEqual([
      { type: 'text', text: 'before' },
      { type: 'input_audio', input_audio: { data: 'QUJDRA==', format: 'mp3' } },
      { type: 'text', text: 'after' },
    ]);
  });

  it('still converts image blocks (regression)', async () => {
    const req = await buildRequest([
      { type: 'image', source: { type: 'base64', data: 'iVBORw0KGgo=', media_type: 'image/png' } },
    ]);
    expect(req.messages[0].content).toContainEqual({
      type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' },
    });
  });
});
