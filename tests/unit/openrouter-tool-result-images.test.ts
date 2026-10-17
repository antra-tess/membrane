/**
 * Chat Completions parity for tool results carrying images: the OpenRouter
 * adapter emits native image_url parts instead of stringifying base64 into
 * the tool message text. Mirrors openai-responses-tool-result-images.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { toolResultWireContent } from '../../src/providers/utils.js';

const png = { type: 'base64' as const, mediaType: 'image/png', data: 'iVBORw0KGgo=' };
const webp = { type: 'base64' as const, mediaType: 'image/webp', data: 'UklGRg==' };

describe('toolResultWireContent', () => {
  it('emits native image_url parts for base64 images, preserving mediaType', () => {
    const out = toolResultWireContent([
      { type: 'text', text: 'first-person view' },
      { type: 'image', source: webp },
    ]);
    expect(out).toEqual([
      { type: 'text', text: 'first-person view' },
      { type: 'image_url', image_url: { url: 'data:image/webp;base64,UklGRg==' } },
    ]);
  });

  it('keeps the legacy stringified form for image-free arrays (cache stability)', () => {
    const content = [{ type: 'text', text: 'just text' }];
    expect(toolResultWireContent(content)).toBe(JSON.stringify(content));
  });

  it('passes strings through unchanged', () => {
    expect(toolResultWireContent('plain')).toBe('plain');
  });

  it('degrades unusable image sources (file refs) to the text-only placeholder', () => {
    const out = toolResultWireContent([
      { type: 'image', source: { type: 'file', path: '/tmp/x.png' } },
    ]);
    expect(out).toEqual([
      {
        type: 'text',
        text: '[system: an image in this tool result was NOT shown to you — tool results reach this model as text only. You are not seeing this image.]',
      },
    ]);
  });

  it('handles url-source images natively', () => {
    const out = toolResultWireContent([
      { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
    ]);
    expect(out).toEqual([{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }]);
  });

  it('handles multiple images and mixed non-image blocks in one result', () => {
    const out = toolResultWireContent([
      { type: 'text', text: 'two views:' },
      { type: 'image', source: png },
      { type: 'other', value: 1 },
      { type: 'image', source: webp },
    ]);
    expect(out).toEqual([
      { type: 'text', text: 'two views:' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
      { type: 'text', text: '{"type":"other","value":1}' },
      { type: 'image_url', image_url: { url: 'data:image/webp;base64,UklGRg==' } },
    ]);
  });

  it('treats MCP-shaped image content (data on the block) as an image', () => {
    const out = toolResultWireContent([{ type: 'image', data: 'iVBORw0KGgo=' }]);
    expect(out).toEqual([{ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }]);
  });

  it('defaults to image/png when mediaType is missing on a base64 source', () => {
    const out = toolResultWireContent([{ type: 'image', source: { type: 'base64', data: 'iVBORw0KGgo=' } }]);
    expect(out).toEqual([{ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }]);
  });
});
