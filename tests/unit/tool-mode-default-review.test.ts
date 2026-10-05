import { OpenAIResponsesAdapter } from '../../src/providers/openai-responses.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { AnthropicXmlFormatter } from '../../src/formatters/anthropic-xml.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { CompletionsFormatter } from '../../src/formatters/completions.js';
import { MockAdapter } from '../../src/providers/mock.js';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { BedrockAdapter } from '../../src/providers/bedrock.js';
import { OpenAIAdapter } from '../../src/providers/openai.js';
import { OpenRouterAdapter } from '../../src/providers/openrouter.js';
import { OpenAICompatibleAdapter } from '../../src/providers/openai-compatible.js';
import { OpenAICompletionsAdapter } from '../../src/providers/openai-completions.js';
import { supportsAssistantPrefill } from '../../src/registry/model-capabilities.js';
import { sseResponse } from '../helpers/sse-fixtures.js';

const tool = { name: 'lookup', description: 'look up a record', inputSchema: { type: 'object' as const, properties: {} } };
const text = (text: string) => ({ type: 'text' as const, text });
const req = (withTools = false, model = 'claude-sonnet-4-6'): any => ({
  assistantParticipant: 'Agent', config: { model, maxTokens: 32 },
  messages: [{ participant: 'User', content: [text('hello')] }],
  ...(withTools ? { tools: [tool] } : {}),
});
const mock = () => new MockAdapter({ defaultResponse: 'done', completeDelayMs: 0, streamChunkDelayMs: 0 });
afterEach(() => vi.unstubAllGlobals());

async function run(path: string, membrane: Membrane, request: any, options: any = {}): Promise<any> {
  if (path === 'complete') return membrane.complete(request, options);
  if (path === 'stream') return membrane.stream(request, options);
  let result: any;
  for await (const event of membrane.streamYielding(request, options)) {
    if (event.type === 'error') throw event.error;
    if (event.type === 'complete') result = event.response;
  }
  return result;
}

function http() {
  const bodies: any[] = [];
  const fetch = vi.fn(async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    const response = {
      id: 'test', model: body.model, content: [text('done')], stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1, prompt_tokens: 1, completion_tokens: 1 },
      choices: [{ message: { content: 'done' }, delta: { content: 'done' }, text: 'done', finish_reason: 'stop' }],
    };
    return body.stream
      ? sseResponse([JSON.stringify(response), '[DONE]'])
      : new Response(JSON.stringify(response));
  });
  vi.stubGlobal('fetch', fetch);
  return { bodies, fetch };
}

describe('usable default/native construction', () => {
  for (const mode of [undefined, 'auto', 'native']) {
    for (const tools of [false, true]) {
      it.each(['complete', 'stream', 'yielding'])(String(mode) + ' tools=' + tools + ' via %s uses real native chat', async path => {
        const adapter = mock();
        const request = { ...req(tools), toolMode: mode, contextPrefix: 'seed context', stopSequences: ['CUSTOM_STOP'] };
        const before = structuredClone(request);
        await run(path, new Membrane(adapter), request);
        const wire: any = adapter.getLastRequest();
        expect(wire.messages.at(-1)).toEqual({ role: 'user', content: [text('User: hello')] });
        expect(JSON.stringify(wire.messages)).toContain('seed context');
        expect(wire.stopSequences).toContain('CUSTOM_STOP');
        expect(Boolean(wire.tools?.length)).toBe(tools);
        expect(JSON.stringify(wire)).not.toContain('CLI simulation mode');
        expect(JSON.stringify(wire)).not.toContain('requestContext');
        expect(request).toEqual(before);
      });
    }
  }
  it.each(['complete', 'stream'])('%s respects constructor and per-call formatter selection', async path => {
    const adapter = mock();
    const formatter = new AnthropicXmlFormatter({ toolMode: 'native' });
    await run(path, new Membrane(adapter, { formatter: new AnthropicXmlFormatter({ toolMode: 'xml' }) }), req(true), { formatter });
    expect((adapter.getLastRequest() as any).messages.at(-1).role).toBe('user');
    expect((adapter.getLastRequest() as any).tools).toHaveLength(1);
  });
  it('yielding respects an explicitly native instance formatter', async () => {
    const adapter = mock();
    await run('yielding', new Membrane(adapter, { formatter: new AnthropicXmlFormatter({ toolMode: 'native' }) }), req(true));
    expect((adapter.getLastRequest() as any).messages.at(-1).role).toBe('user');
  });
  it.each(['complete', 'stream', 'yielding'])('%s uses the active native formatter build rather than bypassing its contract', async path => {
    const adapter = mock();
    const formatter = new NativeFormatter({ nameFormat: '[{name}] ' });
    const build = vi.spyOn(formatter, 'buildMessages');
    await run(path, new Membrane(adapter, { formatter }), { ...req(true), contextPrefix: 'seed', stopSequences: ['CUSTOM_STOP'] });
    expect(build).toHaveBeenCalledTimes(1);
    const wire: any = adapter.getLastRequest();
    expect(wire.messages.at(-1).content[0].text).toBe('[User] hello');
    expect(JSON.stringify(wire.messages)).toContain('seed');
    expect(wire.stopSequences).toContain('CUSTOM_STOP');
  });
  it.each(['complete', 'stream', 'yielding'])('%s preserves caller-authored assistant-ended history', async path => {
    const adapter = mock();
    const request = req(false, 'claude-haiku-4-5');
    request.messages.push({ participant: 'Agent', content: [text('authored assistant content')] });
    await run(path, new Membrane(adapter), request);
    const tail = (adapter.getLastRequest() as any).messages.at(-1);
    expect(tail).toEqual({ role: 'assistant', content: [text('authored assistant content')] });
  });
  it.each(['complete', 'stream', 'yielding'])('%s keeps explicit XML on an accepting model', async path => {
    const adapter = mock();
    await run(path, new Membrane(adapter), { ...req(true, 'claude-haiku-4-5'), toolMode: 'xml' });
    const wire: any = adapter.getLastRequest();
    expect(wire.messages.at(-1).role).toBe('assistant');
    expect(JSON.stringify(wire.messages)).toContain('lookup');
    expect(wire.tools).toBeUndefined();
  });
  for (const mode of [undefined, 'xml', 'native']) {
    it.each(['complete', 'stream', 'yielding'])('CompletionsFormatter tools mode=' + mode + ' via %s rejects instead of dropping declarations', async path => {
      const adapter = mock();
      await expect(run(path, new Membrane(adapter, { formatter: new CompletionsFormatter() }), { ...req(true, 'claude-haiku-4-5'), toolMode: mode }))
        .rejects.toMatchObject({ type: 'unsupported', retryable: false });
      expect(adapter.getRequestLog()).toHaveLength(0);
    });
  }
  it.each(['supportsNativeTools', 'supportsXmlTools'])('diagnoses a JS formatter missing %s', async field => {
    const adapter = mock();
    const formatter: any = new NativeFormatter();
    delete formatter[field];
    await expect(new Membrane(adapter, { formatter }).complete(req())).rejects.toThrow(new RegExp(field + '.*boolean'));
    expect(adapter.getRequestLog()).toHaveLength(0);
  });
});

describe('supported model spellings', () => {
  it.each([
    'bedrock:claude-sonnet-4-6',
    'anthropic/claude-sonnet-4.6',
    'anthropic/claude-opus-4.7',
    'anthropic/claude-opus-4.8',
    'claude-sonnet-4-6@20260301',
    'us.anthropic.claude-sonnet-4-6-v1:0',
    'bedrock:global.anthropic.claude-sonnet-4-6-v1:0',
    'claude-opus-5',
  ])('%s rejects assistant message prefill', model => expect(supportsAssistantPrefill(model)).toBe(false));
  it.each(['anthropic/claude-haiku-4.5', 'bedrock:claude-haiku-4-5', 'claude-sonnet-4-5', 'gpt-5', 'unknown'])('%s remains a positive control', model => {
    expect(supportsAssistantPrefill(model)).toBe(true);
  });
});

describe('actual message-transport prefill guard', () => {
  const adapters = [
    { name: 'Anthropic', make: () => new AnthropicAdapter({ apiKey: 'test', baseURL: 'https://example.test' }) },
    { name: 'Bedrock', make: () => new BedrockAdapter({ accessKeyId: 'test', secretAccessKey: 'test', region: 'us-east-1' }) },
    { name: 'OpenRouter', make: () => new OpenRouterAdapter({ apiKey: 'test' }) },
    { name: 'OpenAI', make: () => new OpenAIAdapter({ apiKey: 'test' }) },
    { name: 'compatible', make: () => new OpenAICompatibleAdapter({ baseURL: 'https://example.test/v1', providerName: 'renamed-chat' }) },
  ];
  for (const p of adapters) {
    it.each(['complete', 'stream'])(p.name + ' direct %s rejects an actual assistant tail before HTTP', async path => {
      const { fetch } = http();
      const request = { model: 'claude-sonnet-4-6', maxTokens: 32, messages: [
        { role: 'user', content: 'hello' }, { role: 'assistant', content: 'authored assistant tail' },
      ] };
      const adapter = p.make();
      const call = path === 'complete' ? adapter.complete(request) : adapter.stream(request, { onChunk() {} });
      await expect(call).rejects.toMatchObject({ type: 'unsupported', retryable: false });
      expect(fetch).not.toHaveBeenCalled();
    });
  }
  it.each(['complete', 'stream', 'yielding'])('%s checks a hook-selected final model and native message override', async path => {
    const { fetch } = http();
    const membrane = new Membrane(new OpenRouterAdapter({ apiKey: 'test' }), {
      formatter: new NativeFormatter(),
      hooks: { beforeRequest(_request, built: any) {
        return { ...built, extra: { ...built.extra, model: 'anthropic/claude-sonnet-4.6', messages: [
          { role: 'user', content: 'hello' }, { role: 'assistant', content: 'override tail' },
        ] } };
      } },
    });
    await expect(run(path, membrane, req(false, 'anthropic/claude-haiku-4.5')))
      .rejects.toMatchObject({ type: 'unsupported', retryable: false });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['stream', 'yielding'])('%s rejects an XML protocol needing future prefill even when its first body is user-ended', async path => {
    const { fetch } = http();
    const membrane = new Membrane(new OpenRouterAdapter({ apiKey: 'test' }), { formatter: new NativeFormatter() });
    await expect(run(path, membrane, { ...req(false, 'anthropic/claude-sonnet-4.6'), toolMode: 'xml' }))
      .rejects.toMatchObject({ type: 'unsupported', retryable: false });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('complete does not invent an XML continuation requirement for a user-ended body', async () => {
    const { bodies } = http();
    await new Membrane(new OpenRouterAdapter({ apiKey: 'test' }), { formatter: new NativeFormatter() })
      .complete({ ...req(false, 'anthropic/claude-sonnet-4.6'), toolMode: 'xml' });
    expect(bodies).toHaveLength(1);
    expect(bodies[0].messages.at(-1).role).toBe('user');
    expect(JSON.stringify(bodies[0])).not.toContain('requestContext');
  });
});

describe('actual prompt transport', () => {
  for (const formatter of ['default', 'completions']) {
    it.each(['complete', 'stream', 'yielding'])(formatter + ' formatter via %s works with a renamed text-completions adapter', async path => {
      const { bodies } = http();
      const adapter = new OpenAICompletionsAdapter({ baseURL: 'https://example.test/v1', providerName: 'renamed-prompt' });
      await run(path, new Membrane(adapter, formatter === 'default' ? {} : { formatter: new CompletionsFormatter() }), req());
      expect(bodies).toHaveLength(1);
      expect(typeof bodies[0].prompt).toBe('string');
      expect(bodies[0].prompt).toContain('hello');
      expect(bodies[0].messages).toBeUndefined();
    });
  }
  it.each(['complete', 'stream'])('direct %s rejects native tool definitions instead of dropping them', async path => {
    const { fetch } = http();
    const adapter = new OpenAICompletionsAdapter({ baseURL: 'https://example.test/v1', providerName: 'renamed-prompt' });
    const request = { model: 'claude-haiku-4-5', maxTokens: 32, messages: [{ role: 'user', content: 'hello' }], tools: [tool] };
    await expect(path === 'complete' ? adapter.complete(request) : adapter.stream(request, { onChunk() {} }))
      .rejects.toMatchObject({ type: 'unsupported', retryable: false });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['native', 'xml'])('%s declarations rejected through Membrane name the selected formatter', async mode => {
    const { fetch } = http();
    const adapter = new OpenAICompletionsAdapter({ baseURL: 'https://example.test/v1', providerName: 'renamed-prompt' });
    await expect(new Membrane(adapter).complete({ ...req(true, 'claude-haiku-4-5'), toolMode: mode }))
      .rejects.toThrow(/anthropic-xml.*(?:tools|tool).*prompt/i);
    expect(fetch).not.toHaveBeenCalled();
  });
});


describe('explicit prompt and cache ownership preservation', () => {
  it('preserves caller-owned XML prompt tools on a renamed prompt transport', async () => {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ choices: [{ text: '<function_calls><invoke name="lookup"></invoke></function_calls>', finish_reason: 'stop' }] }));
    }));
    const prompt = '<tools><tool name="lookup">Look up a record.</tool></tools>\nUser: Hello.\nAgent:';
    const membrane = new Membrane(new OpenAICompletionsAdapter({ baseURL: 'https://example.test', providerName: 'renamed-prompt' }));
    const response: any = await membrane.complete({ ...req(true), toolMode: 'xml', providerParams: { prompt } });
    expect(bodies[0].prompt).toBe(prompt);
    expect(bodies[0].tools).toBeUndefined();
    expect(response.toolCalls.map((call: any) => call.name)).toEqual(['lookup']);
  });
  const marked = () => Array.from({ length: 5 }, (_, i) => ({ participant: i % 2 ? 'Agent' : 'User', content: [text('message ' + i)], cacheBreakpoint: true }));
  const count = (value: any): number => !value || typeof value !== 'object' ? 0
    : Object.entries(value).reduce((total, [key, child]) => total + (key === 'cache_control' ? 1 : count(child)), 0);
  it('standalone NativeFormatter retains a complete-budget refusal', () => {
    expect(() => new NativeFormatter().buildMessages(marked(), {
      participantMode: 'multiuser', assistantParticipant: 'Agent', promptCaching: true,
    })).toThrow(/maximum 4/);
  });
  for (const policy of ['membrane-system', 'cm-owned'] as const) {
    it.each(['complete', 'stream', 'yielding'])(policy + ' %s uses the authoritative final policy', async path => {
      const adapter = mock();
      const input = { ...req(), messages: marked(), cacheMarkers: policy, promptCaching: true };
      const before = structuredClone(input);
      const pending = run(path, new Membrane(adapter, { formatter: new NativeFormatter() }), input);
      if (policy === 'cm-owned') {
        await expect(pending).rejects.toThrow(/maximum 4/);
        expect(adapter.getRequestLog()).toHaveLength(0);
      } else {
        await pending;
        expect(count(adapter.getLastRequest())).toBe(4);
      }
      expect(input).toEqual(before);
    });
  }
});

describe('XML continuation transport checks', () => {
  for (const image of [false, true]) {
    it.each(['stream', 'yielding'])('image=' + image + ' %s checks the hook-selected model before the second HTTP call', async path => {
      const bodies: any[] = [];
      const fetch = vi.fn(async (_url, init) => {
        bodies.push(JSON.parse(init.body));
        const content = bodies.length === 1 ? '<function_calls><invoke name="lookup"></invoke></function_calls>' : 'done';
        return sseResponse([JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] }), '[DONE]']);
      });
      vi.stubGlobal('fetch', fetch);
      let hooks = 0;
      let calls = 0;
      const membrane = new Membrane(new OpenRouterAdapter({ apiKey: 'test' }), {
        hooks: { beforeRequest(_request, built: any) {
          hooks++;
          return hooks === 1 ? built : { ...built, extra: { ...built.extra, model: 'anthropic/claude-sonnet-4.6' } };
        } },
      });
      const request = { ...req(true, 'anthropic/claude-haiku-4.5'), toolMode: 'xml' };
      const results = (toolCalls: any[]) => {
        calls++;
        return toolCalls.map(call => ({ toolUseId: call.id, content: image ? [
          text('screenshot'), { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'iVBORw0KGgo=' } },
        ] : 'tool output' }));
      };
      const operation = path === 'stream'
        ? membrane.stream(request, { onToolCalls: async toolCalls => results(toolCalls) as any })
        : (async () => {
          const stream = membrane.streamYielding(request);
          for await (const event of stream) {
            if (event.type === 'tool-calls') stream.provideToolResults(results(event.calls) as any);
            if (event.type === 'error') throw event.error;
          }
        })();
      await expect(operation).rejects.toMatchObject({ type: 'unsupported', retryable: false });
      expect(calls).toBe(1);
      expect(hooks).toBe(2);
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  }
});

describe('native complete tool names', () => {
  it.each(['module:lookup', 'literal__lookup'])('preserves the caller name %s in returned calls', async name => {
    const adapter: any = {
      name: 'name-echo', supportsModel() { return true; },
      async complete(request: any, options: any) {
        expect(request.tools[0].name).toBe(name.replace(/:/g, '__'));
        options?.onRequest?.(request);
        return { content: [{ type: 'tool_use', id: 'one', name: request.tools[0].name, input: {} }],
          stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 }, model: request.model, rawRequest: request, raw: {} };
      },
    };
    const response: any = await new Membrane(adapter).complete({ ...req(true, 'gpt-4o'), tools: [{ ...tool, name }] });
    expect(response.toolCalls[0].name).toBe(name);
    expect(response.content[0].name).toBe(name);
  });
});


describe('native loop tool-name restoration', () => {
  for (const name of ['module:lookup', 'literal__lookup']) {
    it.each(['stream', 'yielding'])(name + ' is preserved by %s', async path => {
      let round = 0;
      const names: string[] = [];
      const adapter: any = {
        name: 'name-echo', supportsModel: () => true,
        async stream(request: any, _callbacks: any, options: any) {
          options?.onRequest?.(request);
          const first = round++ === 0;
          return { content: first ? [{ type: 'tool_use', id: 'one', name: request.tools[0].name, input: {} }] : [text('done')],
            stopReason: first ? 'tool_use' : 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, model: request.model, rawRequest: request, raw: {} };
        },
      };
      const membrane = new Membrane(adapter);
      const request = { ...req(true, 'gpt-4o'), tools: [{ ...tool, name }] };
      const results = (calls: any[]) => calls.map(call => {
        names.push(call.name);
        return { toolUseId: call.id, content: 'ok' };
      });
      if (path === 'stream') await membrane.stream(request, { onToolCalls: async calls => results(calls) });
      else {
        const stream = membrane.streamYielding(request);
        for await (const event of stream) {
          if (event.type === 'tool-calls') stream.provideToolResults(results(event.calls));
          if (event.type === 'error') throw event.error;
        }
      }
      expect(names).toEqual([name]);
      expect(round).toBe(2);
    });
  }
  it.each(['complete', 'stream', 'yielding'])('%s refuses colliding encoded tool definitions before dispatch', async path => {
    const adapter = mock();
    await expect(run(path, new Membrane(adapter), { ...req(true), tools: [
      { ...tool, name: 'module:lookup' }, { ...tool, name: 'module__lookup' },
    ] })).rejects.toMatchObject({ type: 'unsupported', retryable: false, message: expect.stringContaining('collide') });
    expect(adapter.getRequestLog()).toHaveLength(0);
  });
});

describe('normalized request accessor preservation', () => {
  it.each(['complete', 'stream', 'yielding'])('%s keeps ordinary fields on their original receiver', async path => {
    class AccessorRequest {
      #data = req(true, 'gpt-4o');
      get config() { return this.#data.config; }
      get messages() { return this.#data.messages; }
      get tools() { return this.#data.tools; }
      get assistantParticipant() { return 'Agent'; }
      get contextPrefix() { return 'private prefix'; }
      get stopSequences() { return ['PRIVATE_STOP']; }
    }
    const input = new AccessorRequest();
    const adapter = mock();
    await run(path, new Membrane(adapter, { formatter: new NativeFormatter() }), input);
    expect(adapter.getLastRequest()?.model).toBe('gpt-4o');
    expect(adapter.getLastRequest()?.stopSequences).toContain('PRIVATE_STOP');
    expect(JSON.stringify(adapter.getLastRequest()?.messages)).toContain('private prefix');
    expect(input.messages).toEqual(req().messages);
  });
});

describe('native prompt metadata stays outside semantic receipts', () => {
  for (const kind of ['bigint', 'cyclic']) {
    it.each(['stream', 'yielding'])(kind + ' message metadata survives %s with a receipt consumer', async path => {
      const { fetch } = http();
      const metadata: any = kind === 'bigint' ? { opaqueId: 1n } : {};
      if (kind === 'cyclic') metadata.self = metadata;
      const input = { ...req(true, 'gpt-4o'), toolMode: 'native' };
      input.messages[0].metadata = metadata;
      const receipts: unknown[] = [];
      input.onCacheWireReceipt = (receipt: unknown) => receipts.push(receipt);
      await run(path, new Membrane(new OpenAIAdapter({ apiKey: 'test' })), input);
      expect(fetch).toHaveBeenCalledOnce();
      expect(receipts).toHaveLength(1);
      expect(input.messages[0].metadata).toBe(metadata);
    });
  }
  it.each(['stream', 'yielding'])('%s prompt serialization still receives original participant messages', async path => {
    const { bodies } = http();
    await run(path, new Membrane(new OpenAICompletionsAdapter({ baseURL: 'https://example.test', apiKey: 'test' })), req());
    expect(bodies[0].prompt).toContain('User: hello');
    expect(bodies[0].prompt).not.toContain('User: User:');
  });
});

describe('prompt extra-tools and remedies', () => {
  it.each(['complete', 'stream'])('direct %s refuses extra.tools and reads its getter once', async method => {
    const { fetch } = http();
    let reads = 0;
    const request: any = { model: 'test', messages: [{ role: 'user', content: 'hello' }],
      extra: { get tools() { reads++; return [tool]; } } };
    const adapter = new OpenAICompletionsAdapter({ baseURL: 'https://example.test', apiKey: 'test' });
    const operation = method === 'complete' ? adapter.complete(request) : adapter.stream(request, { onChunk() {} });
    await expect(operation).rejects.toMatchObject({ type: 'unsupported', retryable: false });
    expect(reads).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['complete', 'stream', 'yielding'])('%s refuses providerParams.tools instead of silently discarding them', async path => {
    const { fetch } = http();
    const input = { ...req(), providerParams: { tools: [tool] } };
    await expect(run(path, new Membrane(new OpenAICompletionsAdapter({ baseURL: 'https://example.test', apiKey: 'test' })), input))
      .rejects.toMatchObject({ type: 'unsupported', retryable: false });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('the Images adapter gives a usable remedy even when XML/prompt is already supplied', async () => {
    const { fetch } = http();
    const error = await new Membrane(new OpenAIResponsesAdapter({ apiKey: 'test' })).complete({
      ...req(true, 'gpt-image-1'), toolMode: 'xml', providerParams: { prompt: '<tools>lookup</tools> User: hello' },
    }).catch(error => error);
    expect(error).toMatchObject({ type: 'unsupported', retryable: false });
    expect(error.message).toContain('tool-capable transport');
    expect(error.message).not.toMatch(/explicit.*prompt/i);
    expect(fetch).not.toHaveBeenCalled();
  });
});


describe('prompt-source option contract', () => {
  it.each([
    ['sidecar', {}, 'from option'],
    ['explicit normalized', { normalizedMessages: [{ participant: 'User', content: [text('from extra')] }] }, 'from extra'],
    ['explicit undefined', { normalizedMessages: undefined }, 'from provider'],
    ['explicit null', { normalizedMessages: null }, 'from provider'],
    ['explicit prompt', { prompt: 'verbatim prompt', normalizedMessages: [{ participant: 'User', content: [text('from extra')] }] }, 'verbatim prompt'],
  ])('%s retains precedence over other prompt sources', async (_name, extra, expected) => {
    const { bodies } = http();
    await new OpenAICompletionsAdapter({ baseURL: 'https://example.test', apiKey: 'test' }).complete({
      model: 'test', messages: [{ role: 'user', content: 'from provider' }], extra: extra as any,
    }, { promptMessages: [{ participant: 'User', content: [text('from option')] }] });
    expect(bodies[0].prompt).toContain(expected);
    if (_name === 'explicit prompt') expect(bodies[0].prompt).toBe(expected);
  });
  it.each(['stream', 'yielding'])('%s forwards the current loop messages outside its request', async path => {
    const observed: Array<{ length: number; hasInternalMessages: boolean }> = [];
    const adapter: any = {
      name: 'option-observer', supportsModel: () => true,
      async stream(request: any, _callbacks: any, options: any) {
        observed.push({ length: options.promptMessages?.length ?? 0, hasInternalMessages: 'normalizedMessages' in (request.extra ?? {}) });
        options.onRequest?.(request);
        const first = observed.length === 1;
        return { content: first ? [{ type: 'tool_use', id: 'call', name: 'lookup', input: {} }] : [text('done')],
          stopReason: first ? 'tool_use' : 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, model: request.model, rawRequest: request, raw: {} };
      },
    };
    const membrane = new Membrane(adapter);
    const input = req(true, 'gpt-4o');
    const results = (calls: any[]) => calls.map(call => ({ toolUseId: call.id, content: 'ok' }));
    if (path === 'stream') await membrane.stream(input, { onToolCalls: async calls => results(calls) });
    else {
      const stream = membrane.streamYielding(input);
      for await (const event of stream) {
        if (event.type === 'tool-calls') stream.provideToolResults(results(event.calls));
        if (event.type === 'error') throw event.error;
      }
    }
    expect(observed).toEqual([{ length: 1, hasInternalMessages: false }, { length: 3, hasInternalMessages: false }]);
    expect(input.messages).toHaveLength(1);
  });
});

describe('complete response decoding follows the selected protocol', () => {
  const closed = '<function_calls><invoke name="lookup"></invoke></function_calls>';
  const scripts = [
    { name: 'closed', value: closed, stopReason: 'end_turn', stopSequence: undefined },
    { name: 'closing stop', value: '<function_calls><invoke name="lookup"></invoke>', stopReason: 'stop_sequence', stopSequence: '</function_calls>' },
    { name: 'partial', value: '<function_calls><invoke name="lookup">', stopReason: 'max_tokens', stopSequence: undefined },
  ];
  for (const carrier of ['default', 'native', 'plain-completions', 'xml']) {
    it.each(scripts)(carrier + ' keeps $name text within its declared protocol', async script => {
      const warnings: string[] = [];
      const adapter: any = {
        name: 'protocol-output', supportsModel: () => true,
        async complete(request: any, options: any) {
          options.onRequest?.(request);
          return { content: [text(script.value)], stopReason: script.stopReason, stopSequence: script.stopSequence,
            usage: { inputTokens: 1, outputTokens: 1 }, model: request.model, rawRequest: request, raw: {} };
        },
      };
      const formatter = carrier === 'plain-completions' ? new CompletionsFormatter()
        : carrier === 'native' ? new NativeFormatter() : new AnthropicXmlFormatter();
      const membrane = new Membrane(adapter, { formatter, logger: { debug() {}, info() {}, error() {}, warn(value) { warnings.push(value); } } });
      const response: any = await membrane.complete({ ...req(false, 'gpt-4o'), ...(carrier === 'xml' ? { toolMode: 'xml' } : {}) });
      const xml = carrier === 'xml';
      expect(response.toolCalls).toHaveLength(xml && script.name !== 'partial' ? 1 : 0);
      expect(response.rawAssistantText).toBe(script.value + (xml && script.stopSequence ? script.stopSequence : ''));
      expect(response.details.stop.unclosedToolBlock).toBe(xml && script.name === 'partial');
      if (!xml) expect(warnings.some(message => /unclosed tool block|zero tool calls/.test(message))).toBe(false);
    });
  }
  for (const carrier of ['native', 'plain-completions']) {
    it.each(['stream', 'yielding'])(carrier + ' %s also keeps XML-looking text as text', async path => {
      const adapter = new MockAdapter({ defaultResponse: closed, completeDelayMs: 0, streamChunkDelayMs: 0 });
      const formatter = carrier === 'native' ? new NativeFormatter() : new CompletionsFormatter();
      const response = await run(path, new Membrane(adapter, { formatter }), req(false, 'gpt-4o'));
      expect(response.toolCalls).toEqual([]);
      expect(response.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('')).toContain(closed);
    });
  }
});

describe('plain/native partial and stop responses', () => {
  for (const carrier of ['native', 'plain-completions']) {
    for (const finish of ['stop', 'abort']) {
      it.each(['stream', 'yielding'])(carrier + ' ' + finish + ' via %s never decodes a textual call', async path => {
        const value = '<function_calls><invoke name="lookup"></invoke>' + (finish === 'abort' ? '</function_calls>' : '');
        let sends = 0;
        const calls: string[] = [];
        const adapter: any = {
          name: 'text-protocol', supportsModel: () => true,
          async stream(request: any, callbacks: any, options: any) {
            options.onRequest?.(request);
            const first = sends++ === 0;
            callbacks.onChunk(first ? value : 'done');
            if (finish === 'abort') throw new Error('aborted by test');
            return { content: [text(first ? value : 'done')], stopReason: first ? 'stop_sequence' : 'end_turn',
              stopSequence: first ? '</function_calls>' : undefined, usage: { inputTokens: 1, outputTokens: 1 }, model: request.model, rawRequest: request, raw: {} };
          },
        };
        const formatter = carrier === 'native' ? new NativeFormatter() : new CompletionsFormatter();
        const membrane = new Membrane(adapter, { formatter });
        const results = (items: any[]) => items.map(item => { calls.push(item.name); return { toolUseId: item.id, content: 'ok' }; });
        let response: any;
        if (path === 'stream') response = await membrane.stream(req(false, 'gpt-4o'), { onToolCalls: async items => results(items) });
        else {
          const stream = membrane.streamYielding(req(false, 'gpt-4o'));
          for await (const event of stream) {
            if (event.type === 'tool-calls') stream.provideToolResults(results(event.calls));
            if (event.type === 'complete') response = event.response;
            if (event.type === 'aborted') response = event;
            if (event.type === 'error') throw event.error;
          }
        }
        expect(sends).toBe(1);
        expect(calls).toEqual([]);
        expect(response.toolCalls ?? []).toEqual([]);
        const content = finish === 'abort' ? response.partialContent : response.content;
        expect(response.rawAssistantText).toBe(value);
        // Native yielding aborts expose raw text rather than partialContent.
        if (content !== undefined) {
          expect(content.every((block: any) => block.type === 'text')).toBe(true);
          expect(content.map((block: any) => block.text).join('')).toBe(value);
        } else expect([carrier, finish, path]).toEqual(['native', 'abort', 'yielding']);
      });
    }
  }
  it.each(['stream', 'yielding'])('plain %s retains native thinking without generating XML text', async path => {
    const adapter: any = {
      name: 'native-thinking', supportsModel: () => true,
      async stream(request: any, callbacks: any, options: any) {
        options.onRequest?.(request);
        if (options.wrapThinkingTags) callbacks.onChunk('<thinking>thought</thinking>');
        callbacks.onChunk('visible');
        return { content: [{ type: 'thinking', thinking: 'thought', signature: 'sig' }, text('visible')],
          stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, model: request.model, rawRequest: request, raw: {} };
      },
    };
    const response = await run(path, new Membrane(adapter, { formatter: new CompletionsFormatter() }), req(false, 'gpt-4o'));
    expect(response.content.filter((block: any) => block.type === 'thinking')).toEqual([{ type: 'thinking', thinking: 'thought', signature: 'sig' }]);
    expect(response.content.filter((block: any) => block.type === 'text')).toEqual([text('visible')]);
  });
});
