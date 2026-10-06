import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenRouterAdapter, fromOpenRouterMessage } from '../../src/providers/openrouter.js';
import { Membrane } from '../../src/membrane.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { sseResponse } from '../helpers/sse-fixtures.js';
import type { NormalizedRequest } from '../../src/types/index.js';

const data = 'iVBORw0KGgo=';
const url = 'data:image/png;base64,' + data;
const imagePart = { type: 'image_url', image_url: { url } };
const image = { type: 'image', source: { type: 'base64', mediaType: 'image/png', data } };
const text = (value: string) => ({ type: 'text', text: value });
const malformed = [null, {}, { type: 'image_url' }, { type: 'image_url', image_url: null }, { type: 'image_url', image_url: { url: 42 } }];
const request = { model: 'provider/image-model', messages: [{ role: 'user', content: 'Draw' }] };
const usage = { prompt_tokens: 17, completion_tokens: 9 };
const tool = { id: 'call-1', type: 'function', function: { name: 'inspect', arguments: '{"x":1}' } };
const toolBlock = { type: 'tool_use', id: 'call-1', name: 'inspect', input: { x: 1 } };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function message(where: string) {
  return where === 'content'
    ? { role: 'assistant', content: [text('before'), ...malformed, imagePart, text('after')], tool_calls: [tool] }
    : { role: 'assistant', content: 'beforeafter', images: [...malformed, imagePart], tool_calls: [tool] };
}

function frame(delta: unknown, finish_reason?: string) {
  return JSON.stringify({ model: 'served/model', choices: [{ index: 0, delta, finish_reason }], usage });
}

describe('malformed OpenRouter image entries', () => {
  it.each(['content', 'images'])('skips malformed %s entries in exported normalization, warning once', where => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = fromOpenRouterMessage(message(where) as any);
    expect(result.filter(block => block.type === 'image')).toEqual([image]);
    expect(result.filter(block => block.type === 'text').map(block => block.text).join('')).toBe('beforeafter');
    expect(result.at(-1)).toEqual(toolBlock);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/image.*string.*url/i);
  });

  it.each(['content', 'images'])('retains valid content and usage in complete responses with malformed %s', async where => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      model: 'served/model', choices: [{ message: message(where), finish_reason: 'tool_calls' }], usage,
    }))));
    const result = await new OpenRouterAdapter({ apiKey: 'test' }).complete(request);
    expect(result.content).toContainEqual(image);
    expect(result.content).toContainEqual(toolBlock);
    expect(result.stopReason).toBe('tool_use');
    expect(result.usage).toMatchObject({ inputTokens: 17, outputTokens: 9 });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it.each(['content', 'images'].flatMap(where => ['stop', 'tool_calls'].map(finish => ({ where, finish }))))(
    'keeps terminal metadata after malformed $where in the same $finish frame', async ({ where, finish }) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const delta = message(where);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([frame(delta, finish)])));
      const chunks: string[] = [];
      const result = await new OpenRouterAdapter({ apiKey: 'test' }).stream(request, { onChunk: chunk => chunks.push(chunk) });
      expect(chunks.join('')).toBe('beforeafter');
      expect(result.content).toContainEqual(image);
      expect(result.content).toContainEqual(toolBlock);
      expect(result.stopReason).toBe(finish === 'stop' ? 'end_turn' : 'tool_use');
      expect(result.usage).toMatchObject({ inputTokens: 17, outputTokens: 9 });
      expect(result.model).toBe('served/model');
      expect(warn).toHaveBeenCalledTimes(1);
    },
  );

  it('warns once across frames of a response and warns again for the next response', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => sseResponse([
      frame({ images: malformed }),
      frame({ content: [{ type: 'image_url', image_url: {} }, text('kept')] }, 'stop'),
    ])));
    const adapter = new OpenRouterAdapter({ apiKey: 'test' });
    for (let n = 1; n <= 2; n++) {
      const result = await adapter.stream(request, { onChunk() {} });
      expect(result.content).toEqual([text('kept')]);
      expect(warn).toHaveBeenCalledTimes(n);
    }
  });

  it('ignores empty array text parts while preserving whitespace deltas', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      frame({ content: [text(''), text('hi'), text(' '), text('')] }),
      frame({ content: [text('there'), text('')] }, 'stop'),
    ])));
    const chunks: string[] = [];
    const result = await new OpenRouterAdapter({ apiKey: 'test' }).stream(request, { onChunk: chunk => chunks.push(chunk) });
    expect(chunks).toEqual(['hi', ' ', 'there']);
    expect(result.content).toEqual([text('hi there')]);
  });
});

describe('parameterized image data URLs', () => {
  it.each([
    'data:image/png;name=a.png;base64,',
    'data:image/png;base64;name=a.png,',
    'data:image/png;name=a.png;BASE64;charset=utf-8,',
  ])('reads %s without altering its base64 bytes', header => {
    const payload = data + '\nAA==';
    expect(fromOpenRouterMessage({ role: 'assistant', images: [{ image_url: { url: header + payload } }] } as any)).toEqual([
      { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: payload } },
    ]);
  });

  it('keeps non-base64 data references as URLs even when a parameter value says base64', () => {
    const reference = 'data:image/svg+xml;name=base64,%3Csvg%2F%3E';
    expect(fromOpenRouterMessage({ role: 'assistant', content: [{ type: 'image_url', image_url: { url: reference } }] } as any)).toEqual([
      { type: 'image', source: { type: 'url', url: reference } },
    ]);
  });
});

describe('native image and tool continuation contract', () => {
  it.each(['stream', 'yielding'].flatMap(entry => ['data:image/png;base64,', 'data:image/png;name=a.png;base64,'].map(header => ({ entry, header }))))(
    'replays $header output as an assistant image in $entry round two', async ({ entry, header }) => {
    const wire: any[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url, init) => {
      wire.push(JSON.parse(init.body));
      return wire.length === 1
        ? sseResponse([frame({
          content: [text('Here'), { type: 'image_url', image_url: { url: header + data } }],
          tool_calls: [{ ...tool, index: 0 }],
        }, 'tool_calls')])
        : sseResponse([frame({ content: 'Done' }, 'stop')]);
    }));
    const membrane = new Membrane(new OpenRouterAdapter({ apiKey: 'test' }), { formatter: new NativeFormatter() });
    const req: NormalizedRequest = {
      messages: [{ participant: 'User', content: [text('Draw')] }],
      config: { model: 'provider/image-model', maxTokens: 128 },
      promptCaching: false,
      toolMode: 'native',
      tools: [{ name: 'inspect', description: 'inspect', inputSchema: { type: 'object' } }],
    };
    const results = [{ toolUseId: 'call-1', content: 'inspected' }];
    let response: any;
    if (entry === 'stream') response = await membrane.stream(req, { onToolCalls: async () => results });
    else {
      const stream = membrane.streamYielding(req);
      for await (const event of stream) {
        if (event.type === 'tool-calls') stream.provideToolResults(results);
        if (event.type === 'error') throw event.error;
        if (event.type === 'complete') response = event.response;
      }
    }
    expect(wire).toHaveLength(2);
    expect(wire[1].messages.find((m: any) => m.role === 'assistant')).toEqual({
      role: 'assistant', content: [text('Here'), imagePart], tool_calls: [tool],
    });
    expect(wire[1].messages.find((m: any) => m.role === 'tool')).toMatchObject({
      tool_call_id: 'call-1', content: 'inspected',
    });
    expect(response.content).toContainEqual(image);
  });
});
