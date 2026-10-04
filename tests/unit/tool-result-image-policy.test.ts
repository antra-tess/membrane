import { afterEach, describe, expect, it, vi } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { OpenAIAdapter } from '../../src/providers/openai.js';
import { OpenAICompatibleAdapter, toOpenAIMessages } from '../../src/providers/openai-compatible.js';
import { OpenRouterAdapter, toOpenRouterMessages } from '../../src/providers/openrouter.js';
import { GeminiAdapter } from '../../src/providers/gemini.js';
import { sseResponse } from '../helpers/sse-fixtures.js';
import type { ProviderAdapter, ProviderRequestOptions } from '../../src/types/index.js';

const data = 'iVBORw0KGgo=' + 'A'.repeat(256);
const image = { type: 'image', source: { type: 'base64', mediaType: 'image/png', data } };
const text = (text: string) => ({ type: 'text', text });
const call = (id: string, name = 'snapshot') => ({ type: 'tool_use', id, name, input: {} });
const result = (id: string, content: any[]) => ({ type: 'tool_result', toolUseId: id, content });
const messages = (images = true) => [
  { role: 'user', content: [text('look')] },
  { role: 'assistant', content: [call('one')] },
  { role: 'user', content: [result('one', [text('caption'), ...(images ? [image] : [])])] },
];
type Mode = 'auto' | 'media' | 'omit';
const providers = [
  { name: 'OpenAI', model: 'gpt-4o', auto: true, make: (toolResultImages?: Mode) => new OpenAIAdapter({ apiKey: 'test', toolResultImages }) },
  { name: 'compatible', model: 'vision-model', auto: false, make: (toolResultImages?: Mode) => new OpenAICompatibleAdapter({ baseURL: 'https://example.test/v1', toolResultImages }) },
  { name: 'OpenRouter', model: 'vendor/vision', auto: true, make: (toolResultImages?: Mode) => new OpenRouterAdapter({ apiKey: 'test', toolResultImages }) },
  { name: 'Gemini', model: 'gemini-3-flash', auto: true, make: (toolResultImages?: Mode) => new GeminiAdapter({ apiKey: 'test', toolResultImages }) },
];
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const catalogue = () => new Response(JSON.stringify({ data: [
  { id: 'vendor/vision', architecture: { input_modalities: ['text', 'image'] } },
  { id: 'vendor/text', architecture: { input_modalities: ['text'] } },
] }));
function stub(metadata: () => Promise<Response> | Response = catalogue, rounds = 0) {
  const bodies: any[] = [];
  const lookup = vi.fn(metadata);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/models')) return lookup();
    const body = JSON.parse(init!.body as string);
    bodies.push(body);
    const gemini = String(url).includes('generateContent') || String(url).includes('streamGenerateContent');
    if (gemini) {
      const parts = bodies.length <= rounds ? [{ functionCall: { name: 'snapshot', args: {} } }] : [{ text: 'done' }];
      const frame = { candidates: [{ content: { parts }, finishReason: bodies.length <= rounds ? 'FUNCTION_CALL' : 'STOP' }] };
      return String(url).includes('streamGenerateContent') ? sseResponse([JSON.stringify(frame)]) : new Response(JSON.stringify(frame));
    }
    const message = bodies.length <= rounds ? { tool_calls: [{ index: 0, id: 'live', type: 'function', function: { name: 'snapshot', arguments: '{}' } }] } : { content: 'done' };
    const finish_reason = bodies.length <= rounds ? 'tool_calls' : 'stop';
    return body.stream ? sseResponse([
      JSON.stringify({ choices: [{ delta: message, finish_reason }] }), '[DONE]',
    ]) : new Response(JSON.stringify({ choices: [{ message, finish_reason }] }));
  }));
  return { bodies, lookup };
}
function invoke(adapter: ProviderAdapter, method: string, model: string, options?: ProviderRequestOptions, input = messages()) {
  const req = { model, messages: input };
  return method === 'complete' ? adapter.complete(req, options) : adapter.stream(req, { onChunk() {} }, options);
}
const hasPixels = (body: unknown) => JSON.stringify(body).includes(data);

describe.each(providers)('$name capability policy', p => {
  it.each(['complete', 'stream'])('%s uses the adapter default only on first image use', async method => {
    const { bodies, lookup } = stub();
    const adapter = p.make();
    const getModelImageInput = vi.fn(() => undefined);
    await invoke(adapter, method, p.model, { getModelImageInput }, messages(false));
    expect(getModelImageInput).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    await invoke(adapter, method, p.model, { getModelImageInput });
    expect(hasPixels(bodies.at(-1))).toBe(p.auto);
    expect(getModelImageInput).toHaveBeenCalledExactlyOnceWith(p.model);
  });
  for (const mode of ['auto', 'media', 'omit'] as const) {
    for (const hint of [true, false, undefined]) {
      it.each(['complete', 'stream'])(mode + ' with registry ' + hint + ' via %s', async method => {
        const { bodies, lookup } = stub();
        const getModelImageInput = vi.fn(() => hint);
        const adapter = p.make(mode);
        await invoke(adapter, method, p.model, { getModelImageInput });
        expect(hasPixels(bodies[0])).toBe(mode === 'media' || (mode === 'auto' && (hint ?? p.auto)));
        expect(getModelImageInput).toHaveBeenCalledTimes(mode === 'auto' ? 1 : 0);
        expect(lookup).toHaveBeenCalledTimes(mode === 'auto' && hint === undefined && p.name === 'OpenRouter' ? 1 : 0);
        expect(JSON.stringify(bodies[0])).not.toContain('getModelImageInput');
      });
    }
  }
  it.each([true, false])('pins registry %s per model across complete and stream', async hint => {
    const { bodies, lookup } = stub();
    const adapter = p.make();
    const getModelImageInput = vi.fn(() => hint);
    await invoke(adapter, 'complete', p.model, { getModelImageInput });
    getModelImageInput.mockReturnValue(!hint);
    await invoke(adapter, 'stream', p.model, { getModelImageInput });
    expect(bodies.map(hasPixels)).toEqual([hint, hint]);
    expect(getModelImageInput).toHaveBeenCalledTimes(1);
    await invoke(adapter, 'complete', p.model + '-other', { getModelImageInput });
    expect(hasPixels(bodies.at(-1))).toBe(!hint);
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe('OpenAI text-only families', () => {
  it.each(['o1-mini', 'o1-mini-2024-09-12', 'o1-preview', 'o1-preview-2024-09-12', 'gpt-oss-20b', 'gpt-oss-120b', 'o3-mini', 'o3-mini-2025-01-31', 'gpt-3.5-turbo', 'gpt-4', 'gpt-4-0613', 'gpt-4-32k', 'gpt-4-1106-preview', 'gpt-4-0125-preview', 'gpt-4-turbo-preview'])('%s defaults to omission', async model => {
    const { bodies } = stub();
    await invoke(providers[0]!.make(), 'complete', model);
    expect(hasPixels(bodies[0])).toBe(false);
  });
  it.each(['gpt-4o', 'gpt-4.1', 'gpt-4-turbo', 'gpt-4-turbo-2024-04-09', 'gpt-4-vision-preview', 'o1', 'o3'])('%s retains media', async model => {
    const { bodies } = stub();
    await invoke(providers[0]!.make(), 'complete', model);
    expect(hasPixels(bodies[0])).toBe(true);
  });
});

describe('OpenRouter lookup and cancellation', () => {
  it.each(['vendor/text', 'vendor/unknown'])('%s omits with one cached catalogue across models', async model => {
    const { bodies, lookup } = stub();
    const adapter = providers[2]!.make();
    await invoke(adapter, 'complete', model);
    await invoke(adapter, 'stream', 'vendor/vision');
    expect(bodies.map(hasPixels)).toEqual([false, true]);
    expect(lookup).toHaveBeenCalledTimes(1);
  });
  it.each(['reject', 'http', 'json', 'shape'])('pins omission on lookup failure: %s', async failure => {
    const { bodies, lookup } = stub(() => {
      if (failure === 'reject') throw new Error('offline');
      if (failure === 'http') return new Response('', { status: 503 });
      if (failure === 'json') return new Response('not json');
      return new Response(JSON.stringify({ data: {} }));
    });
    const adapter = providers[2]!.make();
    await invoke(adapter, 'complete', 'vendor/vision');
    lookup.mockImplementation(catalogue);
    await invoke(adapter, 'stream', 'vendor/vision');
    expect(bodies.map(hasPixels)).toEqual([false, false]);
    expect(lookup).toHaveBeenCalledTimes(1);
  });
  it('shares concurrent resolution without one caller abort cancelling the lookup', async () => {
    let finish!: (value: Response) => void;
    const { bodies, lookup } = stub(() => new Promise(resolve => { finish = resolve; }));
    const adapter = providers[2]!.make();
    const controller = new AbortController();
    const first = invoke(adapter, 'complete', 'vendor/vision', { signal: controller.signal }).catch(error => error);
    const second = invoke(adapter, 'stream', 'vendor/vision');
    controller.abort();
    expect(await first).toMatchObject({ type: 'abort' });
    expect(lookup).toHaveBeenCalledTimes(1);
    finish(catalogue());
    await second;
    await invoke(adapter, 'complete', 'vendor/vision');
    expect(bodies.map(hasPixels)).toEqual([true, true]);
    expect(lookup).toHaveBeenCalledTimes(1);
  });
  it('rejects an already-cancelled caller without fetching or resolving a decision', async () => {
    const { bodies, lookup } = stub();
    const adapter = providers[2]!.make();
    const signal = AbortSignal.abort();
    await expect(invoke(adapter, 'complete', 'vendor/vision', { signal })).rejects.toMatchObject({ type: 'abort' });
    expect(lookup).not.toHaveBeenCalled();
    await invoke(adapter, 'complete', 'vendor/vision');
    expect(bodies.map(hasPixels)).toEqual([true]);
  });
  it('includes metadata time in the caller deadline and retains its timeout provenance', async () => {
    vi.useFakeTimers();
    let finish!: (value: Response) => void;
    const { bodies } = stub(() => new Promise(resolve => { finish = resolve; }));
    const adapter = providers[2]!.make();
    const first = invoke(adapter, 'complete', 'vendor/vision', { timeoutMs: 20 }).catch(error => error);
    await vi.advanceTimersByTimeAsync(20);
    expect(await first).toMatchObject({ type: 'timeout', name: 'TimeoutAbortError' });
    expect(bodies).toHaveLength(0);
    finish(catalogue());
    await invoke(adapter, 'stream', 'vendor/vision');
    expect(bodies.map(hasPixels)).toEqual([true]);
  });
  it('bounds a hung catalogue even when its fetch ignores abort', async () => {
    vi.useFakeTimers();
    const { bodies, lookup } = stub(() => new Promise(() => {}));
    const adapter = providers[2]!.make();
    const pending = invoke(adapter, 'complete', 'vendor/vision');
    await vi.advanceTimersByTimeAsync(5000);
    await pending;
    expect(bodies.map(hasPixels)).toEqual([false]);
    await invoke(adapter, 'stream', 'vendor/vision');
    expect(lookup).toHaveBeenCalledTimes(1);
  });
});

describe('registry hints at the final Membrane call doors', () => {
  it.each(['complete', 'stream', 'yielding'])('%s asks about the post-hook effective wire model outside serialized bytes', async method => {
    const { bodies, lookup } = stub();
    const requested: string[] = [];
    const registry = {
      getCapabilities(model: string) { requested.push(model); return { media: { imageInput: model === 'vendor/vision' } }; },
      getPricing() { return undefined; },
    } as any;
    const hookRequests: unknown[] = [];
    const receipts: unknown[] = [];
    const membrane = new Membrane(providers[2]!.make(), {
      registry, formatter: new NativeFormatter(),
      hooks: { beforeRequest(_normal: unknown, provider: any) {
        hookRequests.push(structuredClone(provider));
        return { ...provider, model: 'vendor/text', extra: { ...provider.extra, model: 'vendor/vision' } };
      } },
    });
    const req: any = {
      config: { model: 'vendor/original', maxTokens: 32 },
      assistantParticipant: 'Assistant', toolMode: 'native',
      messages: messages().map(m => ({ participant: m.role === 'assistant' ? 'Assistant' : 'User', content: m.content })),
      onCacheWireReceipt: (receipt: unknown) => receipts.push(receipt),
    };
    if (method === 'complete') await membrane.complete(req);
    else if (method === 'stream') await membrane.stream(req);
    else for await (const event of membrane.streamYielding(req)) { if (event.type === 'error') throw event.error; }
    expect(requested).toEqual(['vendor/vision']);
    expect(bodies[0].model).toBe('vendor/vision');
    expect(hasPixels(bodies[0])).toBe(true);
    expect(lookup).not.toHaveBeenCalled();
    expect(receipts).toHaveLength(1);
    expect(JSON.stringify([hookRequests, receipts, bodies])).not.toContain('getModelImageInput');
  });
});

describe('native Chat image boundaries', () => {
  for (const p of providers.slice(0, 3)) {
    it(p.name + ' gates serialized native role:tool media', async () => {
      const { bodies } = stub();
      const native = [{ role: 'tool', tool_call_id: 'one', content: [text('caption'), { type: 'image_url', image_url: { url: 'data:image/png;base64,' + data } }] }];
      await invoke(p.make('omit'), 'complete', p.model, undefined, native);
      expect(hasPixels(bodies[0])).toBe(false);
      expect(bodies[0].messages[0].tool_call_id).toBe('one');
      expect(bodies[0].messages[0].content).toContain('NOT shown');
    });
    it(p.name + ' validates user image_url media without pretending it is a tool image', async () => {
      const { bodies } = stub();
      const native = [{ role: 'user', content: [text('caption'), ...[
        'file:///tmp/private.png', 'https://', 'data:image/svg+xml;base64,PHN2Zy8+',
        'data:image/svg+xml;base64,' + data, 'https://example.test/image.png',
      ].map(url => ({ type: 'image_url', image_url: { url, detail: 'high' } }))] }];
      const before = structuredClone(native);
      await invoke(p.make('omit'), 'complete', p.model, undefined, native);
      const wire = JSON.stringify(bodies[0]);
      expect(wire).not.toContain('file:');
      expect(wire).not.toContain('PHN2Zy8+');
      expect(wire).toContain('data:image/png;base64,' + data);
      expect(wire).toContain('https://example.test/image.png');
      expect(wire).toContain('"detail":"high"');
      expect(native).toEqual(before);
    });
  }
  it.each([toOpenAIMessages, toOpenRouterMessages])('synchronous helper defaults to omission and takes explicit resolved media', convert => {
    expect(hasPixels(convert(messages() as any))).toBe(false);
    expect(hasPixels(convert(messages() as any, { toolResultImages: 'media' }))).toBe(true);
    expect(hasPixels(convert(messages() as any, { toolResultImages: 'omit' }))).toBe(false);
  });
  it('serialized helper relocation is ordinary explicit user media at the next adapter boundary', async () => {
    const native = JSON.parse(JSON.stringify(toOpenAIMessages(messages() as any, { toolResultImages: 'media' })));
    const { bodies } = stub();
    await invoke(providers[0]!.make('omit'), 'complete', 'o3-mini', undefined, native);
    expect(hasPixels(bodies[0])).toBe(true);
  });
});

describe('Gemini names and prefix stability', () => {
  it.each(['gemini-2.5-flash', 'gemini-3-flash', 'gemini-flash-latest'].flatMap(model => (['auto', 'media', 'omit'] as const).map(mode => ({ model, mode }))))('$model $mode recovers names before images arrive and keeps earlier contents unchanged', async ({ model, mode }) => {
    const { bodies } = stub();
    const adapter = providers[3]!.make(mode);
    const earlier = messages(false);
    await invoke(adapter, 'complete', model, undefined, earlier);
    const later = [...earlier, { role: 'assistant', content: [call('two', 'inspect')] },
      { role: 'user', content: [result('two', [image])] }];
    await invoke(adapter, 'complete', model, undefined, later);
    await invoke(adapter, 'complete', model, undefined, earlier);
    expect(bodies[0].contents[2].parts[0].functionResponse.name).toBe('snapshot');
    expect(bodies[1].contents.slice(0, bodies[0].contents.length)).toEqual(bodies[0].contents);
    expect(bodies[2]).toEqual(bodies[0]);
  });
  it('keeps explicit names and the unknown fallback', async () => {
    const { bodies } = stub();
    await invoke(providers[3]!.make(), 'complete', 'gemini-3-flash', undefined, [
      { role: 'assistant', content: [call('one')] },
      { role: 'user', content: [
        { ...result('one', [text('ok')]), name: 'explicit' },
        { type: 'tool_result', content: 'ok' },
      ] },
    ] as any);
    expect(bodies[0].contents.flatMap((m: any) => m.parts).filter((p: any) => p.functionResponse).map((p: any) => p.functionResponse.name)).toEqual(['explicit', 'unknown']);
  });
});

describe.each(providers)('$name live capability resolution', p => {
  for (const [mode, hint] of [['auto', undefined], ['auto', false], ['media', false], ['omit', true]] as const) {
    it.each(['stream', 'yielding'])(mode + ' registry ' + hint + ' via %s resolves at the image-bearing continuation', async method => {
      const { bodies, lookup } = stub(catalogue, 1);
      const getCapabilities = vi.fn(() => hint === undefined ? undefined : { media: { imageInput: hint } });
      const membrane = new Membrane(p.make(mode), {
        formatter: new NativeFormatter(),
        registry: { getCapabilities, getPricing() { return undefined; } } as any,
      });
      const req: any = {
        config: { model: p.model, maxTokens: 32 }, assistantParticipant: 'Assistant', toolMode: 'native',
        messages: [{ participant: 'User', content: [text('look')] }],
        tools: [{ name: 'snapshot', description: 'screenshot', inputSchema: { type: 'object', properties: {} } }],
      };
      const outputs = (calls: any[]) => {
        expect(getCapabilities).not.toHaveBeenCalled();
        expect(lookup).not.toHaveBeenCalled();
        return calls.map(call => ({ toolUseId: call.id, content: [text('caption'), image] }));
      };
      if (method === 'stream') await membrane.stream(req, { onToolCalls: async calls => outputs(calls) as any });
      else {
        const stream = membrane.streamYielding(req);
        for await (const event of stream) {
          if (event.type === 'tool-calls') stream.provideToolResults(outputs(event.calls) as any);
          if (event.type === 'error') throw event.error;
        }
      }
      const expected = mode === 'media' || (mode === 'auto' && (hint ?? p.auto));
      expect(bodies.map(hasPixels)).toEqual([false, expected]);
      expect(getCapabilities).toHaveBeenCalledTimes(mode === 'auto' ? 1 : 0);
      expect(lookup).toHaveBeenCalledTimes(mode === 'auto' && hint === undefined && p.name === 'OpenRouter' ? 1 : 0);
    });
  }
});

describe('resolution edge cases', () => {
  it('keeps a failed catalogue snapshot for new models, while their registry hints can still win', async () => {
    const { bodies, lookup } = stub(() => { throw new Error('offline'); });
    const adapter = providers[2]!.make();
    await invoke(adapter, 'complete', 'vendor/vision');
    lookup.mockImplementation(catalogue);
    await invoke(adapter, 'complete', 'vendor/new');
    await invoke(adapter, 'complete', 'vendor/registry', { getModelImageInput: () => true });
    await invoke(adapter, 'complete', 'vendor/vision', { getModelImageInput: () => true });
    expect(bodies.map(hasPixels)).toEqual([false, false, true, false]);
    expect(lookup).toHaveBeenCalledTimes(1);
    await invoke(providers[2]!.make(), 'complete', 'vendor/vision');
    expect(hasPixels(bodies.at(-1))).toBe(true);
    expect(lookup).toHaveBeenCalledTimes(2);
  });
  it('bounds a catalogue body read that never finishes', async () => {
    vi.useFakeTimers();
    const { bodies } = stub(() => ({ ok: true, json: () => new Promise(() => {}) }) as any);
    const pending = invoke(providers[2]!.make(), 'complete', 'vendor/vision');
    await vi.advanceTimersByTimeAsync(5000);
    await pending;
    expect(bodies.map(hasPixels)).toEqual([false]);
  });
  it('keeps one deadline budget across the lookup and inference', async () => {
    vi.useFakeTimers();
    let finish!: (response: Response) => void;
    const apiSignals: AbortSignal[] = [];
    vi.stubGlobal('fetch', vi.fn((url, init) => {
      if (String(url).endsWith('/models')) return new Promise(resolve => { finish = resolve; });
      apiSignals.push(init.signal);
      return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    }));
    const pending = invoke(providers[2]!.make(), 'stream', 'vendor/vision', { timeoutMs: 100 }).catch(error => error);
    await vi.advanceTimersByTimeAsync(60);
    finish(catalogue());
    await vi.advanceTimersByTimeAsync(0);
    expect(apiSignals).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(40);
    expect(apiSignals[0]!.aborted).toBe(true);
    expect(await pending).toMatchObject({ type: 'timeout', name: 'TimeoutAbortError' });
  });
  it('shares the first model decision even when a concurrent caller has different registry knowledge', async () => {
    let finish!: (response: Response) => void;
    const { bodies, lookup } = stub(() => new Promise(resolve => { finish = resolve; }));
    const adapter = providers[2]!.make();
    const first = invoke(adapter, 'complete', 'vendor/vision');
    const getModelImageInput = vi.fn(() => false);
    const second = invoke(adapter, 'stream', 'vendor/vision', { getModelImageInput });
    finish(catalogue());
    await Promise.all([first, second]);
    expect(bodies.map(hasPixels)).toEqual([true, true]);
    expect(getModelImageInput).not.toHaveBeenCalled();
    expect(lookup).toHaveBeenCalledTimes(1);
  });
  it.each(providers.slice(0, 3))('$name keys a direct extra.model override by the wire model', async p => {
    const { bodies } = stub();
    const getModelImageInput = vi.fn(model => model === 'effective');
    const adapter = p.make();
    await adapter.complete({ model: p.model, messages: messages(), extra: { model: 'effective' } }, { getModelImageInput });
    await invoke(adapter, 'complete', p.model, { getModelImageInput });
    expect(getModelImageInput.mock.calls).toEqual([['effective'], [p.model]]);
    expect(bodies.map(hasPixels)).toEqual([true, false]);
    expect(bodies[0].model).toBe('effective');
  });
  it.each(providers)('$name omit never serializes normalized data URLs as text', async p => {
    const { bodies } = stub();
    const input = messages(false);
    (input[2]!.content as any) = [result('one', [text('caption'), { type: 'image', source: { type: 'url', url: 'data:image/png;base64,' + data } }])];
    await invoke(p.make('omit'), 'complete', p.model, undefined, input);
    expect(hasPixels(bodies[0])).toBe(false);
  });
});

describe('native override and observer boundaries', () => {
  it.each(providers.flatMap(p => [false, true].map(empty => ({ ...p, empty }))))('$name empty=$empty keeps whole native overrides caller-owned without freezing unused conversion', async p => {
    const { bodies, lookup } = stub();
    const adapter = p.make();
    const key = p.name === 'Gemini' ? 'contents' : 'messages';
    const native = p.empty ? [] : p.name === 'Gemini'
      ? [{ role: 'user', parts: [{ text: 'native passthrough' }, { inlineData: { mimeType: 'image/png', data } }] }]
      : [{ role: 'tool', tool_call_id: 'native', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + data } }] }];
    const getModelImageInput = vi.fn(() => false);
    const request = { model: p.model, messages: messages(), extra: { [key]: native } };
    const before = structuredClone(request);
    await adapter.complete(request, { getModelImageInput });
    expect(bodies[0][key]).toEqual(native);
    expect(getModelImageInput).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    expect(request).toEqual(before);
    getModelImageInput.mockReturnValue(true);
    await invoke(adapter, 'stream', p.model, { getModelImageInput });
    expect(hasPixels(bodies[1])).toBe(true);
    expect(getModelImageInput).toHaveBeenCalledExactlyOnceWith(p.model);
  });
  it.each(['complete', 'stream'])('OpenRouter %s preserves observer errors and cleans up its deadline', async method => {
    vi.useFakeTimers();
    const { bodies } = stub();
    const failure = new Error('observer rejected request');
    await expect(invoke(providers[2]!.make('media'), method, 'vendor/vision', {
      timeoutMs: 100,
      onRequest() { throw failure; },
    })).rejects.toBe(failure);
    expect(bodies).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('review regressions', () => {
  for (const [name, convert] of [['OpenAI', toOpenAIMessages], ['OpenRouter', toOpenRouterMessages]] as const) {
    it.each([undefined, 'omit', 'media'] as const)(name + ' helper %s keeps omitted-image results ahead of sibling user text', mode => {
      const input = messages();
      (input[2]!.content as any[]).push(text('interloper'));
      const output = convert(input as any, { toolResultImages: mode });
      const callIndex = output.findIndex(m => m.role === 'assistant');
      expect(output[callIndex + 1]).toMatchObject({ role: 'tool', tool_call_id: 'one' });
      expect(output.at(-1)).toMatchObject({ role: 'user', content: 'interloper' });
    });
    it(name + ' helper preserves an image-free array own toJSON', () => {
      const content: any = [text('raw internal')];
      content.toJSON = () => [text('serialized public')];
      const output = convert([{ role: 'user', content: [result('one', content)] }] as any);
      expect(JSON.stringify(output)).toContain('serialized public');
      expect(JSON.stringify(output)).not.toContain('raw internal');
    });
  }
  it.each(providers)('$name preserves image-free array own toJSON on the wire', async p => {
    const { bodies } = stub();
    const content: any = [text('raw internal')];
    content.toJSON = () => [text('serialized public')];
    const input = messages(false);
    (input[2]!.content as any) = [result('one', content)];
    await invoke(p.make(), 'complete', p.model, undefined, input);
    expect(JSON.stringify(bodies[0])).toContain('serialized public');
    expect(JSON.stringify(bodies[0])).not.toContain('raw internal');
  });
  for (const p of providers.slice(0, 3)) {
    it.each(['inherited', 'non-enumerable'])(p.name + ' ignores %s extra.model for capability selection', async kind => {
      const { bodies } = stub();
      const extra = kind === 'inherited' ? Object.create({ model: 'vision-shadow' })
        : Object.defineProperty({}, 'model', { value: 'vision-shadow', enumerable: false });
      const getModelImageInput = vi.fn(model => model === 'vision-shadow');
      await p.make().complete({ model: p.model, messages: messages(), extra }, { getModelImageInput });
      expect(bodies[0].model).toBe(p.model);
      expect(getModelImageInput).toHaveBeenCalledExactlyOnceWith(p.model);
      expect(hasPixels(bodies[0])).toBe(false);
    });
    for (const mode of ['media', 'omit'] as const) {
      it.each([true, false])(p.name + ' native siblings survive ' + mode + ' with valid image=%s', async valid => {
        const { bodies } = stub();
        const audio = { type: 'input_audio', input_audio: { data: 'AUDIO_BYTES', format: 'wav' } };
        const input = [{ role: 'tool', tool_call_id: 'one', content: [text('caption'),
          { type: 'image_url', image_url: { url: valid ? 'data:image/png;base64,' + data : 'file:///tmp/image.png' } },
          audio, text('after'),
        ] }];
        const before = structuredClone(input);
        await invoke(p.make(mode), 'complete', p.model, undefined, input);
        const tool = bodies[0].messages.find((m: any) => m.role === 'tool');
        expect(tool.tool_call_id).toBe('one');
        expect(tool.content).toEqual(expect.arrayContaining([audio, text('caption'), text('after')]));
        expect(tool.content[2]).toEqual(audio);
        expect(hasPixels(bodies[0])).toBe(mode === 'media' && valid);
        const users = bodies[0].messages.filter((m: any) => m.role === 'user');
        expect(JSON.stringify(users)).not.toContain('AUDIO_BYTES');
        expect(input).toEqual(before);
      });
    }
  }
});

describe('review model getter regression', () => {
  for (const p of providers.slice(0, 3)) {
    it.each(['complete', 'stream'])(p.name + ' %s shares one captured extra.model read with the wire', async method => {
      const { bodies } = stub();
      const getter = vi.fn().mockReturnValueOnce('vision-selected').mockReturnValue('text-second-read');
      const extra = Object.defineProperty({}, 'model', { get: getter, enumerable: true });
      const getModelImageInput = vi.fn(model => model === 'vision-selected');
      const adapter = p.make();
      const request = { model: p.model, messages: messages(), extra };
      if (method === 'complete') await adapter.complete(request, { getModelImageInput });
      else await adapter.stream(request, { onChunk() {} }, { getModelImageInput });
      expect(getter).toHaveBeenCalledTimes(1);
      expect(bodies[0].model).toBe('vision-selected');
      expect(getModelImageInput).toHaveBeenCalledExactlyOnceWith(bodies[0].model);
      expect(hasPixels(bodies[0])).toBe(true);
    });
  }
});


describe('review async model snapshot', () => {
  it('pins the sent model to the input observed before the catalogue wait', async () => {
    let finish!: (response: Response) => void;
    const { bodies } = stub(() => new Promise(resolve => { finish = resolve; }));
    const request = { model: 'vendor/vision', messages: messages() };
    const pending = providers[2]!.make().complete(request);
    request.model = 'vendor/text';
    finish(catalogue());
    await pending;
    expect(bodies[0].model).toBe('vendor/vision');
    expect(hasPixels(bodies[0])).toBe(true);
  });
});

describe('review fine-tuned OpenAI families', () => {
  it.each([
    ['ft:gpt-3.5-turbo-0125:org:agent:abc', false],
    ['ft:gpt-3.5-turbo:org:agent:def', false],
    ['ft:gpt-4o-2024-08-06:org:agent:ghi', true],
    ['ft:gpt-4.1-2025-04-14:org:agent:jkl', true],
  ] as const)('%s follows the base default', async (model, expected) => {
    const { bodies } = stub();
    await invoke(providers[0]!.make(), 'complete', model);
    expect(bodies[0].model).toBe(model);
    expect(hasPixels(bodies[0])).toBe(expected);
  });
  it('keeps full fine-tuned IDs for registry lookup and separate pinned decisions', async () => {
    const { bodies } = stub();
    const first = 'ft:gpt-3.5-turbo-0125:org:agent:one';
    const second = 'ft:gpt-3.5-turbo-0125:org:agent:two';
    const getModelImageInput = vi.fn(model => model === first);
    const adapter = providers[0]!.make();
    await invoke(adapter, 'complete', first, { getModelImageInput });
    await invoke(adapter, 'stream', second, { getModelImageInput });
    await invoke(adapter, 'complete', first, { getModelImageInput: () => false });
    expect(getModelImageInput.mock.calls).toEqual([[first], [second]]);
    expect(bodies.map(body => body.model)).toEqual([first, second, first]);
    expect(bodies.map(hasPixels)).toEqual([true, false, true]);
  });
});

describe('review accessor-backed request compatibility', () => {
  for (const p of providers) {
    for (const kind of ['class getters', 'non-enumerable own fields']) {
      it.each(['complete', 'stream'])(p.name + ' %s preserves image-free ' + kind, async method => {
        const { bodies } = stub();
        let modelReads = 0;
        class AccessorRequest {
          #model = p.model;
          #messages = [{ role: 'user', content: 'hello' }];
          get model() { modelReads++; return this.#model; }
          get messages() { return this.#messages; }
          get maxTokens() { return 32; }
          get temperature() { return 0.4; }
        }
        const request = kind === 'class getters' ? new AccessorRequest() : Object.defineProperties({}, {
          model: { get() { modelReads++; return p.model; }, enumerable: false },
          messages: { value: [{ role: 'user', content: 'hello' }], enumerable: false },
          maxTokens: { value: 32, enumerable: false },
          temperature: { value: 0.4, enumerable: false },
        });
        const getModelImageInput = vi.fn(() => undefined);
        const adapter = p.make();
        if (method === 'complete') await adapter.complete(request as any, { getModelImageInput });
        else await adapter.stream(request as any, { onChunk() {} }, { getModelImageInput });
        expect(modelReads).toBe(1);
        expect(getModelImageInput).not.toHaveBeenCalled();
        if (p.name === 'Gemini') {
          expect(bodies[0]).toMatchObject({
            contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
            generationConfig: { maxOutputTokens: 32, temperature: 0.4 },
          });
        } else {
          expect(bodies[0]).toMatchObject({ model: p.model, messages: [{ role: 'user', content: 'hello' }], max_tokens: 32, temperature: 0.4 });
        }
      });
    }
  }
});
