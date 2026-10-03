import { afterEach, describe, expect, it, vi } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { AnthropicXmlFormatter } from '../../src/formatters/anthropic-xml.js';
import { OpenAIResponsesFormatter } from '../../src/formatters/openai-responses.js';
import { AnthropicAdapter, detectImageMediaType } from '../../src/providers/anthropic.js';
import { OpenAIResponsesAdapter } from '../../src/providers/openai-responses.js';
import { formatToolResultsForSplitTurn } from '../../src/utils/tool-parser.js';
import type { ContentBlock, NormalizedMessage, NormalizedRequest, ProviderAdapter } from '../../src/types/index.js';

// Real 1x1 PNG; other signature tests only exercise header recognition.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
const base64 = (bytes: number[] | string) => Buffer.from(bytes as any).toString('base64');
const image = (mediaType = 'image/webp', data = PNG): ContentBlock => ({
  type: 'image', source: { type: 'base64', data, mediaType },
});
const options = { participantMode: 'simple' as const, assistantParticipant: 'Claude', humanParticipant: 'User' };

function imagesIn(value: any): any[] {
  if (Array.isArray(value)) return value.flatMap(imagesIn);
  if (!value || typeof value !== 'object') return [];
  return value.type === 'image' ? [value] : Object.values(value).flatMap(imagesIn);
}

function history(block: any): NormalizedMessage[] {
  return [
    { participant: 'User', content: [{ type: 'text', text: 'Take a screenshot' }] },
    { participant: 'Claude', content: [{ type: 'tool_use', id: 'shot_1', name: 'shot', input: {} }] },
    { participant: 'User', content: [{ type: 'tool_result', toolUseId: 'shot_1', content: [
      { type: 'text', text: 'Screenshot' }, block,
    ] }] },
  ];
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('image signature resolution', () => {
  it.each([
    ['PNG', PNG, 'image/png'],
    ['JPEG', base64([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg'],
    ['GIF87a', base64('GIF87a123456'), 'image/gif'],
    ['GIF89a', base64('GIF89a123456'), 'image/gif'],
    ['WebP', base64('RIFF1234WEBPVP8 '), 'image/webp'],
  ])('trusts %s bytes over the declared label', (_name, data, expected) => {
    expect(detectImageMediaType(data, 'image/tiff')).toBe(expected);
  });

  it.each(['RIFF1234WAVEfmt ', 'RIFF', 'GIF', 'GIFnotanimage'])(
    'does not mistake %s for a supported image header', (header) => {
      expect(detectImageMediaType(base64(header), 'image/png')).toBe('image/png');
    },
  );

  it('retains accepted fallback labels and the existing provider default', () => {
    expect(detectImageMediaType('unknown', 'IMAGE/GIF')).toBe('image/gif');
    expect(detectImageMediaType(undefined)).toBe('image/jpeg');
  });
});

describe.each([
  ['native', () => new NativeFormatter()],
  ['XML', () => new AnthropicXmlFormatter()],
] as const)('%s formatter image sanitation', (_name, create) => {
  it.each(['image/webp', 'image/svg+xml', 'IMAGE/PNG', undefined])(
    'resolves PNG bytes before checking the declared type %s', (label) => {
      const block = { type: 'image', source: { type: 'base64', mediaType: label, data: PNG } };
      const messages = [{ participant: 'User', content: [block] }] as NormalizedMessage[];
      const original = structuredClone(messages);
      const result = create().buildMessages(messages, options);
      expect(imagesIn(result.messages)).toEqual([{
        type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG },
      }]);
      expect(messages).toEqual(original);
    },
  );

  it('still replaces unsupported image payloads with a visible placeholder', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = create().buildMessages([
      { participant: 'User', content: [image('image/svg+xml', base64('<svg/>'))] },
    ], options);
    expect(imagesIn(result.messages)).toEqual([]);
    expect(JSON.stringify(result.messages)).toContain('NOT shown to you');
    expect(JSON.stringify(result.messages)).toContain('image/svg+xml');
  });
});

describe('native tool-result history', () => {
  it.each(['mediaType', 'media_type'])('accepts and converts %s image sources without mutating history', (key) => {
    const messages = history({ type: 'image', source: { type: 'base64', [key]: 'image/webp', data: PNG } });
    const original = structuredClone(messages);
    const result = new NativeFormatter().buildMessages(messages, options);
    expect(imagesIn(result.messages)).toEqual([{
      type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG },
    }]);
    expect(JSON.stringify(result.messages)).toContain('Screenshot');
    expect(messages).toEqual(original);
  });

  it('keeps URL image sources in tool-result history', () => {
    const block = { type: 'image', source: { type: 'url', url: 'https://example.com/image.png' } };
    const result = new NativeFormatter().buildMessages(history(block), options);
    expect(imagesIn(result.messages)).toEqual([block]);
  });

  it('replaces unsupported nested images while preserving their text siblings', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = new NativeFormatter().buildMessages(history(image('image/svg+xml', base64('<svg/>'))), options);
    expect(imagesIn(result.messages)).toEqual([]);
    expect(JSON.stringify(result.messages)).toContain('Screenshot');
    expect(JSON.stringify(result.messages)).toContain('NOT shown to you');
  });
});

describe('request paths reaching the Anthropic SDK transport', () => {
  it.each([
    ['native top-level', new NativeFormatter(), [{ participant: 'User', content: [image()] }]],
    ['XML top-level', new AnthropicXmlFormatter(), [{ participant: 'User', content: [image()] }]],
    ['native tool-result history', new NativeFormatter(), history(image())],
  ] as const)('%s sends PNG with snake_case metadata', async (_name, formatter, messages) => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text: 'I see it.' }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new AnthropicAdapter({ apiKey: 'test-key', cacheKeepalive: { enabled: false } });
    await new Membrane(adapter, { formatter }).complete({
      messages: messages as NormalizedMessage[],
      assistantParticipant: 'Claude',
      config: { model: 'claude-sonnet-4-5', maxTokens: 32 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(imagesIn(body.messages)).toEqual([{
      type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG },
    }]);
  });

  it.each(['mediaType', 'media_type'])('normalizes direct adapter %s images and preserves cache metadata', async (key) => {
    const adapter = new AnthropicAdapter({ apiKey: 'test-key', cacheKeepalive: { enabled: false } });
    const messages = [{ role: 'user', content: [{
      type: 'image', source: { type: 'base64', [key]: 'image/webp', data: PNG },
      sourceUrl: 'https://example.com/source', cache_control: { type: 'ephemeral' },
    }] }];
    const original = structuredClone(messages);
    const built = (adapter as any).buildRequest({ model: 'claude-sonnet-4-5', messages });
    expect(built.messages[0].content[0]).toEqual({
      type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG },
      cache_control: { type: 'ephemeral' },
    });
    expect(messages).toEqual(original);
  });

  it('retains a snake_case fallback in already-formatted nested tool results', () => {
    const adapter = new AnthropicAdapter({ apiKey: 'test-key', cacheKeepalive: { enabled: false } });
    const built = (adapter as any).buildRequest({
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: [{
        type: 'tool_result', tool_use_id: 'shot_1', content: [{
          type: 'image', source: { type: 'base64', media_type: 'image/gif', data: 'unknown' },
        }],
      }] }],
    });
    expect(imagesIn(built.messages)[0].source.media_type).toBe('image/gif');
  });
});

describe('native streaming and XML split-turn request builders', () => {
  it.each(['stream', 'streamYielding'] as const)('%s resolves images before adapter conversion', async (method) => {
    const sent: unknown[] = [];
    const adapter: ProviderAdapter = {
      name: 'image-capture', supportsModel: () => true,
      complete: async () => { throw new Error('Unexpected complete'); },
      stream: async (request, callbacks) => {
        sent.push(structuredClone(request));
        callbacks.onChunk('Done');
        return {
          content: [{ type: 'text', text: 'Done' }], stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1 }, raw: {},
        };
      },
    };
    const membrane = new Membrane(adapter);
    const request: NormalizedRequest = {
      messages: [{ participant: 'User', content: [image('image/svg+xml')] }],
      config: { model: 'claude-sonnet-4-5', maxTokens: 32 }, toolMode: 'native',
      tools: [{ name: 'shot', description: 'Take a screenshot', inputSchema: { type: 'object' } }],
    };
    if (method === 'stream') await membrane.stream(request, { onChunk: () => {} });
    else for await (const _event of membrane.streamYielding(request)) { /* drain */ }
    expect(sent).toHaveLength(1);
    expect(imagesIn(sent[0])[0].source).toEqual({ type: 'base64', media_type: 'image/png', data: PNG });
  });

  it('sniffs images injected by XML tool continuations before the allowlist', () => {
    const result = formatToolResultsForSplitTurn([{
      toolUseId: 'shot_1', content: [image('image/svg+xml') as any],
    }]);
    expect(result.hasImages).toBe(true);
    expect(result.images[0]?.source).toEqual({ type: 'base64', media_type: 'image/png', data: PNG });
  });
});

describe('OpenAI image request paths', () => {
  it('resolves normalized Responses input images and preserves URL images', () => {
    const result = new OpenAIResponsesFormatter().buildMessages([
      { participant: 'User', content: [
        image(), { type: 'image', source: { type: 'url', url: 'https://example.com/image.png' } },
      ] },
    ], options);
    expect((result.messages[0] as any).content).toEqual([
      { type: 'input_image', image_url: 'data:image/png;base64,' + PNG },
      { type: 'input_image', image_url: 'https://example.com/image.png' },
    ]);
  });

  it.each(['image', 'generated_image'])('uses sniffed %s types in Images API multipart uploads', async (kind) => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      created: 1, data: [{ b64_json: PNG }],
    }), { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new OpenAIResponsesAdapter({ apiKey: 'test-key' });
    await adapter.complete({
      model: 'gpt-image-1', messages: [{ role: 'user', content: [
        { type: 'text', text: 'Edit this image' },
        kind === 'image' ? image() : { type: 'generated_image', data: PNG, mimeType: 'image/webp' },
      ] }],
    });
    const body = fetchMock.mock.calls[0]![1].body as FormData;
    const file = body.get('image[]') as File;
    expect(file.type).toBe('image/png');
    expect(file.name).toBe('image.png');
    expect(Buffer.from(await file.arrayBuffer()).toString('base64')).toBe(PNG);
  });
});

describe('review follow-ups', () => {
  it('keeps the wire key order of an already-correct Anthropic image source', () => {
    const adapter = new AnthropicAdapter({ apiKey: 'test-key', cacheKeepalive: { enabled: false } });
    const block = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } };
    const built = (adapter as any).buildRequest({
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: [block] }],
    });
    expect(JSON.stringify(built.messages[0].content[0])).toBe(JSON.stringify(block));
  });

  it('treats non-string image data or labels as unknown instead of throwing', () => {
    expect(detectImageMediaType(42 as any, 'image/png')).toBe('image/png');
    expect(detectImageMediaType('AAAAAAAAAAAA', 7 as any)).toBe('image/jpeg');
    expect(detectImageMediaType({} as any, null as any)).toBe('image/jpeg');
  });
});
