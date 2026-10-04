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
  { name: 'OpenAI', model: 'gpt-4o', adapter: () => new OpenAIAdapter({ apiKey: 'test', toolResultImages: 'media' }) },
  { name: 'compatible', model: 'vision-model', adapter: () => new OpenAICompatibleAdapter({ baseURL: 'https://example.test/v1', toolResultImages: 'media' }) },
  { name: 'OpenRouter', model: 'vendor/vision-model', adapter: () => new OpenRouterAdapter({ apiKey: 'test', toolResultImages: 'media' }), nativeImages: true },
  { name: 'Gemini 2', model: 'gemini-2.5-flash', adapter: () => new GeminiAdapter({ apiKey: 'test', toolResultImages: 'media' }), gemini: true },
  { name: 'Gemini 3', model: 'gemini-3-flash', adapter: () => new GeminiAdapter({ apiKey: 'test', toolResultImages: 'media' }), gemini: true, nativeImages: true },
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
      expect(msg.role).toBe('assistant');
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
    config: { model: c.model, maxTokens: 64 }, toolMode: 'native', assistantParticipant: 'Assistant',
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

async function yielding(membrane: Membrane, req: NormalizedRequest, live = false, output: () => any[] = mixed) {
  const stream = membrane.streamYielding(req);
  let response: any;
  for await (const event of stream) {
    if (event.type === 'tool-calls' && live) {
      stream.provideToolResults(event.calls.map((call, index) => ({ toolUseId: call.id, content: output() as any, isError: index === 1 })), {
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



  it.each(['direct-complete', 'direct-stream', 'live-stream', 'live-yielding'])('%s rejects unsupported image bytes and resolves supported bytes before checking MIME', async path => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>').toString('base64');
    const output = () => [
      text('before-svg'),
      { type: 'image', source: { type: 'base64', data: svg, mediaType: 'image/svg+xml' } },
      text('between-images'),
      { type: 'image', source: { type: 'base64', data, mediaType: 'image/svg+xml' } },
      text('after-png'),
    ];
    const live = path.startsWith('live');
    const { bodies } = stub(c, live ? 1 : 0);
    const adapter = c.adapter();
    if (live) {
      const membrane = new Membrane(adapter, { formatter: new NativeFormatter() });
      if (path === 'live-yielding') await yielding(membrane, request(c, false), true, output);
      else await membrane.stream(request(c, false), {
        onToolCalls: async calls => calls.map(call => ({ toolUseId: call.id, content: output() as any })),
      });
    } else {
      const req = { model: c.model, messages: [
        { role: 'assistant', content: [tool('one', 'snapshot'), tool('two', 'inspect')] },
        { role: 'user', content: [result('one', output()), result('two', output())] },
      ] };
      if (path === 'direct-complete') await adapter.complete(req);
      else await adapter.stream(req, { onChunk() {} });
    }
    const body = bodies.at(-1);
    const wire = JSON.stringify(body);
    expect(wire.includes(svg)).toBe(false);
    expect(wire).toContain('image omitted');
    expect(wire).toMatch(/before-svg.*image omitted.*between-images.*after-png/);
    const media: any[] = [];
    const walk = (value: any, key = '') => {
      if (typeof value === 'string') {
        if (value.includes(data)) expect(['data', 'url']).toContain(key);
      } else if (Array.isArray(value)) value.forEach(v => walk(v));
      else if (value && typeof value === 'object') {
        if (value.image_url) media.push(value.image_url);
        if (value.inlineData) media.push(value.inlineData);
        Object.entries(value).forEach(([k, v]) => walk(v, k));
      }
    };
    walk(body);
    expect(media).toHaveLength(2);
    for (const image of media) {
      if (c.gemini) expect(image.mimeType).toBe('image/png');
      else expect(image.url.startsWith('data:image/png;base64,')).toBe(true);
    }
  });


  it.each(['image/heic', 'image/heif'])('retains declared %s for Gemini and omits it on Chat image inputs', async mediaType => {
    // ISO-BMFF headers are intentionally outside the shared signature sniffer;
    // Gemini's documented declared-type support must survive MIME validation.
    const bytes = Buffer.from('\x00\x00\x00\x18ftyp' + (mediaType === 'image/heic' ? 'heic' : 'mif1') + '\x00\x00\x00\x00heic').toString('base64');
    const { bodies } = stub(c);
    await c.adapter().complete({ model: c.model, messages: [
      { role: 'assistant', content: [tool('one', 'snapshot')] },
      { role: 'user', content: [result('one', [text('caption'), { type: 'image', source: { type: 'base64', data: bytes, mediaType: mediaType.toUpperCase() } }])] },
    ] });
    const wire = JSON.stringify(bodies[0]);
    expect(wire).toContain('caption');
    if (c.gemini) {
      expect(wire).toContain('"mimeType":"' + mediaType + '"');
      expect(wire).toContain('"data":"' + bytes + '"');
    } else {
      expect(wire).toContain('image omitted');
      expect(wire).not.toContain(bytes);
    }
  });

  it('applies the provider image-format policy to detected GIF bytes', async () => {
    const gif = Buffer.from('GIF89a123456789').toString('base64');
    const { bodies } = stub(c);
    await c.adapter().complete({ model: c.model, messages: [
      { role: 'assistant', content: [tool('one', 'snapshot')] },
      { role: 'user', content: [result('one', [{ type: 'image', source: { type: 'base64', data: gif, mediaType: 'image/png' } }])] },
    ] });
    const wire = JSON.stringify(bodies[0]);
    if (c.gemini) {
      expect(wire).toContain('image omitted');
      expect(wire).not.toContain(gif);
    } else expect(wire).toContain('data:image/gif;base64,' + gif);
  });

  it('rejects an unsupported inline Chat data URL while retaining a supported mislabeled one', async () => {
    const { bodies } = stub(c);
    const svg = Buffer.from('<svg/>').toString('base64');
    await c.adapter().complete({ model: c.model, messages: [
      { role: 'assistant', content: [tool('one', 'snapshot')] },
      { role: 'user', content: [result('one', [
        { type: 'image', source: { type: 'url', url: 'data:image/svg+xml;base64,' + svg } },
        { type: 'image', source: { type: 'url', url: 'data:image/svg+xml;base64,' + data } },
      ])] },
    ] });
    const wire = JSON.stringify(bodies[0]);
    expect(wire.includes(svg)).toBe(false);
    expect(wire).toContain('image omitted');
    if (!c.gemini) expect(wire.includes('data:image/png;base64,' + data)).toBe(true);
  });


  it.each(['complete', 'stream', 'yielding'])('%s history uses the transport policy for HEIC/HEIF tool images', async path => {
    const heic = Buffer.from('\x00\x00\x00\x18ftypheic\x00\x00\x00\x00heic').toString('base64');
    const heif = Buffer.from('\x00\x00\x00\x18ftypmif1\x00\x00\x00\x00heic').toString('base64');
    const req = request(c);
    req.messages[2]!.content = [
      result('one', [text('HEIC caption'), { type: 'image', source: { type: 'base64', data: heic, mediaType: 'image/heic' } }]),
      result('two', [text('HEIF caption'), { type: 'image', source: { type: 'base64', data: heif, mediaType: 'image/heif' } }]),
    ] as any;
    const before = structuredClone(req);
    const { bodies } = stub(c);
    const membrane = new Membrane(c.adapter(), { formatter: new NativeFormatter() });
    if (path === 'complete') await membrane.complete(req);
    else if (path === 'stream') await membrane.stream(req);
    else await yielding(membrane, req);
    const wire = JSON.stringify(bodies[0]);
    expect(wire).toContain('HEIC caption');
    expect(wire).toContain('HEIF caption');
    expect(wire.includes(heic)).toBe(Boolean(c.gemini));
    expect(wire.includes(heif)).toBe(Boolean(c.gemini));
    if (c.gemini) {
      expect(wire).toContain('"mimeType":"image/heic"');
      expect(wire).toContain('"mimeType":"image/heif"');
    }
    expect(req).toEqual(before);
  });

  it.each(['complete', 'stream'])('%s omits local/malformed image URLs and keeps only HTTP(S) remote references', async path => {
    const invalid = [
      'file:///tmp/screenshot.png', 'blob:https://example.test/123', 'cid:snapshot',
      'ftp://example.test/image.png', '/tmp/screenshot.png', 'https://', 'http://[bad',
    ];
    const valid = ['https://example.test/image.png?signature=a%2Fb', 'http://example.test/image.png'];
    const { bodies, fetch } = stub(c);
    const adapter = c.adapter();
    for (const url of [...invalid, ...valid]) {
      const req = { model: c.model, messages: [
        { role: 'assistant', content: [tool('one', 'snapshot')] },
        { role: 'user', content: [result('one', [text('caption'), { type: 'image', source: { type: 'url', url } }])] },
      ] };
      if (path === 'complete') await adapter.complete(req);
      else await adapter.stream(req, { onChunk() {} });
      const wire = JSON.stringify(bodies.at(-1));
      expect(wire).toContain('caption');
      const supported = !c.gemini && valid.includes(url);
      expect(wire.includes(url)).toBe(supported);
      if (!supported) expect(wire).toContain('image omitted');
    }
    // Only the completion/stream HTTP calls ran, never a fetch of tool URLs.
    expect(fetch).toHaveBeenCalledTimes(invalid.length + valid.length);
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

  it('recovers Gemini names while retaining image-free content bytes and no-payload image-typed data', async () => {
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
        expect(response).toEqual({ name: 'snapshot', response: serialized === undefined ? {} : { result: serialized } });
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
    const output = convert(messages, { toolResultImages: 'media' });
    assertMedia(c, { messages: output }, 2, 4);
    expect(output.at(-1)?.content).toBe('injected');
    expect(messages).toEqual(before);
    const { bodies } = stub(c);
    await c.adapter().complete({ model: c.model, messages: output });
    assertMedia(c, bodies[0], 2, 4);
  });
});

describe('exported helper to adapter composition after image omission', () => {
  const routes = [
    { name: 'OpenAI', adapter: cases[0]!, convert: toOpenAIMessages },
    { name: 'compatible', adapter: cases[1]!, convert: toOpenAIMessages },
    { name: 'OpenRouter', adapter: cases[2]!, convert: toOpenRouterMessages },
  ];
  describe.each(routes)('$name', ({ adapter: c, convert }) => {
    it.each([
      ['complete', false], ['stream', false],
      ['complete', true], ['stream', true],
    ] as const)('%s retains IDs when the parallel result batch contains supported images=%s', async (method, supported) => {
      const svg = Buffer.from('<svg/>').toString('base64');
      const omitted = [{ type: 'image', source: { type: 'base64', data: svg, mediaType: 'image/svg+xml' } }];
      const normalized = [
        { role: 'assistant', content: [tool('one', 'snapshot'), tool('two', 'inspect')] },
        { role: 'user', content: [
          result('one', [text('first result'), ...omitted], true),
          result('two', [text('second result'), ...(supported ? [image()] : omitted)]),
          text('injected'),
        ] },
      ] as any;
      const messages = convert(normalized, { toolResultImages: 'media' });
      const before = structuredClone(messages);
      const { bodies } = stub(c);
      const adapter = c.adapter();
      if (method === 'complete') await adapter.complete({ model: c.model, messages });
      else await adapter.stream({ model: c.model, messages }, { onChunk() {} });
      const wire = bodies[0].messages;
      expect(wire.slice(0, 3).map((m: any) => m.role)).toEqual(['assistant', 'tool', 'tool']);
      expect(wire.slice(1, 3).map((m: any) => m.tool_call_id)).toEqual(['one', 'two']);
      expect(wire[1].content).toContain('image omitted');
      expect(wire[1].content).toContain('Tool result error');
      expect(wire.at(-1).content).toBe('injected');
      expect(JSON.stringify(wire).includes(svg)).toBe(false);
      expect(JSON.stringify(wire).includes(data)).toBe(supported);
      expect(messages).toEqual(before);
    });
  });
});

describe('combined stream content replay through exported helpers', () => {
  const routes = [
    { name: 'OpenAI', adapter: cases[0]!, convert: toOpenAIMessages },
    { name: 'compatible', adapter: cases[1]!, convert: toOpenAIMessages },
    { name: 'OpenRouter', adapter: cases[2]!, convert: toOpenRouterMessages },
  ];
  describe.each(routes)('$name', ({ adapter: c, convert }) => {
    it.each([
      ['complete', 'supported'], ['stream', 'supported'],
      ['complete', 'omitted'], ['stream', 'omitted'],
      ['complete', 'text'], ['stream', 'text'],
    ] as const)('%s replays combined calls/results with %s content in call-first order', async (path, kind) => {
      const svg = Buffer.from('<svg/>').toString('base64');
      const output = kind === 'supported' ? [image()]
        : kind === 'omitted' ? [{ type: 'image', source: { type: 'base64', data: svg, mediaType: 'image/svg+xml' } }]
        : [text('plain')];
      const { bodies } = stub(c, 1);
      const adapter = c.adapter();
      const response: any = await new Membrane(adapter, { formatter: new NativeFormatter() }).stream(request(c, false), {
        onToolCalls: async calls => calls.map(call => ({ toolUseId: call.id, content: output as any })),
      });
      expect(response.content.filter((b: any) => b.type === 'tool_use')).toHaveLength(2);
      expect(response.content.filter((b: any) => b.type === 'tool_result')).toHaveLength(2);
      const messages = convert([{ role: 'assistant', content: response.content }], { toolResultImages: 'media' });
      if (path === 'complete') await adapter.complete({ model: c.model, messages });
      else await adapter.stream({ model: c.model, messages }, { onChunk() {} });
      const wire = bodies.at(-1).messages;
      const callIndex = wire.findIndex((m: any) => m.tool_calls?.length);
      expect(callIndex).toBe(0);
      expect(wire[callIndex].role).toBe('assistant');
      expect(wire.slice(callIndex + 1, callIndex + 3).map((m: any) => m.role)).toEqual(['tool', 'tool']);
      expect(wire.slice(callIndex + 1, callIndex + 3).map((m: any) => m.tool_call_id)).toEqual(wire[callIndex].tool_calls.map((t: any) => t.id));
      expect(JSON.stringify(wire).includes(data)).toBe(kind === 'supported');
    });
  });
});

describe.each(cases.filter(c => c.gemini))('$name wrapper transport policy', c => {

  it.each(['complete', 'stream'])('%s preserves legacy sanitation bytes for source-less image-typed tool data', async path => {
    const legacyNotice = '[system: an image that belongs here was NOT shown to you — its media type "undefined" is not accepted by the model API (only jpeg/png/gif/webp are). You are not seeing this image. If it matters, ask for it in a supported format.]';
    const shapes = [
      { type: 'image', title: 'Cat', width: 640 },
      { type: 'image', source: null },
      { type: 'image', data: 'MCP_IMAGE_BASE64', mimeType: 'image/png' },
    ];
    const { bodies } = stub(c);
    const membrane = new Membrane(c.adapter(), { formatter: new NativeFormatter() });
    for (const shape of shapes) {
      const req = request(c);
      req.tools = undefined; // Exercise formatter-built streaming history too.
      req.messages[2]!.content = [result('one', [shape]), result('two', 'plain')] as any;
      if (path === 'complete') await membrane.complete(req);
      else await membrane.stream(req);
      const response = bodies.at(-1).contents.flatMap((m: any) => m.parts).find((p: any) => p.functionResponse).functionResponse;
      expect(response.response.result).toBe(JSON.stringify([text(legacyNotice)]));
    }
  });

  it('forwards its declared policy through a renamed wrapper to complete-history formatting', async () => {
    const inner = c.adapter();
    const adapter = {
      name: 'renamed-transport',
      toolResultImageMediaTypes: inner.toolResultImageMediaTypes,
      supportsModel: inner.supportsModel.bind(inner),
      complete: inner.complete.bind(inner),
      stream: inner.stream.bind(inner),
    };
    const bytes = Buffer.from('\x00\x00\x00\x18ftypheic\x00\x00\x00\x00heic').toString('base64');
    const req = request(c);
    req.messages[2]!.content = [
      result('one', [{ type: 'image', source: { type: 'base64', data: bytes, mediaType: 'image/heic' } }]),
      result('two', 'plain'),
    ] as any;
    const { bodies } = stub(c);
    await new Membrane(adapter, { formatter: new NativeFormatter() }).complete(req);
    expect(JSON.stringify(bodies[0])).toContain('"data":"' + bytes + '"');
  });
});
