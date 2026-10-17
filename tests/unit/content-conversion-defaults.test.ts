/**
 * Both content-conversion switches fell through to a silent drop.
 *
 * `toAnthropicContent` (REQUEST path) had no `default`, so `audio`, `video`
 * and `generated_image` blocks vanished on their way to the provider — a
 * conversation that picked up audio on Gemini and then switched to Anthropic
 * lost it with no signal, and the model answered about content it never
 * received. `document` silently dropped its `filename`.
 *
 * `fromAnthropicContent` and `parseProviderContent` (RESPONSE path) kept only
 * the block types they recognised, so provider-native blocks — `server_tool_use`,
 * `web_search_tool_result`, `search_result`, `mcp_tool_use` — were dropped
 * without a trace.
 *
 * A dropped request block is unrecoverable, so that path now THROWS; a dropped
 * response block is recoverable if the raw item is kept, so that path warns
 * once and preserves a `rawItem` carrier.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { toAnthropicContent, fromAnthropicContent } from '../../src/providers/anthropic.js';
import { MembraneError } from '../../src/types/index.js';
import type { ContentBlock } from '../../src/types/index.js';

afterEach(() => { vi.restoreAllMocks(); });

describe('toAnthropicContent: the request path refuses to drop content', () => {
  it('throws on an audio block instead of dropping it', () => {
    const attempt = () => toAnthropicContent([
      { type: 'audio', source: { type: 'base64', data: 'QUJDRA==', mediaType: 'audio/mp3' } },
    ] as ContentBlock[]);

    expect(attempt).toThrow(MembraneError);
    try { attempt(); } catch (error) {
      expect((error as MembraneError).type).toBe('unsupported');
      expect((error as MembraneError).message).toContain('audio');
    }
  });

  it('throws on a video block instead of dropping it', () => {
    const attempt = () => toAnthropicContent([
      { type: 'video', source: { type: 'base64', data: 'QUJDRA==', mediaType: 'video/mp4' } },
    ] as ContentBlock[]);

    expect(attempt).toThrow(MembraneError);
    try { attempt(); } catch (error) {
      expect((error as MembraneError).type).toBe('unsupported');
      expect((error as MembraneError).message).toContain('video');
    }
  });

  it('throws on a block type it has never heard of', () => {
    const attempt = () => toAnthropicContent([
      { type: 'zz-future-block-1', data: 'zz' } as unknown as ContentBlock,
    ]);

    expect(attempt).toThrow(MembraneError);
    try { attempt(); } catch (error) {
      expect((error as MembraneError).type).toBe('unsupported');
      expect((error as MembraneError).message).toContain('zz-future-block-1');
    }
  });

  it('carries a generated_image back as an image block rather than dropping it', () => {
    // A real PNG header: data that is no image becomes a placeholder instead.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');
    const result = toAnthropicContent([
      { type: 'generated_image', data: png, mimeType: 'image/png' },
    ] as ContentBlock[]);

    expect(result).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
    ]);
  });

  it('preserves a document filename as the Anthropic title field', () => {
    const result = toAnthropicContent([
      {
        type: 'document',
        source: { type: 'base64', data: 'UERG', mediaType: 'application/pdf' },
        filename: 'zz-report-fld1.pdf',
      },
    ] as ContentBlock[]);

    expect((result[0] as { title?: string }).title).toBe('zz-report-fld1.pdf');
  });

  it('still converts the ordinary block types (regression)', () => {
    const result = toAnthropicContent([
      { type: 'text', text: 'zz-hello' },
      { type: 'tool_use', id: 'ite1', name: 'zz_tool_1', input: { fld1: 1 } },
    ] as ContentBlock[]);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ type: 'text', text: 'zz-hello' });
    expect(result[1]).toMatchObject({ type: 'tool_use', id: 'ite1', name: 'zz_tool_1' });
  });
});

describe('fromAnthropicContent: the response path preserves what it cannot normalize', () => {
  it('keeps an unrecognised provider block as a rawItem carrier and warns once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* silence */ });
    // A type membrane doesn't know (an Anthropic server-tool block is a known one).
    const unknownBlock = { type: 'zz_new_block', id: 'ite1', payload: {} };

    const first = fromAnthropicContent([unknownBlock] as never);
    const second = fromAnthropicContent([unknownBlock] as never);

    expect(first).toHaveLength(1);
    expect(first[0]).toEqual({ type: 'text', text: '', rawItem: unknownBlock });
    expect(second).toHaveLength(1);
    // Warned about this block type once, not once per conversion.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('zz_new_block');
  });

  it('still round-trips the recognised block types (regression)', () => {
    const result = fromAnthropicContent([
      { type: 'text', text: 'zz-hello', citations: [] },
      { type: 'thinking', thinking: 'zz-thought', signature: 'zz-sig-1' },
    ] as never);

    expect(result[0]).toMatchObject({ type: 'text', text: 'zz-hello' });
    expect(result[1]).toMatchObject({ type: 'thinking', thinking: 'zz-thought', signature: 'zz-sig-1' });
  });
});
