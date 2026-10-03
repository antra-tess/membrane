import { afterEach, describe, expect, it, vi } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { OpenAIAdapter } from '../../src/providers/openai.js';
import { OpenAICompatibleAdapter, toOpenAIMessages } from '../../src/providers/openai-compatible.js';
import { OpenRouterAdapter, toOpenRouterMessages } from '../../src/providers/openrouter.js';
import { GeminiAdapter } from '../../src/providers/gemini.js';
import { sseResponse } from '../helpers/sse-fixtures.js';
import type { NormalizedRequest, ProviderAdapter } from '../../src/types/index.js';

const data = 'iVBORw0KGgo=' + 'A'.repeat(400_000);
const secondData = 'iVBORw0KGgo=' + 'B'.repeat(400_000);
const image = (snake = false, bytes = data) => ({
  type: 'image', source: {
    type: 'base64', data: bytes,
    // Pre-#84 NativeFormatter accepts media_type only in complete() history.
    // Carry both labels here to isolate the adapter regression from #84.
    mediaType: 'image/png', ...(snake ? { media_type: 'image/png' } : {}),
  },
});
const text = (value: string) => ({ type: 'text', text: value });
const mixed = (snake = false) => [text('before'), image(snake), text('between'), image(snake, secondData), text('after')];
const tool = (id: string, name: string) => ({ type: 'tool_use', id, name, input: {} });
const result = (id: string, content: unknown, isError = false) => ({ type: 'tool_result', toolUseId: id, content, isError });
const definitions = ['snapshot', 'inspect'].map(name => ({ name, description: name, inputSchema: { type: 'object' as const, properties: {} } }));

type Case = { name: string; model: string; adapter: () => ProviderAdapter; gemini?: boolean; nativeImages?: boolean };
const cases: Case[] = [
  { name: 'OpenAI', model: 'gpt-4o', adapter: () => new OpenAIAdapter({ apiKey: 'test' }) },
  { name: 'compatible', model: 'vision-model', adapter: () => new OpenAICompatibleAdapter({ baseURL: 'https://example.test/v1' }) },
  { name: 'OpenRouter', model: 'vendor/vision-model', adapter: () => new OpenRouterAdapter({ apiKey: 'test' }), nativeImages: true },
  { name: 'Gemini 2', model: 'gemini-2.5-flash', adapter: () => new GeminiAdapter({ apiKey: 'test' }), gemini: true },
  { name: 'Gemini 3', model: 'gemini-3-flash', adapter: () => new GeminiAdapter({ apiKey: 'test' }), gemini: true, nativeImages: true },
];
afterEach(() => vi.unstubAllGlobals());

function stub(c: Case, rounds = 0) {
  const bodies: any[] = [];
  const fetch = vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    const calls = bodies.length <= rounds;
    const names = calls ? ['snapshot', 'inspect'] : [];
    if (c.gemini) {
      const frame = {
        candidates: [{
          content: { parts: calls ? names.map(name => ({ functionCall: { name, args: {} } })) : [{ text: 'done' }] },
          finishReason: calls ? 'FUNCTION_CALL' : 'STOP',
        }],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 },
      };
      return String(_url).includes('streamGenerateContent')
        ? sseResponse([JSON.stringify(frame)])
        : new Response(JSON.stringify(frame));
    }
    const content = calls ? {
      tool_calls: names.map((name, index) => ({ index, id: 'call_' + bodies.length + '_' + index, type: 'function', function: { name, arguments: '{}' } })),
    } : { content: 'done' };
    const finish_reason = calls ? 'tool_calls' : 'stop';
    const usage = { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 };
    return body.stream
      ? sseResponse([
        JSON.stringify({ choices: [{ index: 0, delta: content }] }),
        JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason }], usage }), '[DONE]',
      ])
      : new Response(JSON.stringify({ choices: [{ index: 0, message: content, finish_reason }], usage }));
  });
  vi.stubGlobal('fetch', fetch);
  return { bodies, fetch };
}

/** Check the wire, rather than only the private converter's intermediate shape. */
function assertMedia(c: Case, body: any, expectedResults: number, expectedImages: number) {
  const media: string[] = [];
  const walk = (value: any, key = '') => {
    if (typeof value === 'string') {
      if (key === 'data' || key === 'url') {
        if (value.includes(data)) media.push('first');
        if (value.includes(secondData)) media.push('second');
      } else expect(value.includes(data) || value.includes(secondData), 'base64 escaped into a non-media field').toBe(false);
    } else if (Array.isArray(value)) value.forEach(v => walk(v));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([k, v]) => walk(v, k));
  };
  walk(body);
  expect(media).toEqual(Array.from({ length: expectedImages }, (_, i) => i % 2 ? 'second' : 'first'));
  if (c.gemini) {
    const responses = body.contents.flatMap((m: any) => m.parts.filter((p: any) => p.functionResponse).map((p: any) => p.functionResponse));
    expect(responses).toHaveLength(expectedResults);
    expect(responses.map((r: any) => r.name)).toEqual(Array.from({ length: expectedResults }, (_, i) => i % 2 ? 'inspect' : 'snapshot'));
    for (const response of responses) {
      if (c.nativeImages) expect(response.parts).toHaveLength(2);
      else expect(response.parts).toBeUndefined();
      const resultText = JSON.stringify(response.response);
      expect(resultText).toMatch(/before.*Image 1.*between.*Image 2.*after/);
    }
    for (const msg of body.contents) {
      const firstImage = msg.parts.findIndex((p: any) => p.inlineData);
      if (firstImage >= 0) expect(msg.parts.slice(firstImage).some((p: any) => p.functionResponse)).toBe(false);
    }
  } else {
    const tools = body.messages.filter((m: any) => m.role === 'tool');
    expect(tools).toHaveLength(expectedResults);
    for (const msg of body.messages) {
      if (!msg.tool_calls) continue;
      const start = body.messages.indexOf(msg) + 1;
      expect(body.messages.slice(start, start + msg.tool_calls.length).map((m: any) => m.tool_call_id)).toEqual(msg.tool_calls.map((t: any) => t.id));
    }
    for (const msg of tools) {
      if (c.nativeImages) {
        expect(msg.content.filter((p: any) => p.type === 'image_url')).toHaveLength(2);
        expect(msg.content.filter((p: any) => p.type === 'text').map((p: any) => p.text).join(' ')).toContain('before between after');
      } else {
        expect(typeof msg.content).toBe('string');
        expect(msg.content).toMatch(/before[\s\S]*Image 1[\s\S]*between[\s\S]*Image 2[\s\S]*after/);
        const attachment = body.messages.find((m: any) => m.role === 'user' && Array.isArray(m.content) && m.content.some((p: any) => p.text?.includes(JSON.stringify(msg.tool_call_id))));
        expect(attachment).toBeDefined();
      }
    }
  }
}

function request(c: Case, history = true): NormalizedRequest {
  return {
    config: { model: c.model, maxTokens: 64 }, toolMode: 'native',
    tools: definitions,
    messages: [
      { participant: 'User', content: [text('look')] },
      ...(history ? [
        { participant: 'Assistant', content: [tool('one', 'snapshot'), tool('two', 'inspect')] },
        { participant: 'User', content: [result('one', mixed(true)), result('two', mixed(true), true), text('injected')] },
      ] : []),
    ],
  } as NormalizedRequest;
}

async function yielding(membrane: Membrane, req: NormalizedRequest, live = false) {
  const stream = membrane.streamYielding(req);
  let response: any;
  for await (const event of stream) {
    if (event.type === 'tool-calls' && live) {
      stream.provideToolResults(event.calls.map((call, index) => ({ toolUseId: call.id, content: mixed() as any, isError: index === 1 })), {
        injectedMessages: [{ participant: 'User', content: [text('injected')] as any }],
      });
    }
    if (event.type === 'complete') response = event.response;
    if (event.type === 'error') throw event.error;
  }
  return response;
}

describe.each(cases)('$name tool-result image transport', c => {
  it.each(['complete', 'stream', 'yielding'])('native history through %s carries pixels without mutating the caller', async path => {
    const req = request(c);
    const before = structuredClone(req);
    const { bodies } = stub(c);
    const membrane = new Membrane(c.adapter(), { formatter: new NativeFormatter() });
    const response: any = path === 'complete' ? await membrane.complete(req)
      : path === 'stream' ? await membrane.stream(req) : await yielding(membrane, req);
    expect(bodies).toHaveLength(1);
    assertMedia(c, bodies[0], 2, 4);
    expect(JSON.stringify(bodies[0])).toContain('injected');
    expect(JSON.stringify(bodies[0])).toContain('Tool result error');
    expect(response.usage).toMatchObject({ inputTokens: 7, outputTokens: 3 });
    expect(response.details.stop.reason).toBe('end_turn');
    expect(req).toEqual(before);
  });

  it.each(['stream', 'yielding'])('two live parallel-call cycles through %s retain media, pairing, usage and injected text', async path => {
    const req = request(c, false);
    const before = structuredClone(req);
    const { bodies } = stub(c, 2);
    const membrane = new Membrane(c.adapter(), { formatter: new NativeFormatter() });
    const supplied: any[] = [];
    const response: any = path === 'yielding' ? await yielding(membrane, req, true)
      : await membrane.stream(req, {
        onToolCalls: async calls => {
          const results = calls.map((call, index) => ({ toolUseId: call.id, content: mixed() as any, isError: index === 1 }));
          supplied.push([results, structuredClone(results)]);
          return results;
        },
      });
    expect(bodies).toHaveLength(3);
    assertMedia(c, bodies[1], 2, 4);
    assertMedia(c, bodies[2], 4, 8);
    if (path === 'yielding') expect(JSON.stringify(bodies[2])).toContain('injected');
    expect(response.usage).toMatchObject({ inputTokens: 21, outputTokens: 9 });
    expect(response.details.stop.reason).toBe('end_turn');
    expect(req).toEqual(before);
    for (const [actual, original] of supplied) expect(actual).toEqual(original);
  });

  it.each(['complete', 'stream'])('direct adapter %s accepts camel/snake labels and batches separate result envelopes', async path => {
    const { bodies } = stub(c);
    const messages = [
      { role: 'assistant', content: [tool('one', 'snapshot'), tool('two', 'inspect')] },
      { role: 'user', content: [result('one', mixed())] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'two', content: mixed(true), is_error: true }] },
      { role: 'user', content: [text('injected')] },
    ];
    const req = { model: c.model, messages };
    const before = structuredClone(req);
    const adapter = c.adapter();
    const response = path === 'complete' ? await adapter.complete(req) : await adapter.stream(req, { onChunk() {} });
    assertMedia(c, bodies[0], 2, 4);
    expect(response.stopReason).toBe('end_turn');
    expect(response.usage).toMatchObject({ inputTokens: 7, outputTokens: 3 });
    expect(req).toEqual(before);
  });


  it('keeps MCP/generated-image safeguards when normalized media activates conversion', async () => {
    const { bodies } = stub(c);
    const strayData = 'UNNORMALIZED_IMAGE_BYTES_'.repeat(100);
    const content = [...mixed(), { type: 'image', data: strayData, mimeType: 'image/png' }, { type: 'generated_image', data: strayData, mimeType: 'image/png' }, { type: 'image', title: 'Cat', width: 640 }];
    await c.adapter().complete({ model: c.model, messages: [
      { role: 'assistant', content: [tool('one', 'snapshot'), tool('two', 'inspect')] },
      { role: 'user', content: [result('one', content), result('two', content)] },
    ] });
    assertMedia(c, bodies[0], 2, 4);
    const wire = JSON.stringify(bodies[0]);
    expect(wire.includes(strayData)).toBe(false);
    expect(wire).toContain('NOT shown');
    expect(wire).toContain('Cat');
  });

  it('retains legacy image-free names, content bytes, and no-payload image-typed data', async () => {
    const { bodies } = stub(c);
    const shapes = [
      'text', '', null, undefined, [], [text('a'), text('b')], { ok: true },
      [null, 1, false], [{ type: 'image', title: 'Cat', width: 640 }],
      [{ type: 'image', source: null }], [{ type: 'custom', value: 2 }],
    ];
    for (const content of shapes) {
      await c.adapter().complete({ model: c.model, messages: [
        { role: 'assistant', content: [tool('one', 'snapshot')] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'one', content }] },
      ] });
      const body = bodies.at(-1);
      const serialized = typeof content === 'string' ? content : JSON.stringify(content);
      if (c.gemini) {
        const response = body.contents.flatMap((m: any) => m.parts).find((p: any) => p.functionResponse).functionResponse;
        expect(response).toEqual({ name: 'one', response: serialized === undefined ? {} : { result: serialized } });
      } else {
        const message = body.messages.find((m: any) => m.role === 'tool');
        expect(message).toEqual({ role: 'tool', tool_call_id: 'one', ...(serialized === undefined ? {} : { content: serialized }) });
      }
    }
  });

  it('preserves image-free serialized content and explicitly describes unsupported images', async () => {
    const { bodies, fetch } = stub(c);
    const legacy = [text('plain'), { metadata: { code: 2 } }];
    const messages = [
      { role: 'assistant', content: [tool('one', 'snapshot'), tool('two', 'inspect')] },
      { role: 'user', content: [
        result('one', legacy),
        result('two', [text('first'), { type: 'image', source: { type: 'file', path: '/tmp/private' } }, { type: 'image', source: { type: 'url', url: 'https://example.test/image.png' } }, text('last')]),
      ] },
    ];
    await c.adapter().complete({ model: c.model, messages });
    const body = bodies[0];
    const first = c.gemini ? body.contents.flatMap((m: any) => m.parts).find((p: any) => p.functionResponse).functionResponse.response.result : body.messages.find((m: any) => m.role === 'tool').content;
    expect(first).toBe(JSON.stringify(legacy));
    expect(JSON.stringify(body)).toContain('image omitted');
    expect(JSON.stringify(body)).not.toContain('/tmp/private');
    if (c.gemini) expect(JSON.stringify(body)).not.toContain('https://example.test/image.png');
    else expect(JSON.stringify(body)).toContain('https://example.test/image.png');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('exported normalized Chat request helpers', () => {
  it.each([
    ['OpenRouter', toOpenRouterMessages],
    ['compatible', toOpenAIMessages],
  ] as const)('%s shares image conversion and puts interloper text after paired results', async (name, convert) => {
    const c = cases.find(c => c.name === name)!;
    const messages = [
      { role: 'assistant', content: [tool('one', 'snapshot'), tool('two', 'inspect')] },
      { role: 'user', content: [result('one', mixed()), result('two', mixed()), text('injected')] },
    ] as any;
    const before = structuredClone(messages);
    const output = convert(messages);
    assertMedia(c, { messages: output }, 2, 4);
    expect(output.at(-1)?.content).toBe('injected');
    expect(messages).toEqual(before);
    const { bodies } = stub(c);
    await c.adapter().complete({ model: c.model, messages: output });
    assertMedia(c, bodies[0], 2, 4);
  });
});
