import { describe, expect, it } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import {
  assertToolPairsValid, MembraneNormalizerError, mergeConsecutiveRoles,
  normalizeToolPairs, type ProviderBlock,
} from '../../src/formatters/normalize-tool-pairs.js';
import type { ProviderMessage, NormalizeEvent } from '../../src/formatters/types.js';
import type { NormalizedRequest, ProviderAdapter, ProviderRequest } from '../../src/types/index.js';
import { countWireCacheMarkers } from '../../src/utils/cache-marker-budget.js';

const text = (value: string): ProviderBlock => ({ type: 'text', text: value });
const use = (id: string): ProviderBlock => ({ type: 'tool_use', id, name: 'noop', input: {} });
const result = (id: string, value = id): ProviderBlock => ({ type: 'tool_result', tool_use_id: id, content: value });
const image = (): ProviderBlock => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } });
const message = (role: 'user' | 'assistant', ...content: ProviderBlock[]): ProviderMessage => ({ role, content });
const recovered = text('[orphan tool_result for zz]: ghost');
const marker = { type: 'ephemeral', ttl: '1h' };
const cycle = (content: ProviderBlock[], ids = ['a', 'b']): ProviderMessage[] => [
  message('user', text('hi')), message('assistant', ...ids.map(use)), message('user', ...content),
];
const tail = (messages: ProviderMessage[]): ProviderBlock[] => messages.at(-1)!.content as ProviderBlock[];
const composed = (input: ProviderMessage[]) => mergeConsecutiveRoles(normalizeToolPairs(input).messages);

const cases = [
  { label: 'leading orphan', input: [result('zz', 'ghost'), result('a'), result('b')], expected: [result('a'), result('b'), recovered] },
  { label: 'interleaved orphan', input: [result('a'), result('zz', 'ghost'), result('b')], expected: [result('a'), result('b'), recovered] },
  { label: 'interleaved text', input: [result('a'), text('middle'), result('b')], expected: [result('a'), result('b'), text('middle')] },
  { label: 'interleaved image', input: [result('a'), image(), result('b')], expected: [result('a'), result('b'), image()] },
  { label: 'result order is stable', input: [result('b'), text('middle'), result('a')], expected: [result('b'), result('a'), text('middle')] },
  { label: 'non-result order is stable', input: [text('before'), result('a'), image(), text('middle'), result('b'), text('after')], expected: [result('a'), result('b'), text('before'), image(), text('middle'), text('after')] },
  { label: 'already results-first', input: [result('a'), result('b'), text('after')], expected: [result('a'), result('b'), text('after')] },
];

describe('results-first repair and independent validation', () => {
  it.each(cases)('$label survives normalize and normalize-to-merge composition', ({ input: content, expected }) => {
    const input = cycle(content);
    const before = structuredClone(input);
    const normalized = normalizeToolPairs(input);
    expect(normalized.ready).toBe(true);
    expect(tail(normalized.messages)).toEqual(expected);
    const output = mergeConsecutiveRoles(normalized.messages);
    expect(tail(output)).toEqual(expected);
    expect(() => assertToolPairsValid(output)).not.toThrow();
    expect(composed(output)).toEqual(output);
    expect(input).toEqual(before);
  });

  it.each([
    [text('before'), result('a'), result('b')],
    [result('a'), text('middle'), result('b')],
    [result('a'), image(), result('b')],
  ])('standalone validation refuses results after other blocks: %j', (...content) => {
    const input = cycle(content);
    const before = structuredClone(input);
    expect(() => assertToolPairsValid(input)).toThrow(MembraneNormalizerError);
    expect(() => assertToolPairsValid(input, new Set(['a', 'b']))).toThrow(/tool_result.*before/i);
    expect(input).toEqual(before);
  });

  it('accepts results followed by text/images and text-only user turns', () => {
    expect(() => assertToolPairsValid(cycle([result('a'), result('b'), text('after'), image()]))).not.toThrow();
    expect(() => assertToolPairsValid([message('user', text('plain'), image())])).not.toThrow();
  });

  it('orders orphan recovery after both real and synthesized results', () => {
    const input = cycle([result('zz', 'ghost'), text('event'), result('b')]);
    const output = normalizeToolPairs(input);
    expect(output.ready).toBe(true);
    expect(tail(output.messages)).toEqual([
      { ...result('a', '[pending]'), is_error: false }, result('b'), recovered, text('event'),
    ]);
    expect(composed(output.messages)).toEqual(mergeConsecutiveRoles(output.messages));
  });

  it('preserves an explicitly pending gap while repairing the present result order', () => {
    const input = cycle([result('zz', 'ghost'), result('a'), text('event')]);
    const pending = new Set(['b']);
    const output = normalizeToolPairs(input, { pendingToolCallIds: pending });
    expect(output.ready).toBe(false);
    expect(tail(output.messages)).toEqual([result('a'), recovered, text('event')]);
    expect(() => assertToolPairsValid(output.messages, pending)).not.toThrow();
    const again = normalizeToolPairs(output.messages, { pendingToolCallIds: pending });
    expect(again).toEqual(output);
  });

  it('retains duplicate recovery payload and its marker after later results', () => {
    const input = cycle([result('a'), { ...result('a', 'duplicate'), cache_control: marker }, result('b')]);
    const output = composed(input);
    expect(tail(output)).toEqual([
      result('a'), result('b'), { type: 'text', text: '[duplicate tool_result for a]: duplicate', cache_control: marker },
    ]);
    expect(countWireCacheMarkers({ messages: output })).toBe(1);
  });

  it('retains array payloads and cache markers on reordered blocks', () => {
    const real = { ...result('a'), content: [text('payload'), image()], cache_control: marker };
    const other = { ...image(), cache_control: marker };
    const input = cycle([real, other, result('b')]);
    const before = structuredClone(input);
    const output = composed(input);
    expect(tail(output)).toEqual([real, result('b'), other]);
    expect(countWireCacheMarkers({ messages: output })).toBe(2);
    expect(input).toEqual(before);
  });

  it('emits deferred events for displaced non-results, not the already-valid suffix', () => {
    const events: NormalizeEvent[] = [];
    normalizeToolPairs(cycle([result('a'), text('middle'), image(), result('b'), text('after')]), {
      onEvent: event => events.push(event),
    });
    expect(events.filter(event => event.kind === 'interloper_deferred')).toEqual([
      { kind: 'interloper_deferred', blockType: 'text', fromEnvelope: 2 },
      { kind: 'interloper_deferred', blockType: 'image', fromEnvelope: 2 },
    ]);
  });

  it('stably partitions every permutation of two results, an orphan, text, and an image', () => {
    function permutations(items: ProviderBlock[]): ProviderBlock[][] {
      if (items.length === 0) return [[]];
      return items.flatMap((item, i) => permutations(items.filter((_, j) => i !== j)).map(rest => [item, ...rest]));
    }
    const inputs = permutations([result('a'), result('b'), result('zz', 'ghost'), text('event'), image()]);
    expect(inputs).toHaveLength(120);
    for (const content of inputs) {
      const repaired = content.map(block => block.type === 'tool_result' && block.tool_use_id === 'zz' ? recovered : block);
      const expected = [...repaired.filter(block => block.type === 'tool_result'), ...repaired.filter(block => block.type !== 'tool_result')];
      const output = composed(cycle(content));
      expect(tail(output)).toEqual(expected);
      expect(() => assertToolPairsValid(output)).not.toThrow();
      expect(composed(output)).toEqual(output);
    }
  });
});

describe('public native request ordering', () => {
  it.each(['complete', 'stream', 'yielding'])('%s sends all tool results before recovered/user content', async entry => {
    const sent: ProviderRequest[] = [];
    const response = (req: ProviderRequest) => {
      sent.push(structuredClone(req));
      return { content: [{ type: 'text' as const, text: 'done' }], stopReason: 'end_turn' as const, usage: { inputTokens: 1, outputTokens: 1 }, raw: {} };
    };
    const adapter: ProviderAdapter = {
      name: 'order-probe', supportsModel: () => true,
      complete: async req => response(req),
      stream: async (req, callbacks) => { callbacks.onChunk('done'); return response(req); },
    };
    const req: NormalizedRequest = {
      config: { model: 'test-model', maxTokens: 128 }, toolMode: 'native', promptCaching: true, cacheTtl: '1h',
      tools: [{ name: 'noop', description: 'noop', inputSchema: { type: 'object' } }],
      messages: [
        { participant: 'User', content: [{ type: 'text', text: 'hi' }] },
        { participant: 'Claude', content: [
          { type: 'tool_use', id: 'a', name: 'noop', input: {} },
          { type: 'tool_use', id: 'b', name: 'noop', input: {} },
        ] },
        { participant: 'Tool', cacheBreakpoint: true, content: [
          { type: 'tool_result', toolUseId: 'zz', content: 'ghost' },
          { type: 'tool_result', toolUseId: 'a', content: 'real-a' },
          { type: 'text', text: 'event' },
          { type: 'tool_result', toolUseId: 'b', content: 'real-b' },
        ] },
      ],
    };
    const before = structuredClone(req);
    const membrane = new Membrane(adapter, { formatter: new NativeFormatter() });
    if (entry === 'complete') await membrane.complete(req);
    else if (entry === 'stream') await membrane.stream(req);
    else for await (const event of membrane.streamYielding(req)) if (event.type === 'error') throw event.error;
    expect(sent).toHaveLength(1);
    const output = sent[0].messages as ProviderMessage[];
    expect(tail(output).map(block => block.type)).toEqual(['tool_result', 'tool_result', 'text', 'text']);
    expect(tail(output).filter(block => block.type === 'tool_result').map(block => block.tool_use_id)).toEqual(['a', 'b']);
    expect(tail(output).filter(block => block.type === 'text').map(block => block.text).join(' ')).toContain('ghost');
    expect(tail(output).filter(block => block.type === 'text').map(block => block.text).join(' ')).toContain('event');
    expect(tail(output)[1].cache_control).toEqual(marker);
    expect(() => assertToolPairsValid(output)).not.toThrow();
    expect(req).toEqual(before);
  });
});
