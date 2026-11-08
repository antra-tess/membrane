// vitest: isolate
import { readFileSync } from 'node:fs';
import { Console } from 'node:console';
import { afterEach, expect, it, vi } from 'vitest';
import { OpenAIResponsesAPIAdapter } from '../../src/providers/openai-responses-api.js';
import { Membrane } from '../../src/membrane.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { OpenAIResponsesFormatter } from '../../src/formatters/openai-responses.js';
import type { ProviderAdapter, ProviderRequest } from '../../src/types/index.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function setup(mode: 'api' | 'subscription', baseURL?: string, method: 'complete' | 'stream' = 'stream') {
  const response = { status: 'completed', output: [] };
  const sse = mode === 'subscription' || method === 'stream';
  const fetchMock = vi.fn(async () => new Response(
    sse ? `data: ${JSON.stringify({ type: 'response.completed', response })}\n\n` : JSON.stringify(response),
    { headers: { 'Content-Type': sse ? 'text/event-stream' : 'application/json' } },
  ));
  vi.stubGlobal('fetch', fetchMock);
  const adapter = new OpenAIResponsesAPIAdapter({ mode, baseURL, apiKey: 'test',
    credentials: { token: 'test' }, sessionId: 'stable' });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  // Vitest intercepts console; route through Node's Console to assert actual
  // stderr/stdout writes rather than only spying on console.warn.
  const nodeConsole = new Console(process.stdout, process.stderr);
  for (const method of ['warn', 'error', 'log', 'info', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation(nodeConsole[method].bind(nodeConsole));
  }
  const last = () => fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit];
  return { adapter, fetchMock, stderr, stdout, last };
}

for (const method of ['complete', 'stream'] as const) {
  for (const baseURL of [undefined, 'https://proxy.invalid/responses', 'https://api.openai.com/v1']) {
    for (const model of ['gpt-6-astra', 'gpt-6.1-sol']) {
      it(`subscription ${method} ${model} ${baseURL} ignores cache options byte-for-byte and warns once on stderr`, async () => {
        const { adapter, stderr, stdout, last } = setup('subscription', baseURL);
        const request = { model, messages: [{ type: 'message', role: 'user', cacheBreakpoint: true,
          content: [{ type: 'input_text', text: 'private context' }] }] } as ProviderRequest;
        const send = (cache?: ProviderRequest['responsesPromptCache']) => adapter[method](
          { ...request, responsesPromptCache: cache }, { onChunk: () => {} });
        await send();
        const [, off] = last();
        expect(stderr).not.toHaveBeenCalled();
        for (const ttl of ['12h', 'invalid']) {
          await send({ enabled: true, ttl });
          const [, on] = last();
          expect(on.body).toBe(off.body);
          expect(new Headers(on.headers).get('session_id')).toBe(new Headers(off.headers).get('session_id'));
          expect(String(on.body)).not.toMatch(/prompt_cache_(options|breakpoint|retention)|__membrane/);
        }
        expect(stderr).toHaveBeenCalledTimes(1);
        expect(String(stderr.mock.calls[0][0])).toBe('[membrane:responses-prompt-cache] ignored subscription options: 1\n');
        expect(stdout).not.toHaveBeenCalled();
      });
    }
  }

  for (const Formatter of [NativeFormatter, OpenAIResponsesFormatter]) {
    it(`subscription ${method} ${Formatter.name} has no carriers, boundary refusal or formatter diagnostics`, async () => {
      const { adapter, stderr, stdout, last } = setup('subscription', 'https://proxy.invalid');
      const membrane = new Membrane(adapter, { formatter: new Formatter(),
        hooks: { beforeRequest: (_, r) => {
          expect(JSON.stringify(r.messages)).not.toContain('__membraneResponsesCacheMark');
          return structuredClone(r);
        } } });
      const request = { messages: [
        { participant: 'User', cacheBreakpoint: true, content: [{ type: 'text' as const, text: 'stable' }] },
        { participant: 'User', content: [{ type: 'text' as const, text: 'volatile' }] },
        { participant: 'User', cacheBreakpoint: true, content: [] },
      ], config: { model: 'gpt-5.6', maxTokens: 100 }, promptCaching: false };
      await membrane[method](request);
      const off = last()[1].body;
      await membrane[method]({ ...request, responsesPromptCache: { enabled: true, ttl: 'invalid' } });
      expect(last()[1].body).toBe(off);
      expect(String(last()[1].body)).not.toMatch(/prompt_cache_(options|breakpoint|retention)|__membrane/);
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(stdout).not.toHaveBeenCalled();
    });
  }

  it(`subscription ${method} strips caller-supplied rejected fields with option off and on`, async () => {
    const { adapter, last } = setup('subscription');
    const request = { model: 'gpt-6-astra', messages: [{ type: 'message', role: 'user', content: 'stable',
      prompt_cache_breakpoint: { mode: 'explicit' }, __membraneResponsesCacheMark: true }],
    extra: { prompt_cache_options: { ttl: '12h' }, prompt_cache_retention: '24h' } } as ProviderRequest;
    await adapter[method](request, { onChunk: () => {} });
    const off = last()[1].body;
    await adapter[method]({ ...request, responsesPromptCache: { enabled: true, ttl: '12h' } }, { onChunk: () => {} });
    expect(last()[1].body).toBe(off);
    expect(String(off)).not.toMatch(/prompt_cache_(options|breakpoint|retention)|__membrane/);
  });
}

for (const baseURL of [undefined, 'https://chatgpt.com/backend-api/codex', 'https://proxy.invalid']) {
  it(`API still writes regardless of baseURL ${baseURL}`, async () => {
    const { adapter, stderr, stdout, last } = setup('api', baseURL);
    await adapter.stream({ model: 'gpt-6.1-sol', messages: [{ type: 'message', role: 'user', content: 'stable',
      cacheBreakpoint: true }], responsesPromptCache: { enabled: true, ttl: '12h' } } as ProviderRequest, { onChunk: () => {} });
    const body = JSON.parse(String(last()[1].body));
    expect(body.prompt_cache_options).toEqual({ ttl: '12h' });
    expect(body.input[0].prompt_cache_breakpoint).toEqual({ mode: 'explicit' });
    expect(stderr).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
  });
}

it('subscription warning is shared across complete and stream, not emitted per call', async () => {
  const { adapter, stderr, stdout } = setup('subscription');
  const request = { model: 'gpt-6-astra', messages: [], responsesPromptCache: { enabled: true } } as ProviderRequest;
  await adapter.complete(request);
  await adapter.stream(request, { onChunk: () => {} });
  expect(stderr).toHaveBeenCalledTimes(1);
  expect(stdout).not.toHaveBeenCalled();
});

for (const method of ['complete', 'stream'] as const) {
  it(`subscription ${method} off bytes still match the pre-feature main fixture`, async () => {
    const { adapter, last, stderr, stdout } = setup('subscription');
    const mainOff = JSON.parse(readFileSync(new URL('../fixtures/responses-cache-off-main.json', import.meta.url), 'utf8'));
    const request = { model: 'gpt-5.6', maxTokens: 100, messages: [{ type: 'message', role: 'user', cacheBreakpoint: true,
      content: [{ type: 'input_text', text: 'stable', cache_control: { type: 'ephemeral' } }] }] } as ProviderRequest;
    for (const cache of [undefined, { enabled: false, ttl: 'invalid' }, { enabled: true, ttl: '12h' }]) {
      await adapter[method]({ ...request, responsesPromptCache: cache }, { onChunk: () => {} });
      expect(last()[1].body).toBe(mainOff.bodies[`subscription-${method}`]);
    }
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(stdout).not.toHaveBeenCalled();
  });
}

for (const method of ['complete', 'stream'] as const) {
  it(`subscription ${method} leaves generic tool/reasoning expansion byte-identical`, async () => {
    const { adapter, last, stderr, stdout } = setup('subscription');
    const request = { model: 'gpt-6-astra', messages: [{ role: 'assistant', cacheBreakpoint: true, content: [
      { type: 'text', text: 'before', cache_control: { type: 'ephemeral' } },
      { type: 'tool_use', id: 'c', name: 'read', input: {} },
      { type: 'tool_result', toolUseId: 'c', content: 'ok' },
      { type: 'redacted_thinking', data: 'opaque' },
      { type: 'text', text: 'after' },
    ] }] } as ProviderRequest;
    const original = JSON.stringify(request);
    await adapter[method](request, { onChunk: () => {} });
    const off = last()[1].body;
    await adapter[method]({ ...request, responsesPromptCache: { enabled: true, ttl: '12h' } }, { onChunk: () => {} });
    expect(last()[1].body).toBe(off);
    const body = JSON.parse(String(off));
    expect(body.input.map((item: any) => item.type))
      .toEqual(['message', 'function_call', 'function_call_output', 'reasoning', 'message']);
    expect(String(off)).not.toMatch(/prompt_cache_(options|breakpoint|retention)|__membrane/);
    expect(JSON.stringify(request)).toBe(original);
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(stdout).not.toHaveBeenCalled();
  });
}

// A pre-capability decorator: explicit forwarding, deliberately no spread or
// prototype inheritance that could accidentally expose the new member.
function legacyDecorator(adapter: OpenAIResponsesAPIAdapter, forwardInputCapability = true): ProviderAdapter {
  return {
    name: adapter.name,
    usageCacheConvention: adapter.usageCacheConvention,
    reportsContentAlterations: adapter.reportsContentAlterations,
    ...(forwardInputCapability ? { requiresNativeResponsesInput: adapter.requiresNativeResponsesInput } : {}),
    supportsModel: adapter.supportsModel.bind(adapter),
    complete: adapter.complete.bind(adapter),
    stream: adapter.stream.bind(adapter),
  };
}

for (const method of ['complete', 'stream'] as const) {
  for (const Formatter of [NativeFormatter, OpenAIResponsesFormatter]) {
    it(`subscription legacy decorator ${method} ${Formatter.name} ignores caching before hooks and warns once`, async () => {
      const { adapter, fetchMock, stderr, stdout, last } = setup('subscription');
      const decorated = legacyDecorator(adapter);
      expect(decorated).not.toHaveProperty('supportsResponsesPromptCaching');
      const beforeRequest = vi.fn((_: unknown, r: ProviderRequest) => {
        expect(JSON.stringify(r.messages)).not.toContain('__membraneResponsesCacheMark');
        return structuredClone(r);
      });
      const membrane = new Membrane(decorated, { formatter: new Formatter(), hooks: { beforeRequest } });
      const request = { messages: [
        { participant: 'User', cacheBreakpoint: true, content: [{ type: 'text' as const, text: 'stable' }] },
        { participant: 'User', content: [{ type: 'text' as const, text: 'volatile' }] },
        { participant: 'User', cacheBreakpoint: true, content: [] },
      ], config: { model: 'gpt-5.6', maxTokens: 100 }, promptCaching: false };
      const original = JSON.stringify(request);
      await membrane[method](request);
      const off = last()[1];
      for (let i = 0; i < 2; i++) {
        await membrane[method]({ ...request, responsesPromptCache: { enabled: true, ttl: 'invalid' } });
        expect(last()[1].body).toBe(off.body);
        expect(new Headers(last()[1].headers).get('session_id')).toBe(new Headers(off.headers).get('session_id'));
        expect(String(last()[1].body)).not.toMatch(/prompt_cache_(options|breakpoint|retention)|__membrane/);
      }
      expect(beforeRequest).toHaveBeenCalledTimes(3);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(stderr.mock.calls.map(call => String(call[0])))
        .toEqual(['[membrane:responses-prompt-cache] ignored subscription options: 1\n']);
      expect(stdout).not.toHaveBeenCalled();
      expect(JSON.stringify(request)).toBe(original);
    });
  }

  for (const forwardInputCapability of [true, false]) {
    it(`API legacy decorator ${method} forwards input capability ${forwardInputCapability} gates formatter marks safely`, async () => {
      const { adapter, fetchMock, stderr, stdout, last } = setup('api', undefined, method);
      const decorated = legacyDecorator(adapter, forwardInputCapability);
      expect(decorated).not.toHaveProperty('supportsResponsesPromptCaching');
      const beforeRequest = vi.fn((_: unknown, r: ProviderRequest) => {
        expect(JSON.stringify(r.messages).includes('__membraneResponsesCacheMark')).toBe(
          forwardInputCapability && r.responsesPromptCache?.enabled === true,
        );
        return structuredClone(r);
      });
      const membrane = new Membrane(decorated, { formatter: new OpenAIResponsesFormatter(), hooks: { beforeRequest } });
      const request = { messages: [
        { participant: 'User', cacheBreakpoint: true, content: [{ type: 'text' as const, text: 'stable' }] },
        { participant: 'User', content: [{ type: 'text' as const, text: 'volatile' }] },
      ], config: { model: 'gpt-5.6', maxTokens: 100 }, promptCaching: false };
      await membrane[method](request);
      const off = last()[1].body;
      await membrane[method]({ ...request, responsesPromptCache: { enabled: true, ttl: '12h' } });
      const body = JSON.parse(String(last()[1].body));
      expect(body.input.map((item: any) => item.prompt_cache_breakpoint))
        .toEqual([forwardInputCapability ? { mode: 'explicit' } : undefined, undefined]);
      expect(body.prompt_cache_options).toEqual({ ttl: '12h' });
      expect(String(last()[1].body)).not.toContain('__membrane');
      await membrane[method]({ ...request, responsesPromptCache: { enabled: false } });
      expect(last()[1].body).toBe(off);
      expect(beforeRequest).toHaveBeenCalledTimes(3);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(stderr).not.toHaveBeenCalled();
      expect(stdout).not.toHaveBeenCalled();
    });
  }
}
