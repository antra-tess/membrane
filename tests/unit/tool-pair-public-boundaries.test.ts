import { afterEach, describe, expect, it, vi } from 'vitest';
import * as root from '../../src/index.js';
import { Membrane } from '../../src/membrane.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { AnthropicXmlFormatter } from '../../src/formatters/anthropic-xml.js';
import { OpenAIResponsesFormatter } from '../../src/formatters/openai-responses.js';
import {
  assertToolPairsValid, normalizeToolPairs, MembraneNormalizerError,
  type ProviderBlock,
} from '../../src/formatters/normalize-tool-pairs.js';
import { MembraneNotReadyError } from '../../src/types/errors.js';
import { countWireCacheMarkers } from '../../src/utils/cache-marker-budget.js';
import type { PrefillFormatter, ProviderMessage } from '../../src/formatters/types.js';
import type { NormalizedRequest, ProviderAdapter, ProviderRequest } from '../../src/types/index.js';

afterEach(() => vi.restoreAllMocks());
const text = (value: string): ProviderBlock => ({ type: 'text', text: value });
const use = (): ProviderBlock => ({ type: 'tool_use', id: 'u', name: 'noop', input: {} });
const result = (value = 'result'): ProviderBlock => ({ type: 'tool_result', tool_use_id: 'u', content: value });
const message = (role: 'user' | 'assistant', ...content: ProviderBlock[]): ProviderMessage => ({ role, content });
const marker = { type: 'ephemeral', ttl: '1h' };
function blocks(messages: ProviderMessage[]): ProviderBlock[] {
  return messages.flatMap(m => m.content as ProviderBlock[]);
}
function request(): NormalizedRequest {
  return {
    messages: [{ participant: 'User', content: [{ type: 'text', text: 'go' }] }],
    config: { model: 'test-model', maxTokens: 128 },
    promptCaching: false,
    tools: [{ name: 'noop', description: 'noop', inputSchema: { type: 'object' } }],
  };
}
function recordingAdapter() {
  const requests: ProviderRequest[] = [];
  const response = (req: ProviderRequest) => {
    requests.push(structuredClone(req));
    return { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, raw: {} };
  };
  const adapter: ProviderAdapter = {
    name: 'review-probe', supportsModel: () => true,
    complete: vi.fn(async req => response(req)),
    stream: vi.fn(async (req, callbacks) => { callbacks.onChunk('done'); return response(req); }),
  };
  return { adapter, requests };
}

describe('public standalone tool-pair validation', () => {
  it('exports the assertion from the package root', () => {
    expect((root as Record<string, unknown>).assertToolPairsValid).toBe(assertToolPairsValid);
  });

  it.each([
    { label: 'user tool_use', input: [message('user', use())] },
    { label: 'assistant tool_result', input: [message('user', text('go')), message('assistant', result())] },
    { label: 'user call with a matching next result', input: [message('user', use()), message('user', result())] },
    { label: 'assistant result alongside a paired call', input: [message('user', text('go')), message('assistant', use(), result()), message('user', result())] },
    { label: 'user thinking', input: [message('user', { type: 'thinking', thinking: 'thought', signature: 'sig' })] },
    { label: 'user redacted thinking', input: [message('user', { type: 'redacted_thinking', data: 'opaque' })] },
  ])('refuses wrong-role blocks: $label, including when the id is pending', ({ input }) => {
    const before = structuredClone(input);
    expect(() => assertToolPairsValid(input, new Set(['u']))).toThrow(MembraneNormalizerError);
    expect(input).toEqual(before);
  });

  it('accepts role-correct pairs and permits explicitly pending assistant calls', () => {
    const paired = [message('user', text('go')), message('assistant', { type: 'thinking', thinking: 'thought' }, use()), message('user', result())];
    expect(() => assertToolPairsValid(paired)).not.toThrow();
    expect(() => assertToolPairsValid(paired.slice(0, 2), new Set(['u']))).not.toThrow();
  });
});

const readinessPaths = [
  { label: 'complete/native', entry: 'complete', mode: 'native', create: () => new NativeFormatter() },
  { label: 'complete/XML', entry: 'complete', mode: 'xml', create: () => new AnthropicXmlFormatter() },
  { label: 'complete/Responses', entry: 'complete', mode: 'native', create: () => new OpenAIResponsesFormatter() },
  { label: 'stream/native', entry: 'stream', mode: 'native', create: () => new NativeFormatter() },
  { label: 'stream/XML', entry: 'stream', mode: 'xml', create: () => new AnthropicXmlFormatter() },
  { label: 'stream/Responses', entry: 'stream', mode: 'native', create: () => new OpenAIResponsesFormatter() },
  { label: 'yielding/native', entry: 'yielding', mode: 'native', create: () => new NativeFormatter() },
  { label: 'yielding/XML', entry: 'yielding', mode: 'xml', create: () => new AnthropicXmlFormatter() },
  { label: 'yielding/Responses', entry: 'yielding', mode: 'native', create: () => new OpenAIResponsesFormatter() },
] as const;

describe('not-ready errors on paths that invoke the formatter build', () => {
  it.each(readinessPaths)('preserves the subtype and formatter name through $label', async ({ entry, mode, create }) => {
    const formatter: PrefillFormatter = create();
    const original = formatter.buildMessages.bind(formatter);
    const build = vi.spyOn(formatter, 'buildMessages').mockImplementation((messages, options) => ({
      ...original(messages, options), ready: false,
    }));
    const { adapter, requests } = recordingAdapter();
    const beforeRequest = vi.fn();
    const membrane = new Membrane(adapter, { formatter, retry: { maxRetries: 3 }, hooks: { beforeRequest } });
    let caught: unknown;
    try {
      const req = { ...request(), toolMode: mode };
      if (entry === 'complete') await membrane.complete(req);
      else if (entry === 'stream') await membrane.stream(req);
      else for await (const event of membrane.streamYielding(req)) {
        if (event.type === 'error') caught = event.error;
      }
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MembraneNotReadyError);
    expect(caught).toMatchObject({ formatterName: formatter.name, type: 'invalid_request', retryable: false });
    expect(build).toHaveBeenCalledTimes(1);
    expect(beforeRequest).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });
});

async function invoke(entry: string, membrane: Membrane, req: NormalizedRequest) {
  if (entry === 'complete') return membrane.complete(req);
  if (entry === 'stream') return membrane.stream(req);
  for await (const event of membrane.streamYielding(req)) {
    if (event.type === 'error') throw event.error;
  }
}

describe('shared native readiness and budget ownership', () => {
  it.each(['complete', 'stream', 'yielding'])('%s honors a real pending set from a custom native build', async entry => {
    const formatter = new NativeFormatter();
    const original = formatter.buildMessages.bind(formatter);
    const build = vi.spyOn(formatter, 'buildMessages').mockImplementation((messages, options) =>
      original(messages, { ...options, pendingToolCallIds: new Set(['u']) }));
    const { adapter, requests } = recordingAdapter();
    const beforeRequest = vi.fn();
    const membrane = new Membrane(adapter, { formatter, hooks: { beforeRequest } });
    const req: NormalizedRequest = { ...request(), toolMode: 'native', messages: [
      ...request().messages,
      { participant: 'Claude', content: [{ type: 'tool_use', id: 'u', name: 'noop', input: {} }] },
    ] };
    await expect(invoke(entry, membrane, req)).rejects.toMatchObject({
      name: 'MembraneNotReadyError', formatterName: 'native', type: 'invalid_request', retryable: false,
    });
    expect(build).toHaveBeenCalledTimes(1);
    expect(beforeRequest).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });

  it.each(['stream', 'yielding'])('%s preserves a second-round readiness refusal', async entry => {
    const formatter = new NativeFormatter();
    const original = formatter.buildMessages.bind(formatter);
    let builds = 0;
    vi.spyOn(formatter, 'buildMessages').mockImplementation((messages, options) => ({
      ...original(messages, options), ready: ++builds === 1,
    }));
    const { adapter, requests } = recordingAdapter();
    vi.mocked(adapter.stream).mockImplementationOnce(async req => {
      requests.push(structuredClone(req));
      return { content: [{ type: 'tool_use', id: 'u', name: 'noop', input: {} }],
        stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 }, raw: {}, rawRequest: req };
    });
    const beforeRequest = vi.fn();
    const membrane = new Membrane(adapter, { formatter, hooks: { beforeRequest } });
    const req = { ...request(), toolMode: 'native' as const };
    let caught: unknown;
    try {
      if (entry === 'stream') await membrane.stream(req, {
        onToolCalls: async calls => calls.map(call => ({ toolUseId: call.id, content: 'landed' })),
      });
      else {
        const stream = membrane.streamYielding(req);
        for await (const event of stream) {
          if (event.type === 'tool-calls') stream.provideToolResults(
            event.calls.map(call => ({ toolUseId: call.id, content: 'landed' })));
          if (event.type === 'error') throw event.error;
        }
      }
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(MembraneNotReadyError);
    expect(caught).toMatchObject({ formatterName: 'native', type: 'invalid_request', retryable: false });
    expect(builds).toBe(2);
    expect(beforeRequest).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
  });

  function mixedBudget(): NormalizedRequest {
    return { ...request(), promptCaching: true, toolMode: 'native',
      system: [{ type: 'text', text: 'rules', cache_control: { type: 'ephemeral' } }],
      messages: Array.from({ length: 4 }, (_, i) => ({
        participant: 'User', content: [{ type: 'text', text: 'marked ' + i }], cacheBreakpoint: true,
      })),
    };
  }

  it('standalone refusal counts system and message markers together', () => {
    const req = mixedBudget();
    const before = structuredClone(req);
    expect(() => new NativeFormatter().buildMessages(req.messages, {
      participantMode: 'multiuser', assistantParticipant: 'Claude', promptCaching: true,
      systemPrompt: req.system, tools: req.tools,
    })).toThrow(/5 markers/);
    expect(req).toEqual(before);
  });

  for (const policy of ['membrane-system', 'cm-owned'] as const) {
    it.each(['complete', 'stream', 'yielding'])(policy + ' %s respects mixed-surface ownership', async entry => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { adapter, requests } = recordingAdapter();
      const beforeRequest = vi.fn((_source, built) => {
        expect(countWireCacheMarkers(built)).toBe(5);
        return built;
      });
      const membrane = new Membrane(adapter, { formatter: new NativeFormatter(), hooks: { beforeRequest } });
      const req = { ...mixedBudget(), cacheMarkers: policy };
      const before = structuredClone(req);
      if (policy === 'cm-owned') {
        await expect(invoke(entry, membrane, req)).rejects.toThrow(/5 markers/);
        expect(beforeRequest).not.toHaveBeenCalled();
        expect(requests).toEqual([]);
      } else {
        await invoke(entry, membrane, req);
        expect(beforeRequest).toHaveBeenCalledTimes(1);
        expect(requests).toHaveLength(1);
        expect(countWireCacheMarkers(requests[0])).toBe(4);
      }
      expect(req).toEqual(before);
    });
  }
});

describe('a cache marker on a duplicate result that is left out', () => {
  it.each(['duplicate_in_cycle', 'cycle_closed'])('moves to the last cacheable block before it for $0', reason => {
    const duplicate = { ...result('zz-second-copy'), cache_control: marker };
    const input = reason === 'duplicate_in_cycle'
      ? [message('user', text('go')), message('assistant', use()), message('user', result('first'), duplicate)]
      : [message('user', text('go')), message('assistant', use()), message('user', result('first')), message('assistant', text('later')), message('user', duplicate)];
    const before = structuredClone(input);
    const output = normalizeToolPairs(input).messages;
    expect(JSON.stringify(output)).not.toContain('zz-second-copy');
    const marked = blocks(output).filter(block => block.cache_control);
    expect(marked).toEqual([reason === 'duplicate_in_cycle' ? { ...result('first'), cache_control: marker } : { ...text('later'), cache_control: marker }]);
    expect(input).toEqual(before);
  });

  it.each(['complete', 'stream', 'yielding'])('keeps a duplicate-message breakpoint on the result it duplicates through %s, leaving the system prompt unmarked', async entry => {
    const { adapter, requests } = recordingAdapter();
    const membrane = new Membrane(adapter, { formatter: new NativeFormatter() });
    const req: NormalizedRequest = {
      ...request(), promptCaching: true, cacheTtl: '1h', system: 'rules', toolMode: 'native',
      messages: [
        { participant: 'User', content: [{ type: 'text', text: 'go' }] },
        { participant: 'Claude', content: [{ type: 'tool_use', id: 'u', name: 'noop', input: {} }] },
        { participant: 'Tool', cacheBreakpoint: true, content: [
          { type: 'tool_result', toolUseId: 'u', content: 'first' },
          { type: 'tool_result', toolUseId: 'u', content: 'duplicate' },
        ] },
      ],
    };
    const before = structuredClone(req);
    await invoke(entry, membrane, req);
    expect(requests).toHaveLength(1);
    const wire = requests[0];
    expect(JSON.stringify(wire.messages)).not.toContain('duplicate');
    expect(blocks(wire.messages as ProviderMessage[]).filter(block => block.cache_control)).toEqual([
      { type: 'tool_result', tool_use_id: 'u', content: 'first', cache_control: marker },
    ]);
    expect(countWireCacheMarkers(wire)).toBe(1);
    expect(wire.system).toBe('rules');
    expect(req).toEqual(before);
  });
});

describe('a cache marker on an orphan result', () => {
  const orphan = { type: 'tool_result' as const, toolUseId: 'zz-gone', content: 'orphan payload' };
  async function wireOf(messages: NormalizedRequest['messages'], extra: Partial<NormalizedRequest> = {}, entry = 'complete') {
    const { adapter, requests } = recordingAdapter();
    const receipts: unknown[] = [];
    const membrane = new Membrane(adapter, { formatter: new NativeFormatter() });
    const req: NormalizedRequest = {
      ...request(), promptCaching: true, cacheTtl: '1h', system: 'rules', toolMode: 'native', messages,
      onCacheWireReceipt: receipt => receipts.push(receipt), ...extra,
    };
    const before = structuredClone({ ...req, onCacheWireReceipt: undefined });
    await invoke(entry, membrane, req);
    expect({ ...req, onCacheWireReceipt: undefined }).toEqual(before);
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0].messages)).not.toContain('orphan payload');
    return { wire: requests[0], receipts };
  }
  const marked = (wire: ProviderRequest) => blocks(wire.messages as ProviderMessage[]).filter(block => block.cache_control);

  it.each(['complete', 'stream', 'yielding'])('moves its breakpoint to the text before it in its message through %s, leaving the system prompt unmarked', async entry => {
    const { wire } = await wireOf([
      { participant: 'User', content: [{ type: 'text', text: 'go' }] },
      { participant: 'Tool', cacheBreakpoint: true, content: [{ type: 'text', text: 'see' }, orphan] },
    ], {}, entry);
    expect(marked(wire)).toEqual([{ type: 'text', text: 'Tool: see', cache_control: marker }]);
    expect(countWireCacheMarkers(wire)).toBe(1);
    expect(wire.system).toBe('rules');
  });

  it('moves the breakpoint of an orphan-only message to the last cacheable block of the message before it', async () => {
    const { wire } = await wireOf([
      { participant: 'User', content: [{ type: 'text', text: 'go' }] },
      { participant: 'Claude', content: [{ type: 'text', text: 'ok' }] },
      { participant: 'Tool', cacheBreakpoint: true, content: [orphan] },
      { participant: 'User', content: [{ type: 'text', text: 'next' }] },
    ]);
    expect(marked(wire)).toEqual([{ type: 'text', text: 'ok', cache_control: marker }]);
    expect(wire.system).toBe('rules');
  });

  it('lets the breakpoint go where that block carries one already, and membrane-system marks the system prompt when none is left', async () => {
    const { wire } = await wireOf([
      { participant: 'User', content: [{ type: 'text', text: 'go' }] },
      { participant: 'Claude', cacheBreakpoint: true, content: [{ type: 'text', text: 'ok' }] },
      { participant: 'Tool', cacheBreakpoint: true, content: [orphan] },
      { participant: 'User', content: [{ type: 'text', text: 'next' }] },
    ]);
    expect(marked(wire)).toEqual([{ type: 'text', text: 'ok', cache_control: marker }]);
    expect(countWireCacheMarkers(wire)).toBe(1);
    const alone = await wireOf([{ participant: 'Tool', cacheBreakpoint: true, content: [orphan] }, { participant: 'Claude', content: [{ type: 'text', text: 'ok' }] }]);
    expect(marked(alone.wire)).toEqual([]);
    expect(alone.wire.system).toEqual([{ type: 'text', text: 'rules', cache_control: marker }]);
  });

  it('reports a cm-owned caller\'s moved marker in the cache wire receipt where it went, as the same request with the marker there would', async () => {
    const owned = { cacheMarkers: 'cm-owned' as const };
    const moved = await wireOf([
      { participant: 'User', content: [{ type: 'text', text: 'go' }] },
      { participant: 'Claude', content: [{ type: 'text', text: 'ok' }] },
      { participant: 'Tool', cacheBreakpoint: true, content: [orphan] },
      { participant: 'User', content: [{ type: 'text', text: 'next' }] },
    ], owned);
    const { adapter, requests } = recordingAdapter();
    const receipts: unknown[] = [];
    await new Membrane(adapter, { formatter: new NativeFormatter() }).complete({
      ...request(), promptCaching: true, cacheTtl: '1h', system: 'rules', toolMode: 'native', ...owned,
      onCacheWireReceipt: receipt => receipts.push(receipt),
      messages: [
        { participant: 'User', content: [{ type: 'text', text: 'go' }] },
        { participant: 'Claude', cacheBreakpoint: true, content: [{ type: 'text', text: 'ok' }] },
        { participant: 'User', content: [{ type: 'text', text: 'next' }] },
      ],
    });
    expect(moved.wire.messages).toEqual(requests[0].messages);
    expect(moved.receipts).toHaveLength(1);
    expect((moved.receipts[0] as { markers: unknown[] }).markers).toHaveLength(1);
    expect((moved.receipts[0] as { markers: unknown }).markers).toEqual((receipts[0] as { markers: unknown }).markers);
  });
});

describe('a normalizer refusal on the public paths', () => {
  const sharedId = 'toolu_rate_503_529';
  function refused(): NormalizedRequest {
    return {
      ...request(), toolMode: 'native',
      messages: [
        { participant: 'User', content: [{ type: 'text', text: 'go' }] },
        { participant: 'Claude', content: [
          { type: 'tool_use', id: sharedId, name: 'noop', input: {} },
          { type: 'tool_use', id: sharedId, name: 'noop', input: {} },
        ] },
      ],
    };
  }

  it.each(['complete', 'stream', 'yielding'])('reaches the caller of %s as itself, unretried', async entry => {
    const { adapter, requests } = recordingAdapter();
    const formatter = new NativeFormatter();
    const build = vi.spyOn(formatter, 'buildMessages');
    const onError = vi.fn(() => 'retry' as const);
    const membrane = new Membrane(adapter, { formatter, retry: { maxRetries: 3 }, hooks: { onError } });
    let caught: unknown;
    try {
      if (entry === 'complete') await membrane.complete(refused());
      else if (entry === 'stream') await membrane.stream(refused());
      else for await (const event of membrane.streamYielding(refused())) {
        if (event.type === 'error') caught = event.error;
      }
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MembraneNormalizerError);
    expect(caught).toMatchObject({ type: 'invalid_request', retryable: false });
    expect((caught as Error).message).toContain(`share the id '${sharedId}'`);
    expect(onError).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
    if (entry === 'complete') expect(build).toHaveBeenCalledTimes(1);
  });
});

describe('current excess-marker policy after synthetic results', () => {
  function overBudget(): NormalizedRequest {
    return {
      ...request(), promptCaching: true, toolMode: 'native',
      messages: [
        { participant: 'User', content: Array.from({ length: 4 }, (_, i) => ({ type: 'text' as const, text: 'marked ' + i, cache_control: { type: 'ephemeral' as const } })) },
        { participant: 'Claude', content: [{ type: 'tool_use', id: 'u', name: 'noop', input: {} }] },
        { participant: 'User', content: [{ type: 'text', text: 'fifth', cache_control: { type: 'ephemeral' } }] },
      ],
    };
  }

  it('leaves caller markers to the builder rather than suppressing after synthesis', () => {
    const input = [message('user', ...Array.from({ length: 4 }, (_, i) => ({ ...text('marked ' + i), cache_control: marker }))), message('assistant', use()), message('user', { ...text('fifth'), cache_control: marker })];
    const output = normalizeToolPairs(input).messages;
    expect(countWireCacheMarkers({ messages: output })).toBe(5);
    expect(blocks(output)).toContainEqual({ type: 'tool_result', tool_use_id: 'u', content: '[pending]', is_error: false });
  });

  it('standalone NativeFormatter refuses five preexisting markers', () => {
    expect(() => new NativeFormatter().buildMessages(overBudget().messages, {
      participantMode: 'multiuser', assistantParticipant: 'Claude', promptCaching: true,
    })).toThrow(/cache_control limit exceeded/);
  });

  it.each(['complete', 'stream', 'yielding'])('clamps the native %s wire to four markers', async entry => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { adapter, requests } = recordingAdapter();
    const membrane = new Membrane(adapter, { formatter: new NativeFormatter() });
    const req = overBudget();
    const before = structuredClone(req);
    if (entry === 'complete') await membrane.complete(req);
    else if (entry === 'stream') await membrane.stream(req);
    else for await (const event of membrane.streamYielding(req)) {
      if (event.type === 'error') throw event.error;
    }
    expect(requests).toHaveLength(1);
    expect(countWireCacheMarkers(requests[0])).toBe(4);
    expect(blocks(requests[0].messages as ProviderMessage[])).toContainEqual({ type: 'tool_result', tool_use_id: 'u', content: '[pending]', is_error: false });
    expect(req).toEqual(before);
  });
});
