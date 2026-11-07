/**
 * Chat Completions parity for tool results carrying images: the OpenRouter
 * adapter emits native image_url parts instead of stringifying base64 into
 * the tool message text. Mirrors openai-responses-tool-result-images.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { toolResultWireContent } from '../../src/providers/utils.js';
import { OpenRouterAdapter, toOpenRouterMessages } from '../../src/providers/openrouter.js';

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

  it('honors mimeType on MCP-shaped images (JPEG not forced to PNG)', () => {
    const out = toolResultWireContent([{ type: 'image', data: '/9j/4AAQ', mimeType: 'image/jpeg' }]);
    expect(out).toEqual([{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/4AAQ' } }]);
  });

  it('honors mimeType on generated_image blocks (JPEG not forced to PNG)', () => {
    const out = toolResultWireContent([{ type: 'generated_image', data: '/9j/4AAQ', mimeType: 'image/jpeg' }]);
    expect(out).toEqual([{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/4AAQ' } }]);
  });

  it('sends an empty base64 payload as the placeholder, not an empty image part', () => {
    const out = toolResultWireContent([{ type: 'image', source: { type: 'base64', data: '', mediaType: 'image/png' } }]);
    expect(out).toEqual([{ type: 'text', text: expect.stringContaining('NOT shown to you') }]);
  });

  it('sends a non-image data URL as the placeholder', () => {
    const out = toolResultWireContent([{ type: 'image', source: { type: 'url', url: 'data:text/html;base64,PGh0bWw+' } }]);
    expect(out).toEqual([{ type: 'text', text: expect.stringContaining('NOT shown to you') }]);
  });
});

describe('reasoning round-trip', () => {
  it('preserves a thinking-only assistant turn in the canonical converter', () => {
    const adapter = new OpenRouterAdapter({ apiKey: 'test-key' });
    const out = adapter['convertMessages']([
      { role: 'user', content: [{ type: 'text', text: 'What do you see?' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'The user sent a screenshot earlier.' }] },
      { role: 'user', content: [{ type: 'text', text: 'Well?' }] },
    ]);
    const assistant = out.filter((m: { role?: string }) => m.role === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0].reasoning).toBe('The user sent a screenshot earlier.');
  });

  it('preserves a thinking-only assistant turn in the legacy converter', () => {
    const out = toOpenRouterMessages([
      { role: 'user', content: [{ type: 'text', text: 'What do you see?' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'The user sent a screenshot earlier.' }] } as never,
      { role: 'user', content: [{ type: 'text', text: 'Well?' }] },
    ]);
    const assistant = out.filter((m: { role?: string }) => m.role === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0].reasoning).toBe('The user sent a screenshot earlier.');
  });
});
