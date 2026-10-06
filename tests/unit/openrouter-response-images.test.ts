import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenRouterAdapter, fromOpenRouterMessage } from '../../src/providers/openrouter.js';
import { Membrane } from '../../src/membrane.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { AnthropicXmlFormatter } from '../../src/formatters/anthropic-xml.js';
import { sseResponse } from '../helpers/sse-fixtures.js';
import type { NormalizedRequest } from '../../src/types/index.js';

const data = 'iVBORw0KGgo=';
const dataUrl = 'data:image/png;base64,' + data;
const remoteUrl = 'https://example.com/generated.png';
const imagePart = (url: string) => ({ type: 'image_url' as const, image_url: { url } });
const image = { type: 'image', source: { type: 'base64', mediaType: 'image/png', data } };
const remoteImage = { type: 'image', source: { type: 'url', url: remoteUrl } };
const text = (value: string) => ({ type: 'text' as const, text: value });
const request: NormalizedRequest = {
  messages: [{ participant: 'User', content: [text('Draw a picture')] }],
  config: { model: 'provider/image-model', maxTokens: 64 },
};
const providerRequest = { model: request.config.model, messages: [{ role: 'user', content: 'Draw' }] };
const usage = { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 };

afterEach(() => vi.unstubAllGlobals());

function completed(message: unknown) {
  return new Response(JSON.stringify({
    model: 'served/image-model', choices: [{ index: 0, message, finish_reason: 'stop' }], usage,
  }), { headers: { 'content-type': 'application/json' } });
}

function streamed(deltas: unknown[]) {
  return sseResponse([
    ...deltas.map(delta => JSON.stringify({ model: 'served/image-model', choices: [{ index: 0, delta }] })),
    JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage }),
    '[DONE]',
  ]);
}

describe('OpenRouter image normalization', () => {
  it('preserves mixed text and images in order, with tool calls following content', () => {
    expect(fromOpenRouterMessage({
      role: 'assistant',
      content: [text('before'), imagePart(dataUrl), text('after'), imagePart(remoteUrl)],
      tool_calls: [{ id: 'call', type: 'function', function: { name: 'inspect', arguments: '{"x":1}' } }],
    })).toEqual([
      text('before'), image, text('after'), remoteImage,
      { type: 'tool_use', id: 'call', name: 'inspect', input: { x: 1 } },
    ]);
  });

  it('preserves generated images in the separate message.images field', () => {
    expect(fromOpenRouterMessage({
      role: 'assistant', content: 'Here it is',
      images: [{ image_url: { url: dataUrl } }, { image_url: { url: remoteUrl } }],
    } as any)).toEqual([text('Here it is'), image, remoteImage]);
  });

  it('keeps non-base64 data URLs as URL sources without fetching or decoding them', () => {
    const url = 'data:image/svg+xml,%3Csvg%2F%3E';
    expect(fromOpenRouterMessage({ role: 'assistant', content: [imagePart(url)] })).toEqual([
      { type: 'image', source: { type: 'url', url } },
    ]);
  });

  it('preserves base64 text exactly without rewriting the payload', () => {
    const url = 'data:image/jpeg;base64,/9j/\nAA==';
    expect(fromOpenRouterMessage({ role: 'assistant', content: [imagePart(url)] })).toEqual([
      { type: 'image', source: { type: 'base64', mediaType: 'image/jpeg', data: '/9j/\nAA==' } },
    ]);
  });
});

describe('OpenRouter complete transport', () => {
  it.each(['content', 'images'])('returns images from %s beside text with usage and model intact', async where => {
    const message = where === 'content'
      ? { role: 'assistant', content: [text('Here'), imagePart(dataUrl), imagePart(remoteUrl)] }
      : { role: 'assistant', content: 'Here', images: [{ image_url: { url: dataUrl } }, { image_url: { url: remoteUrl } }] };
    const fetchMock = vi.fn().mockResolvedValue(completed(message));
    vi.stubGlobal('fetch', fetchMock);
    const result = await new OpenRouterAdapter({ apiKey: 'test' }).complete(providerRequest);
    expect(result.content).toEqual([text('Here'), image, remoteImage]);
    expect(result.usage).toMatchObject({ inputTokens: 7, outputTokens: 3 });
    expect(result.model).toBe('served/image-model');
    expect(fetchMock).toHaveBeenCalledTimes(1); // URL images are references, never fetched.
  });
});

describe('OpenRouter streaming transport', () => {
  it('accumulates string and array content without stringifying images or losing order', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamed([
      { content: 'Be' },
      { content: [text('fore'), imagePart(dataUrl), text('af')] },
      { content: 'ter' },
      { images: [{ image_url: { url: remoteUrl } }] },
    ])));
    const chunks: string[] = [];
    const updates: unknown[] = [];
    const result = await new OpenRouterAdapter({ apiKey: 'test' }).stream(providerRequest, {
      onChunk: chunk => chunks.push(chunk),
      onContentBlock: (index, block) => updates.push({ index, block }),
    });
    expect(chunks).toEqual(['Be', 'fore', 'af', 'ter']);
    expect(result.content).toEqual([text('Before'), image, text('after'), remoteImage]);
    expect(updates).toEqual([{ index: 1, block: image }, { index: 3, block: remoteImage }]);
    expect(result.usage).toMatchObject({ inputTokens: 7, outputTokens: 3 });
    expect(result.model).toBe('served/image-model');
  });

  it('keeps repeated identical images as distinct content, alongside streamed tool calls', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamed([
      { content: [imagePart(dataUrl), imagePart(dataUrl)], tool_calls: [{ index: 0, id: 'call', function: { name: 'inspect', arguments: '{"x":' } }] },
      { tool_calls: [{ index: 0, function: { arguments: '1}' } }] },
    ])));
    const result = await new OpenRouterAdapter({ apiKey: 'test' }).stream(providerRequest, { onChunk() {} });
    expect(result.content).toEqual([image, image, { type: 'tool_use', id: 'call', name: 'inspect', input: { x: 1 } }]);
  });

  it('retains the existing single-text-block result for text-only streams', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamed([{ content: 'hello' }, { content: ' world' }])));
    const result = await new OpenRouterAdapter({ apiKey: 'test' }).stream(providerRequest, { onChunk() {} });
    expect(result.content).toEqual([text('hello world')]);
    expect((result.raw as any).message.content).toBe('hello world');
  });
});

describe('image streaming callbacks', () => {
  it('passes image updates without inventing empty logical text blocks', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamed([{ content: [imagePart(dataUrl)] }])));
    const updates: unknown[] = [];
    const events: unknown[] = [];
    const membrane = new Membrane(new OpenRouterAdapter({ apiKey: 'test' }), { formatter: new NativeFormatter() });
    await membrane.stream({ ...request, toolMode: 'native' }, {
      onContentBlockUpdate: (_index, block) => updates.push(block),
      onBlock: event => events.push(event),
    });
    expect(updates).toEqual([image]);
    expect(events).toEqual([]);
  });

  it('also retains generated-image blocks in yielding XML final responses', async () => {
    const generated = { type: 'generated_image', data, mimeType: 'image/png' };
    const adapter: any = {
      name: 'generated-image-test', supportsModel: () => true,
      stream: async (_request: unknown, callbacks: any) => {
        callbacks.onChunk('Here');
        return { content: [text('Here'), generated], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const membrane = new Membrane(adapter, { formatter: new AnthropicXmlFormatter() });
    let result: any;
    for await (const event of membrane.streamYielding({ ...request, toolMode: 'xml' })) {
      if (event.type === 'error') throw event.error;
      if (event.type === 'complete') result = event.response;
    }
    expect(result.content).toContainEqual(generated);
  });
});

describe.each(['native', 'XML'])('Membrane %s image responses', format => {
  it.each(['complete', 'stream', 'yielding'].flatMap(entry => ['Here', ''].map(caption => ({ entry, caption }))))(
    'preserves images in $entry normalized responses (caption=$caption)', async ({ entry, caption }) => {
    const message = { role: 'assistant', content: [...(caption ? [text(caption)] : []), imagePart(dataUrl), imagePart(remoteUrl)] };
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => entry === 'complete'
      ? completed(message)
      : streamed([{ content: message.content }])));
    const membrane = new Membrane(new OpenRouterAdapter({ apiKey: 'test' }), {
      formatter: format === 'native' ? new NativeFormatter() : new AnthropicXmlFormatter(),
    });
    let result: any;
    const req = { ...request, toolMode: format === 'native' ? 'native' as const : 'xml' as const };
    if (entry === 'complete') result = await membrane.complete(req);
    else if (entry === 'stream') result = await membrane.stream(req);
    else for await (const event of membrane.streamYielding(req)) {
      if (event.type === 'error') throw event.error;
      if (event.type === 'complete') result = event.response;
    }
    expect(result).toBeDefined();
    expect(result.content.filter((block: any) => block.type === 'image')).toEqual([image, remoteImage]);
    expect(result.rawAssistantText).toBe(caption);
    expect(result.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('')).toBe(caption);
  });
});
