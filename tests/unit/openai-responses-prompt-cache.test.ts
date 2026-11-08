import { readFileSync } from 'node:fs';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIResponsesAPIAdapter } from '../../src/providers/openai-responses-api.js';
import { Membrane } from '../../src/membrane.js';
import { OpenAIResponsesFormatter } from '../../src/formatters/openai-responses.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import type { ProviderRequest } from '../../src/types/index.js';

const explicit = { mode: 'explicit' };
const ephemeral = { type: 'ephemeral' };
// Captured by executing main's adapter, not reconstructed from this implementation.
const mainOff = JSON.parse(readFileSync(new URL('../fixtures/responses-cache-off-main.json', import.meta.url), 'utf8'));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function setup(mode: 'api' | 'subscription', method: 'complete' | 'stream' = 'complete') {
  const fetchMock = vi.fn().mockImplementation(async () => {
    const response = { status: 'completed', output: [] };
    const sse = mode === 'subscription' || method === 'stream';
    return new Response(!sse ? JSON.stringify(response)
      : `data: ${JSON.stringify({ type: 'response.completed', response })}\n\n`,
    { headers: { 'Content-Type': !sse ? 'application/json' : 'text/event-stream' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  const adapter = new OpenAIResponsesAPIAdapter({
    mode, apiKey: 'test', credentials: { token: 'test' }, sessionId: 'stable',
  });
  const send = async (messages: unknown[], cache?: unknown, extra?: Record<string, unknown>) => {
    await adapter[method]({ model: 'gpt-5.6', maxTokens: 100, messages,
      responsesPromptCache: cache, extra } as ProviderRequest, { onChunk: () => {} });
    return JSON.parse(String(fetchMock.mock.calls.at(-1)![1].body));
  };
  return { adapter, fetchMock, send };
}

for (const mode of ['api', 'subscription'] as const) {
  for (const method of ['complete', 'stream'] as const) {
    for (const disable of ['false', 'delete'] as const) {
      it(`${mode} ${method} cleans carriers and preserves routing when a hook turns caching off via ${disable}`, async () => {
        const { adapter, fetchMock } = setup(mode, method);
        let disableHook = false;
        const membrane = new Membrane(adapter, {
          formatter: new OpenAIResponsesFormatter(),
          hooks: { beforeRequest: (_, r) => {
            if (!disableHook) return r;
            const result = { ...r };
            if (disable === 'delete') delete result.responsesPromptCache;
            else result.responsesPromptCache = { enabled: false };
            return result;
          } },
        });
        const request = {
          messages: [
            { participant: 'User', cacheBreakpoint: true, content: [{ type: 'text' as const, text: 'stable' }] },
            { participant: 'User', content: [{ type: 'text' as const, text: 'volatile' }] },
          ],
          config: { model: 'gpt-5.6', maxTokens: 100 },
        };
        const original = JSON.stringify(request);
        await membrane[method](request);
        const baseline = fetchMock.mock.calls.at(-1)![1];
        await membrane[method]({ ...request, responsesPromptCache: { enabled: true, ttl: '12h' } });
        const enabled = JSON.parse(String(fetchMock.mock.calls.at(-1)![1].body));
        expect(enabled.input.map((item: any) => item.prompt_cache_breakpoint)).toEqual([explicit, undefined]);
        expect(enabled.prompt_cache_options).toEqual({ ttl: '12h' });
        disableHook = true;
        await membrane[method]({ ...request, responsesPromptCache: { enabled: true, ttl: '12h' } });
        const hooked = fetchMock.mock.calls.at(-1)![1];
        expect(String(hooked.body)).not.toContain('__membraneResponsesCacheMark');
        expect(JSON.parse(String(hooked.body)).prompt_cache_key)
          .toBe(JSON.parse(String(baseline.body)).prompt_cache_key);
        expect(new Headers(hooked.headers).get('session_id'))
          .toBe(new Headers(baseline.headers).get('session_id'));
        expect(hooked.body).toBe(baseline.body);
        expect(JSON.stringify(request)).toBe(original);
      });
    }
  }

  describe(`${mode} explicit Responses caching`, () => {
    for (const count of [1, 3, 5]) {
      it(`keeps latest 3 of ${count} caller cacheBreakpoint marks`, async () => {
        const { send } = setup(mode);
        const messages = Array.from({ length: count }, (_, i) => ({
          type: 'message', role: 'user', cacheBreakpoint: true,
          content: [{ type: 'input_text', text: String(i), cache_control: ephemeral }],
        }));
        const original = JSON.stringify(messages);
        const body = await send(messages, { enabled: true });
        expect(body.input.map((item: any) => item.prompt_cache_breakpoint))
          .toEqual(messages.map((_, i) => i >= Math.max(0, count - 3) ? explicit : undefined));
        expect(body.prompt_cache_options).toBeUndefined();
        expect(JSON.stringify(body.input)).not.toMatch(/cacheBreakpoint|cache_control|__membrane/);
        expect(JSON.stringify(messages)).toBe(original);
      });
    }

    for (const method of ['complete', 'stream'] as const) {
      it(`${method} off and omitted match actual main bytes, while on writes`, async () => {
        const { send, fetchMock } = setup(mode, method);
        const messages = [{ type: 'message', role: 'user', cacheBreakpoint: true,
          content: [{ type: 'input_text', text: 'stable', cache_control: ephemeral }] }];
        await send(messages);
        expect(fetchMock.mock.calls.at(-1)![1].body).toBe(mainOff.bodies[`${mode}-${method}`]);
        await send(messages, { enabled: false, ttl: 'garbage' });
        expect(fetchMock.mock.calls.at(-1)![1].body).toBe(mainOff.bodies[`${mode}-${method}`]);
        expect((await send(messages, { enabled: true })).input[0].prompt_cache_breakpoint).toEqual(explicit);
      });
    }

    for (const ttl of ['12h', '5m', '30s', '2d']) {
      it(`sends validated TTL ${ttl}`, async () => {
        const { send } = setup(mode);
        expect((await send([], { enabled: true, ttl })).prompt_cache_options).toEqual({ ttl });
      });
    }
    for (const method of ['complete', 'stream'] as const) {
      for (const ttl of ['', '0h', '-1h', '1.5h', '12H', '12h\n', 12, null]) {
        it(`${method} rejects invalid TTL ${JSON.stringify(ttl)} before fetch`, async () => {
          const { send, fetchMock } = setup(mode, method);
          await expect(send([], { enabled: true, ttl })).rejects.toMatchObject({ type: 'invalid_request' });
          expect(fetchMock).not.toHaveBeenCalled();
        });
      }
    }

    it('does not alter cache routing keys or session headers', async () => {
      const { send, fetchMock } = setup(mode);
      const messages = [{ type: 'message', role: 'user', content: 'stable', cacheBreakpoint: true }];
      const off = await send(messages);
      const headers = new Headers(fetchMock.mock.calls.at(-1)![1].headers);
      const on = await send(messages, { enabled: true, ttl: '12h' });
      expect(on.input[0].prompt_cache_breakpoint).toEqual(explicit);
      expect(on.prompt_cache_options).toEqual({ ttl: '12h' });
      expect(on.prompt_cache_key).toBe(off.prompt_cache_key);
      expect(new Headers(fetchMock.mock.calls.at(-1)![1].headers).get('session_id')).toBe(headers.get('session_id'));
      expect((await send(messages, { enabled: true }, { prompt_cache_key: 'override' })).prompt_cache_key).toBe('override');
    });

    it('diagnoses marks with no eligible prefix item', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const stdout = vi.spyOn(console, 'debug').mockImplementation(() => {});
      const { send } = setup(mode);
      const messages = [
        { type: 'function_call', call_id: 'c', name: 'read', arguments: '{}', cacheBreakpoint: true },
        { type: 'function_call_output', call_id: 'c', output: 'ok', cacheBreakpoint: true },
        { type: 'reasoning', summary: [], encrypted_content: 'opaque', cacheBreakpoint: true },
      ];
      const body = await send(messages, { enabled: true });
      expect(body.input.every((item: any) => !item.prompt_cache_breakpoint)).toBe(true);
      expect(JSON.stringify(body)).not.toContain('cacheBreakpoint');
      expect(warn).toHaveBeenCalledWith('[membrane:responses-prompt-cache] skipped marks: 3');
      expect(stdout).not.toHaveBeenCalled();
    });

    it('carries NormalizedMessage marks through the native Responses formatter, on only', async () => {
      const { adapter, fetchMock } = setup(mode);
      const membrane = new Membrane(adapter, { formatter: new OpenAIResponsesFormatter() });
      for (const enabled of [false, true]) {
        await membrane.complete({
          messages: [{ participant: 'User', cacheBreakpoint: true, content: [
            { type: 'text', text: 'before' },
            { type: 'redacted_thinking', data: 'opaque' },
            { type: 'text', text: 'after' },
          ] }],
          config: { model: 'gpt-5.6', maxTokens: 100 },
          responsesPromptCache: { enabled },
        });
        const body = JSON.parse(String(fetchMock.mock.calls.at(-1)![1].body));
        expect(body.input).toHaveLength(3);
        expect(body.input.map((item: any) => item.prompt_cache_breakpoint))
          .toEqual([undefined, undefined, enabled ? explicit : undefined]);
      }
    });
  });
}

it('subscription marks only the last item expanded from a generic message', async () => {
  const { send } = setup('subscription');
  const body = await send([{ role: 'assistant', cacheBreakpoint: true, content: [
    { type: 'text', text: 'before', cache_control: ephemeral },
    { type: 'tool_use', id: 'c', name: 'read', input: {} },
    { type: 'tool_result', toolUseId: 'c', content: 'ok' },
    { type: 'redacted_thinking', data: 'opaque' },
    { type: 'text', text: 'after' },
  ] }], { enabled: true });
  expect(body.input.map((item: any) => item.type))
    .toEqual(['message', 'function_call', 'function_call_output', 'reasoning', 'message']);
  expect(body.input.map((item: any) => item.prompt_cache_breakpoint))
    .toEqual([undefined, undefined, undefined, undefined, explicit]);
});

it('subscription recognizes a native formatter caller cacheBreakpoint', async () => {
  const { adapter, fetchMock } = setup('subscription');
  const membrane = new Membrane(adapter, { formatter: new NativeFormatter() });
  await membrane.complete({ messages: [{ participant: 'User', cacheBreakpoint: true,
    content: [{ type: 'text', text: 'stable' }] }],
  config: { model: 'gpt-5.6', maxTokens: 100 }, responsesPromptCache: { enabled: true, ttl: '12h' } });
  const body = JSON.parse(String(fetchMock.mock.calls.at(-1)![1].body));
  expect(body.input.at(-1).prompt_cache_breakpoint).toEqual(explicit);
  expect(body.prompt_cache_options).toEqual({ ttl: '12h' });
});

for (const mode of ['api', 'subscription'] as const) {
  it(`${mode} keeps five NormalizedMessage boundaries and marks only the latest three`, async () => {
    const { adapter, fetchMock } = setup(mode);
    const membrane = new Membrane(adapter, { formatter: new OpenAIResponsesFormatter() });
    await membrane.complete({
      messages: Array.from({ length: 5 }, (_, i) => ({ participant: 'User', cacheBreakpoint: true,
        content: [{ type: 'text', text: String(i) }] })),
      promptCaching: false,
      config: { model: 'gpt-5.6', maxTokens: 100 },
      responsesPromptCache: { enabled: true },
    });
    const body = JSON.parse(String(fetchMock.mock.calls.at(-1)![1].body));
    expect(body.input.map((item: any) => item.prompt_cache_breakpoint))
      .toEqual([undefined, undefined, explicit, explicit, explicit]);
  });

  it(`${mode} falls back from a reasoning tail to the latest eligible prefix item`, async () => {
    const { adapter, fetchMock } = setup(mode);
    const membrane = new Membrane(adapter, { formatter: new OpenAIResponsesFormatter() });
    await membrane.complete({ messages: [{ participant: 'User', cacheBreakpoint: true, content: [
      { type: 'text', text: 'before' }, { type: 'redacted_thinking', data: 'opaque' },
    ] }], config: { model: 'gpt-5.6', maxTokens: 100 }, responsesPromptCache: { enabled: true } });
    const body = JSON.parse(String(fetchMock.mock.calls.at(-1)![1].body));
    expect(body.input).toHaveLength(2);
    expect(body.input.map((item: any) => item.prompt_cache_breakpoint)).toEqual([explicit, undefined]);
  });

  it(`${mode} does not retain a mark on reused caller objects`, async () => {
    const { send } = setup(mode);
    const message = { type: 'message', role: 'user', content: 'stable', cacheBreakpoint: true };
    expect((await send([message], { enabled: true })).input[0].prompt_cache_breakpoint).toEqual(explicit);
    message.cacheBreakpoint = false;
    expect((await send([message], { enabled: true })).input[0].prompt_cache_breakpoint).toBeUndefined();
  });

  it(`${mode} preserves raw extra cache options when off`, async () => {
    const { send } = setup(mode);
    const extra = { prompt_cache_options: { ttl: 'custom' }, prompt_cache_key: 'route' };
    const off = await send([], undefined, extra);
    expect(off.prompt_cache_options).toEqual(extra.prompt_cache_options);
    expect(await send([], { enabled: false, ttl: 'invalid' }, extra)).toEqual(off);
    expect((await send([], { enabled: true }, extra)).prompt_cache_options).toBeUndefined();
  });
}

it('carries marks on imported native Responses items without mutating them', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { adapter, fetchMock } = setup('api');
  const membrane = new Membrane(adapter, { formatter: new OpenAIResponsesFormatter() });
  const raw = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'stable' }] };
  const original = JSON.stringify(raw);
  await membrane.complete({ messages: [
    { participant: 'Claude', cacheBreakpoint: true, content: [], metadata: { openaiResponsesItems: [raw] } },
    { participant: 'User', cacheBreakpoint: true, content: [], metadata: { openaiResponsesItems: [] } },
  ], config: { model: 'gpt-5.6', maxTokens: 100 }, responsesPromptCache: { enabled: true } });
  const body = JSON.parse(String(fetchMock.mock.calls.at(-1)![1].body));
  expect(body.input).toHaveLength(1);
  expect(body.input[0].prompt_cache_breakpoint).toEqual(explicit);
  expect(JSON.stringify(raw)).toBe(original);
  expect(warn).toHaveBeenCalledExactlyOnceWith('[membrane:responses-prompt-cache] skipped marks: 1');
});

for (const mode of ['api', 'subscription'] as const) {
  it(`${mode} keeps a marked prefix before an unmarked tail`, async () => {
    const { send } = setup(mode);
    const body = await send([
      { type: 'message', role: 'user', cacheBreakpoint: true, content: [{ type: 'input_text', text: 'stable', cache_control: ephemeral }] },
      { type: 'message', role: 'user', content: 'changing' },
    ], { enabled: true });
    expect(body.input.map((item: any) => item.prompt_cache_breakpoint)).toEqual([explicit, undefined]);
  });
}

it('subscription ignores block cache_control and expands caller cacheBreakpoint onto its last item', async () => {
  const { send } = setup('subscription');
  const messages = [{ role: 'assistant', content: [
    { type: 'text', text: 'before', cache_control: ephemeral },
    { type: 'redacted_thinking', data: 'opaque' },
    { type: 'text', text: 'after' },
  ] }];
  expect((await send(messages, { enabled: true })).input.every((item: any) => !item.prompt_cache_breakpoint)).toBe(true);
  const body = await send(messages.map(message => ({ ...message, cacheBreakpoint: true })), { enabled: true });
  expect(body.input.map((item: any) => item.prompt_cache_breakpoint)).toEqual([undefined, undefined, explicit]);
});

for (const mode of ['api', 'subscription'] as const) {
  for (const copy of ['spread', 'blocks', 'structuredClone', 'json'] as const) {
    it(`${mode} retains marks through a ${copy} copying beforeRequest hook`, async () => {
      const { adapter, fetchMock } = setup(mode);
      const membrane = new Membrane(adapter, {
        formatter: new OpenAIResponsesFormatter(),
        hooks: { beforeRequest: (_, r) => copy === 'structuredClone' ? structuredClone(r)
          : copy === 'json' ? JSON.parse(JSON.stringify(r)) : copy === 'spread'
          ? ({...r, messages: r.messages.map(x=>({...x}))})
          : ({ ...r, messages: r.messages.map(x => ({ ...x,
            content: Array.isArray(x.content) ? x.content.map(b => ({ ...b })) : x.content,
          })) }) },
      });
      const messages = [
        { participant: 'User', cacheBreakpoint: true, content: [{ type: 'text' as const, text: 'stable' }] },
        { participant: 'User', content: [{ type: 'text' as const, text: 'volatile' }] },
      ];
      const original = JSON.stringify(messages);
      await membrane.complete({ messages, promptCaching: false,
        config: { model: 'gpt-5.6', maxTokens: 100 }, responsesPromptCache: { enabled: true } });
      const body = JSON.parse(String(fetchMock.mock.calls.at(-1)![1].body));
      expect(body.input.map((x: any) => x.prompt_cache_breakpoint)).toEqual([explicit, undefined]);
      expect(JSON.stringify(messages)).toBe(original);
    });
  }

  it(`${mode} puts a tool-history mark on text before the ineligible tool tail`, async () => {
    const { adapter, fetchMock } = setup(mode);
    const membrane = new Membrane(adapter, { formatter: new OpenAIResponsesFormatter(),
      hooks: { beforeRequest: (_, r) => ({...r, messages: r.messages.map(x=>({...x}))}) } });
    await membrane.complete({ messages: [
      { participant: 'Claude', cacheBreakpoint: true, content: [
        { type: 'text', text: 'stable commentary' }, { type: 'tool_use', id: 'c', name: 'read', input: {} },
      ] },
      { participant: 'User', content: [{ type: 'tool_result', toolUseId: 'c', content: 'stable result' }] },
      { participant: 'User', content: [{ type: 'text', text: 'volatile' }] },
    ], config: { model: 'gpt-5.6', maxTokens: 100 }, responsesPromptCache: { enabled: true } });
    const body = JSON.parse(String(fetchMock.mock.calls.at(-1)![1].body));
    expect(body.input.map((x: any) => x.type)).toEqual(['message', 'function_call', 'function_call_output', 'message']);
    expect(body.input.map((x: any) => x.prompt_cache_breakpoint)).toEqual([explicit, undefined, undefined, undefined]);
  });

  it(`${mode} falls back across items, deduplicates targets and keeps latest three`, async () => {
    const { send } = setup(mode);
    const body = await send(Array.from({ length: 5 }, (_, i) => [
      { type: 'message', role: 'user', content: String(i) },
      { type: 'reasoning', summary: [], cacheBreakpoint: true },
      { type: 'function_call_output', call_id: String(i), output: 'ok', cacheBreakpoint: true },
    ]).flat(), { enabled: true });
    expect(body.input.flatMap((x: any, i: number) => x.prompt_cache_breakpoint ? [i] : [])).toEqual([6, 9, 12]);
  });
}

for (const promptCaching of [false, true]) {
  it(`refuses NativeFormatter stable+volatile merging when enabled (Anthropic caching ${promptCaching})`, async () => {
    const { adapter, fetchMock } = setup('subscription');
    const membrane = new Membrane(adapter, { formatter: new NativeFormatter() });
    const request = { messages: [
      { participant: 'User', cacheBreakpoint: true, content: [{ type: 'text' as const, text: 'stable' }] },
      { participant: 'User', content: [{ type: 'text' as const, text: 'volatile' }] },
    ], promptCaching, config: { model: 'gpt-5.6', maxTokens: 100 } };
    await expect(membrane.complete({ ...request, responsesPromptCache: { enabled: true } }))
      .rejects.toMatchObject({ type: 'invalid_request', message: expect.stringContaining('Move the mark to a preserved message boundary or disable responsesPromptCache') });
    expect(fetchMock).not.toHaveBeenCalled();
    await membrane.complete({ ...request, responsesPromptCache: { enabled: false } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it(`NativeFormatter keeps a mark through the copying hook (Anthropic caching ${promptCaching})`, async () => {
    const { adapter, fetchMock } = setup('subscription');
    const membrane = new Membrane(adapter, { formatter: new NativeFormatter(),
      hooks: { beforeRequest: (_, r) => ({...r, messages: r.messages.map(x=>({...x}))}) } });
    await membrane.complete({ messages: [{ participant: 'User', cacheBreakpoint: true,
      content: [{ type: 'text', text: 'stable' }] }], promptCaching,
      config: { model: 'gpt-5.6', maxTokens: 100 }, responsesPromptCache: { enabled: true } });
    const body = JSON.parse(String(fetchMock.mock.calls.at(-1)![1].body));
    expect(body.input.map((x: any) => x.prompt_cache_breakpoint)).toEqual([explicit]);
  });
}

it('subscription NativeFormatter tool history falls back before volatile content', async () => {
  const { adapter, fetchMock } = setup('subscription');
  const membrane = new Membrane(adapter, { formatter: new NativeFormatter(),
    hooks: { beforeRequest: (_, r) => ({...r, messages: r.messages.map(x=>({...x}))}) } });
  await membrane.complete({ messages: [
    { participant: 'Claude', cacheBreakpoint: true, content: [
      { type: 'text', text: 'stable commentary' }, { type: 'tool_use', id: 'c', name: 'read', input: {} },
    ] },
    { participant: 'User', content: [{ type: 'tool_result', toolUseId: 'c', content: 'stable result' }] },
    { participant: 'User', content: [{ type: 'text', text: 'volatile' }] },
  ], promptCaching: false, config: { model: 'gpt-5.6', maxTokens: 100 }, responsesPromptCache: { enabled: true } });
  const body = JSON.parse(String(fetchMock.mock.calls.at(-1)![1].body));
  const writes = body.input.filter((x: any) => x.prompt_cache_breakpoint);
  expect(writes).toHaveLength(1);
  expect(writes[0].content).toEqual([{ type: 'output_text', text: 'stable commentary' }]);
  expect(body.input.at(-1).prompt_cache_breakpoint).toBeUndefined();
});

for (const formatter of [OpenAIResponsesFormatter, NativeFormatter]) {
  it(`${formatter.name} keeps subscription routing unchanged with copied marks`, async () => {
    const { adapter, fetchMock } = setup('subscription');
    const membrane = new Membrane(adapter, { formatter: new formatter(),
      hooks: { beforeRequest: (_, r) => structuredClone(r) } });
    const request = { messages: [{ participant: 'User', cacheBreakpoint: true,
      content: [{ type: 'text' as const, text: 'stable' }] }],
      config: { model: 'gpt-5.6', maxTokens: 100 } };
    await membrane.complete(request);
    const off = JSON.parse(String(fetchMock.mock.calls.at(-1)![1].body));
    await membrane.complete({ ...request, responsesPromptCache: { enabled: true } });
    const on = JSON.parse(String(fetchMock.mock.calls.at(-1)![1].body));
    expect(on.prompt_cache_key).toBe(off.prompt_cache_key);
    expect(on.input[0].prompt_cache_breakpoint).toEqual(explicit);
    expect(JSON.stringify(on)).not.toContain('__membrane');
  });
}

for (const mode of ['api', 'subscription'] as const) {
  it(`${mode} never interprets a synthetic contextPrefix Anthropic marker as a caller mark`, async () => {
    const { adapter, fetchMock } = setup(mode);
    const membrane = new Membrane(adapter, { formatter: new NativeFormatter() });
    for (const marked of [false, true]) {
      await membrane.complete({ contextPrefix: 'synthetic prefix',
        messages: [{ participant: 'User', cacheBreakpoint: marked, content: [{ type: 'text', text: 'caller' }] }],
        config: { model: 'gpt-5.6', maxTokens: 100 }, responsesPromptCache: { enabled: true } });
      const body = JSON.parse(String(fetchMock.mock.calls.at(-1)![1].body));
      expect(body.input.map((item: any) => item.prompt_cache_breakpoint)).toEqual(body.input.map((_: unknown, i: number) => marked && i === body.input.length - 1 ? explicit : undefined));
    }
  });

  it(`${mode} invalid tool errors contain no private cache carrier`, async () => {
    const { adapter, fetchMock } = setup(mode);
    const membrane = new Membrane(adapter, { formatter: new OpenAIResponsesFormatter(),
      hooks: { beforeRequest: (_, r) => ({ ...r, tools: [{ type: 'function', name: 'read', strict: 'true' }] }) } });
    let error: any;
    try {
      await membrane.complete({ messages: [{ participant: 'User', cacheBreakpoint: true,
        content: [{ type: 'text', text: 'stable' }] }], config: { model: 'gpt-5.6', maxTokens: 100 },
      responsesPromptCache: { enabled: true } });
    } catch (caught) { error = caught; }
    expect(error).toMatchObject({ type: 'invalid_request', rawRequest: { input: [
      expect.objectContaining({ prompt_cache_breakpoint: explicit }),
    ] } });
    expect(JSON.stringify(error.rawRequest)).not.toContain('__membrane');
    expect(fetchMock).not.toHaveBeenCalled();
  });
}

for (const content of [[], [{ type: 'text' as const, text: '' }], [{ type: 'system_change' as const, addSystem: [''] }]]) {
  it(`NativeFormatter reports an empty marked expansion: ${JSON.stringify(content)}`, () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    new NativeFormatter().buildMessages([{ participant: 'User', cacheBreakpoint: true, content }], {
      assistantParticipant: 'Claude', participantMode: 'multiuser', responsesPromptCaching: true,
    });
    expect(warn).toHaveBeenCalledExactlyOnceWith('[membrane:responses-prompt-cache] skipped marks: 1');
  });
}

for (const tail of [false, true]) {
  it(`Anthropic ignores the Responses option entirely (same-role tail ${tail})`, async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      id: 'm', type: 'message', role: 'assistant', model: 'claude-test',
      content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
    }), { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const membrane = new Membrane(new AnthropicAdapter({ apiKey: 'test', cacheKeepalive: { enabled: false } }), {
      formatter: new NativeFormatter(),
    });
    const request = { messages: [
      { participant: 'User', cacheBreakpoint: true, content: [{ type: 'text' as const, text: 'stable' }] },
      ...(tail ? [{ participant: 'User', content: [{ type: 'text' as const, text: 'volatile' }] }] : []),
    ], config: { model: 'claude-test', maxTokens: 100 } };
    await membrane.complete(request);
    const off = fetchMock.mock.calls.at(-1)![1].body;
    await membrane.complete({ ...request, responsesPromptCache: { enabled: true, ttl: 'invalid' } });
    const on = fetchMock.mock.calls.at(-1)![1].body;
    expect(on).toBe(off);
    expect(String(on)).not.toContain('__membrane');
  });
}

it('NativeFormatter boundary refusal gives usable advice for a displaced system change', () => {
  const formatter = new NativeFormatter();
  const messages = [
    { participant: 'User', cacheBreakpoint: true, content: [{ type: 'system_change' as const, addSystem: ['policy'] }] },
    { participant: 'User', content: [{ type: 'text' as const, text: 'later' }] },
  ];
  const options = { assistantParticipant: 'Claude', participantMode: 'multiuser' as const };
  expect(() => formatter.buildMessages(messages, { ...options, responsesPromptCaching: true }))
    .toThrow('Move the mark to a preserved message boundary or disable responsesPromptCache');
  // Unlike switching to Responses (which cannot render system_change), this remedy works.
  expect(() => formatter.buildMessages(messages, { ...options, responsesPromptCaching: false })).not.toThrow();
});
