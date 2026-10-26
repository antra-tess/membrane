/**
 * The Bedrock API requires an image source's `media_type`, snake_case, and
 * rejects a request without it with a 400 ("...image.source.base64.media_type:
 * Field required").
 */

import { describe, it, expect } from 'vitest';
import { BedrockAdapter } from '../../src/providers/bedrock.js';
import type { ProviderRequest } from '../../src/types/index.js';

const PNG_DATA = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');

function adapter(): BedrockAdapter {
  return new BedrockAdapter({
    accessKeyId: 'test-key',
    secretAccessKey: 'test-secret',
    region: 'us-west-2',
  });
}

function buildRequest(request: unknown): Record<string, any> {
  return (adapter() as unknown as {
    buildRequest(r: ProviderRequest): Record<string, any>;
  }).buildRequest(request as ProviderRequest);
}

describe('bedrock image source conversion', () => {
  it('converts camelCase mediaType to media_type inside tool_result content', () => {
    const built = buildRequest({
      model: 'claude-sonnet-4-5',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: [
                { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: PNG_DATA } },
                { type: 'text', text: 'a snapshot' },
              ],
            },
          ],
        },
      ],
    });

    const source = built.messages[0].content[0].content[0].source;
    expect(source.media_type).toBe('image/png');
    expect(source.mediaType).toBeUndefined();
    expect(source.data).toBe(PNG_DATA);
    // sibling non-image blocks pass through
    expect(built.messages[0].content[0].content[1]).toEqual({ type: 'text', text: 'a snapshot' });
  });

  it('converts top-level image blocks and sniffs a missing/wrong declared type', () => {
    const built = buildRequest({
      model: 'claude-sonnet-4-5',
      messages: [
        {
          role: 'user',
          content: [
            // declared jpeg but PNG magic bytes — sniffing must win, as on the
            // Anthropic adapter path
            { type: 'image', source: { type: 'base64', mediaType: 'image/jpeg', data: PNG_DATA } },
          ],
        },
      ],
    });

    const source = built.messages[0].content[0].source;
    expect(source.media_type).toBe('image/png');
    expect(source.mediaType).toBeUndefined();
  });

  it('leaves url image sources and already-converted blocks intact', () => {
    const built = buildRequest({
      model: 'claude-sonnet-4-5',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'url', url: 'https://example.com/x.png' } },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_DATA } },
          ],
        },
      ],
    });

    expect(built.messages[0].content[0].source).toEqual({ type: 'url', url: 'https://example.com/x.png' });
    const converted = built.messages[0].content[1].source;
    expect(converted.media_type).toBe('image/png');
    expect(converted.mediaType).toBeUndefined();
  });
});
