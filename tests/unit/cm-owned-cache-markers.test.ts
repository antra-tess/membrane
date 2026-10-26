import { describe, expect, it } from 'vitest';
import { NativeFormatter } from '../../src/formatters/native.js';
import { AnthropicXmlFormatter } from '../../src/formatters/anthropic-xml.js';
import { Membrane } from '../../src/membrane.js';
import { MockAdapter } from '../../src/providers/mock.js';
import type { BuildResult } from '../../src/formatters/types.js';
import type { NormalizedMessage } from '../../src/types/index.js';

function markedMessages(count: number): NormalizedMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    participant: index % 2 === 0 ? 'User' : 'Claude',
    content: [{ type: 'text', text: `message-${index}` }],
    cacheBreakpoint: true,
  }));
}

function countCacheControls(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countCacheControls(item), 0);
  if (!value || typeof value !== 'object') return 0;
  const record = value as Record<string, unknown>;
  return (record.cache_control ? 1 : 0) +
    Object.entries(record)
      .filter(([key]) => key !== 'cache_control')
      .reduce((sum, [, item]) => sum + countCacheControls(item), 0);
}

function build(
  formatter: NativeFormatter | AnthropicXmlFormatter,
  messages: NormalizedMessage[],
  systemPrompt: string | Array<{ type: 'text'; text: string; cache_control?: unknown }> = 'system',
  cacheMarkers: 'cm-owned' | 'membrane-system' = 'cm-owned',
): BuildResult {
  return formatter.buildMessages(messages, {
    participantMode: 'multiuser',
    assistantParticipant: 'Claude',
    promptCaching: true,
    cacheMarkers,
    systemPrompt: systemPrompt as never,
    contextPrefix: 'prefix',
  });
}

const unmarkedSystemArray = () => [{ type: 'text' as const, text: 'system one' }, { type: 'text' as const, text: 'system two' }];

function sentSystem(system: unknown): Array<{ text: unknown; marked: boolean }> {
  return Array.isArray(system)
    ? system.map((block) => {
      const record = block as Record<string, unknown>;
      return { text: record.text, marked: record.cache_control !== undefined };
    })
    : [];
}

describe('cm-owned cache marker contract', () => {
  for (const [name, formatter] of [
    ['native', new NativeFormatter()],
    ['anthropic-xml', new AnthropicXmlFormatter()],
  ] as const) {
    it(`${name}: emits no automatic system or context-prefix marker`, () => {
      expect(countCacheControls(build(formatter, []))).toBe(0);
    });

    it(`${name}: four caller breakpoints consume exactly four slots`, () => {
      expect(countCacheControls(build(formatter, markedMessages(4)))).toBe(4);
    });

    it(`${name}: five caller breakpoints fail before submission`, () => {
      expect(() => build(formatter, markedMessages(5))).toThrow(/maximum 4/);
    });

    it(`${name}: marks no block of an unmarked system array`, () => {
      const result = build(formatter, [], unmarkedSystemArray());
      expect(countCacheControls(result)).toBe(0);
      expect(sentSystem(result.systemContent)).toEqual([
        { text: 'system one', marked: false },
        { text: 'system two', marked: false },
      ]);
    });

    it(`${name}: four caller breakpoints beside an unmarked system array consume exactly four slots`, () => {
      const result = build(formatter, markedMessages(4), unmarkedSystemArray());
      expect(countCacheControls(result)).toBe(4);
      expect(sentSystem(result.systemContent)).toEqual([
        { text: 'system one', marked: false },
        { text: 'system two', marked: false },
      ]);
    });

    it(`${name}: keeps the markers of a caller-marked system array and adds none`, () => {
      const system = [
        { type: 'text' as const, text: 'system one', cache_control: { type: 'ephemeral' } },
        { type: 'text' as const, text: 'system two' },
      ];
      const result = build(formatter, markedMessages(3), system);
      expect(countCacheControls(result)).toBe(4);
      expect(sentSystem(result.systemContent)).toEqual([
        { text: 'system one', marked: true },
        { text: 'system two', marked: false },
      ]);
    });
  }

  it('anthropic-xml: the CLI-simulation system block carries a marker only under membrane-system', () => {
    const owned = build(new AnthropicXmlFormatter(), [], '');
    expect(sentSystem(owned.systemContent)).toEqual([{ text: expect.stringContaining('CLI simulation mode'), marked: false }]);
    expect(countCacheControls(owned)).toBe(0);

    const membraneOwned = build(new AnthropicXmlFormatter(), [], '', 'membrane-system');
    expect(sentSystem(membraneOwned.systemContent)).toEqual([{ text: expect.stringContaining('CLI simulation mode'), marked: true }]);
  });

  it('anthropic-xml through Membrane: four breakpoints beside an unmarked system array send exactly four markers', async () => {
    const adapter = new MockAdapter();
    const membrane = new Membrane(adapter, { formatter: new AnthropicXmlFormatter() });
    await membrane.complete({
      messages: markedMessages(4),
      system: unmarkedSystemArray() as never,
      config: { model: 'test-model', maxTokens: 10 },
      promptCaching: true,
      cacheMarkers: 'cm-owned',
      assistantParticipant: 'Claude',
      toolMode: 'xml',
    });
    const sent = adapter.getLastRequest() as unknown as { system?: unknown; messages?: unknown[] };
    expect(sent.messages?.at(-1)).toEqual({ role: 'assistant', content: 'Claude:' });
    expect(countCacheControls({ system: sent.system, messages: sent.messages })).toBe(4);
    expect(sentSystem(sent.system)).toEqual([
      { text: 'system one', marked: false },
      { text: 'system two', marked: false },
    ]);
  });

  it('native rejects hidden imported block-level markers in cm-owned mode', () => {
    const formatter = new NativeFormatter();
    const messages: NormalizedMessage[] = [{
      participant: 'User',
      content: [{
        type: 'text',
        text: 'stale',
        cache_control: { type: 'ephemeral' },
      }],
    }];
    expect(() => build(formatter, messages)).toThrow(/imported block-level/);
  });

  for (const [name, makeFormatter, toolMode, method] of [
    ['native', () => new NativeFormatter(), undefined, 'complete'],
    ['anthropic-xml', () => new AnthropicXmlFormatter(), 'xml', 'complete'],
    ['native', () => new NativeFormatter(), undefined, 'stream'],
  ] as const) {
    it(`${name} through Membrane.${method}(): a hook that marks the system sends it beside three breakpoints`, async () => {
      const adapter = new MockAdapter();
      const membrane = new Membrane(adapter, {
        formatter: makeFormatter(),
        hooks: {
          beforeRequest: (_normalized, raw) => {
            const request = raw as Record<string, unknown>;
            const blocks = typeof request.system === 'string'
              ? [{ type: 'text', text: request.system }]
              : (request.system as Array<Record<string, unknown>>);
            return {
              ...request,
              system: blocks.map((block, index) =>
                index === blocks.length - 1 ? { ...block, cache_control: { type: 'ephemeral' } } : block),
            };
          },
        },
      });
      const normalized = {
        messages: markedMessages(3),
        system: 'system one',
        config: { model: 'test-model', maxTokens: 10 },
        promptCaching: true,
        cacheMarkers: 'cm-owned' as const,
        assistantParticipant: 'Claude',
        ...(toolMode ? { toolMode } : {}),
      };
      if (method === 'stream') await membrane.stream(normalized, { onChunk: () => {} });
      else await membrane.complete(normalized);
      const sent = adapter.getLastRequest() as unknown as { system?: unknown; messages?: unknown[] };
      if (toolMode === 'xml') expect(sent.messages?.at(-1)).toEqual({ role: 'assistant', content: 'Claude:' });
      expect(sentSystem(sent.system)).toEqual([{ text: 'system one', marked: true }]);
      expect(countCacheControls({ system: sent.system, messages: sent.messages })).toBe(4);
    });
  }

  it('fails closed when a final hook adds a fifth caller-owned marker', async () => {
    let receiptCalls = 0;
    const membrane = new Membrane(new MockAdapter(), {
      formatter: new NativeFormatter(),
      hooks: {
        beforeRequest: (_normalized, raw) => ({
          ...(raw as Record<string, unknown>),
          system: [{
            type: 'text', text: 'hook marker',
            cache_control: { type: 'ephemeral' },
          }],
        }),
      },
    });
    await expect(membrane.complete({
      messages: markedMessages(4),
      config: { model: 'test-model', maxTokens: 10 },
      promptCaching: true,
      cacheMarkers: 'cm-owned',
      assistantParticipant: 'Claude',
      onCacheWireReceipt: () => { receiptCalls++; },
    })).rejects.toThrow(/maximum 4/);
    expect(receiptCalls).toBe(0);
  });

  it('fails closed on a hook-added thinking marker in the streaming path', async () => {
    const membrane = new Membrane(new MockAdapter(), {
      formatter: new NativeFormatter(),
      hooks: {
        beforeRequest: (_normalized, raw) => ({
          ...(raw as Record<string, unknown>),
          messages: [{
            role: 'user',
            content: [{
              type: 'thinking', thinking: 'hidden', signature: 'sig',
              cache_control: { type: 'ephemeral' },
            }],
          }],
        }),
      },
    });
    await expect(membrane.stream({
      messages: markedMessages(1),
      config: { model: 'test-model', maxTokens: 10 },
      promptCaching: true,
      cacheMarkers: 'cm-owned',
      assistantParticipant: 'Claude',
    }, { onChunk: () => {} })).rejects.toThrow(/thinking\/redacted_thinking/);
  });
});
