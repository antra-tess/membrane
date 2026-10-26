/** A signature on another payload's text fails Anthropic's signature validation on the next turn. */
import { describe, it, expect } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { sameThinkingText, findSpanningProviderRun } from '../../src/utils/thinking-carriers.js';
import type { ContentBlock } from '../../src/types/index.js';

const thinking = (text: string, signature?: string): ContentBlock =>
  ({ type: 'thinking', thinking: text, ...(signature ? { signature } : {}) }) as ContentBlock;

const answer = (text: string): ContentBlock => ({ type: 'text', text }) as ContentBlock;

function merger() {
  const membrane = new Membrane({ name: 'zz-fake-adapter' } as any);
  return (content: ContentBlock[], provider: ContentBlock[]) =>
    (membrane as any).mergeProviderThinkingBlocks(content, provider);
}

function carriers(content: ContentBlock[]): Array<[string, string | undefined]> {
  return content
    .filter((b) => b.type === 'thinking')
    .map((b) => [
      (b as { thinking?: string }).thinking ?? '',
      (b as { signature?: string }).signature,
    ]);
}

describe('sameThinkingText: internal whitespace is payload, not noise', () => {
  it('separates two payloads that differ only in where a space falls', () => {
    expect(sameThinkingText('zz-ab c', 'zz-a bc')).toBe(false);
  });

  it('separates a doubled internal space from a single one', () => {
    expect(sameThinkingText('zz-alpha  zz-beta', 'zz-alpha zz-beta')).toBe(false);
  });

  it('separates a newline-joined payload from a space-joined one', () => {
    expect(sameThinkingText('zz-alpha\nzz-beta', 'zz-alpha zz-beta')).toBe(false);
  });

  it('still sees through the XML path scaffolding tags', () => {
    expect(sameThinkingText('<thinking>zz-body one</thinking>', 'zz-body one')).toBe(true);
    expect(sameThinkingText('<antml:thinking>zz-body one</antml:thinking>', 'zz-body one')).toBe(true);
  });

  it('still sees through whitespace at the outer boundaries', () => {
    expect(sameThinkingText('zz-body one  ', 'zz-body one')).toBe(true);
    expect(sameThinkingText('\n  zz-body one\n', 'zz-body one')).toBe(true);
  });

  it('keeps signature-only carriers prepend-only', () => {
    expect(sameThinkingText('', '')).toBe(false);
    expect(sameThinkingText('   ', 'zz-body one')).toBe(false);
  });
});

describe('mergeProviderThinkingBlocks: near-collision payloads keep their own signatures', () => {
  it('does not stamp one payload signature onto the other spelling of it', () => {
    const merge = merger();
    const content = [thinking('zz-ab c'), answer('zz visible tail')];
    merge(content, [thinking('zz-a bc', 'zz-sig-of-a-bc')]);

    expect(carriers(content)).toEqual([
      ['zz-a bc', 'zz-sig-of-a-bc'],
      ['zz-ab c', undefined],
    ]);
  });
});

describe('findSpanningProviderRun: the continuation trimEnd join still reconstructs', () => {
  it('reconstructs a parsed block whose round boundary lost the fragment trailing space', () => {
    const run = findSpanningProviderRun(
      [
        { thinking: 'zz-part one ', signature: 'zz-sig-round1' },
        { thinking: 'and part two', signature: 'zz-sig-round2' },
      ],
      new Set<number>(),
      'zz-part oneand part two'
    );
    expect(run).toEqual([0, 1]);
  });

  it('still reconstructs when the join whitespace survived verbatim', () => {
    const run = findSpanningProviderRun(
      [
        { thinking: 'zz-part one ', signature: 'zz-sig-round1' },
        { thinking: 'and part two', signature: 'zz-sig-round2' },
      ],
      new Set<number>(),
      'zz-part one and part two'
    );
    expect(run).toEqual([0, 1]);
  });

  it('does not reconstruct a run whose INTERNAL spelling differs', () => {
    const run = findSpanningProviderRun(
      [
        { thinking: 'zz-part one', signature: 'zz-sig-round1' },
        { thinking: 'and part two', signature: 'zz-sig-round2' },
      ],
      new Set<number>(),
      'zz-part o neand part two'
    );
    expect(run).toBeUndefined();
  });
});
