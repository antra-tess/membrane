import { describe, expect, it } from 'vitest';
import { NativeFormatter } from '../../src/formatters/native.js';
import { AnthropicXmlFormatter } from '../../src/formatters/anthropic-xml.js';
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

function build(formatter: NativeFormatter | AnthropicXmlFormatter, messages: NormalizedMessage[]): BuildResult {
  return formatter.buildMessages(messages, {
    participantMode: 'multiuser',
    assistantParticipant: 'Claude',
    promptCaching: true,
    cacheMarkers: 'cm-owned',
    systemPrompt: 'system',
    contextPrefix: 'prefix',
  });
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
  }

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
});
