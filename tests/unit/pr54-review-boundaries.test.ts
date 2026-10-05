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
  { label: 'stream/XML', entry: 'stream', mode: 'xml', create: () => new AnthropicXmlFormatter() },
  { label: 'stream/Responses', entry: 'stream', mode: 'native', create: () => new OpenAIResponsesFormatter() },
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

describe('cache markers on duplicate textification', () => {
  it.each(['duplicate_in_cycle', 'cycle_closed'])('retains the marker and payload for $0', reason => {
    const duplicate = { ...result('duplicate'), cache_control: marker };
    const input = reason === 'duplicate_in_cycle'
      ? [message('user', text('go')), message('assistant', use()), message('user', result('first'), duplicate)]
      : [message('user', text('go')), message('assistant', use()), message('user', result('first')), message('assistant', text('later')), message('user', duplicate)];
    const before = structuredClone(input);
    const output = normalizeToolPairs(input).messages;
    expect(blocks(output).find(block => block.type === 'text' && String(block.text).includes('[duplicate tool_result'))).toEqual({
      type: 'text', text: '[duplicate tool_result for u]: duplicate', cache_control: marker,
    });
    expect(countWireCacheMarkers({ messages: output })).toBe(1);
    expect(input).toEqual(before);
  });

  it.each(['complete', 'stream', 'yielding'])('keeps a duplicate-message breakpoint through %s', async entry => {
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
    if (entry === 'complete') await membrane.complete(req);
    else if (entry === 'stream') await membrane.stream(req);
    else for await (const event of membrane.streamYielding(req)) {
      if (event.type === 'error') throw event.error;
    }
    expect(requests).toHaveLength(1);
    const wire = requests[0];
    expect(blocks(wire.messages as ProviderMessage[]).find(block => block.type === 'text' && String(block.text).includes('[duplicate tool_result'))?.cache_control).toEqual(marker);
    expect(countWireCacheMarkers(wire)).toBe(1);
    expect(wire.system).toBe('rules'); // The preserved message marker suppresses the system fallback.
    expect(req).toEqual(before);
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

  it('NativeFormatter refuses five preexisting markers before adapter execution', async () => {
    const { adapter, requests } = recordingAdapter();
    const membrane = new Membrane(adapter, { formatter: new NativeFormatter() });
    await expect(membrane.complete(overBudget())).rejects.toThrow(/cache_control limit exceeded/);
    expect(requests).toEqual([]);
  });

  it.each(['stream', 'yielding'])('clamps the native %s wire to four markers', async entry => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { adapter, requests } = recordingAdapter();
    const membrane = new Membrane(adapter, { formatter: new NativeFormatter() });
    const req = overBudget();
    const before = structuredClone(req);
    if (entry === 'stream') await membrane.stream(req);
    else for await (const event of membrane.streamYielding(req)) {
      if (event.type === 'error') throw event.error;
    }
    expect(requests).toHaveLength(1);
    expect(countWireCacheMarkers(requests[0])).toBe(4);
    expect(blocks(requests[0].messages as ProviderMessage[])).toContainEqual({ type: 'tool_result', tool_use_id: 'u', content: '[pending]', is_error: false });
    expect(req).toEqual(before);
  });
});
