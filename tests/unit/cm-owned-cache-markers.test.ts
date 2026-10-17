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

/** A caller's system prompt as an array of blocks, none of them marked. */
const unmarkedSystemArray = () => [{ type: 'text' as const, text: 'system one' }, { type: 'text' as const, text: 'system two' }];

/** The system blocks a build sends: each one's text, and whether it carries a marker. */
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
    // No system prompt and a context prefix: the build stands in its CLI-simulation system block.
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
      // Without it Membrane resolves native tool mode, and the XML formatter
      // hands the build to the native formatter.
      toolMode: 'xml',
    });
    const sent = adapter.getLastRequest() as unknown as { system?: unknown; messages?: unknown[] };
    // The XML transcript was built: it ends in the assistant's prefill.
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
