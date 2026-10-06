/**
 * Thinking-carrier pairing: provider-native thinking blocks carry the
 * signatures; parser-derived blocks carry the text. Merging them by INDEX
 * (the pre-fix behaviour) crosses the two lists the moment their shapes
 * differ, and the mispaired carrier is exported to the consumer's stored
 * history and shipped back next turn, where the API validates a signature
 * against content that never produced it.
 *
 * Three reachable shape differences, one test each:
 *   1. a signature-only (display:'omitted') block beside a visible one
 *   2. an XML-visible thinking block that no provider block produced
 *   3. a continuation split: two provider fragments, one spanning parsed
 *      block (parseAccumulatedIntoBlocks sees the CONCATENATED accumulation)
 */
import { describe, it, expect } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import type { ContentBlock } from '../../src/types/index.js';

function merger() {
  const membrane = new Membrane({ name: 'zz-fake-adapter' } as any);
  return (content: ContentBlock[], provider: ContentBlock[]) =>
    (membrane as any).mergeProviderThinkingBlocks(content, provider);
}

const thinking = (text: string, signature?: string): ContentBlock =>
  ({ type: 'thinking', thinking: text, ...(signature ? { signature } : {}) }) as ContentBlock;

const answer = (text: string): ContentBlock => ({ type: 'text', text }) as ContentBlock;

/** Every thinking block as [text, signature] pairs, in wire order. */
function carriers(content: ContentBlock[]): Array<[string, string | undefined]> {
  return content
    .filter((b) => b.type === 'thinking')
    .map((b) => [
      (b as { thinking?: string }).thinking ?? '',
      (b as { signature?: string }).signature,
    ]);
}

describe('mergeProviderThinkingBlocks: identity pairing', () => {
  it('pairs a visible block with its OWN signature when a signature-only block precedes it', () => {
    const merge = merger();
    const content = [thinking('zz reasoning one'), answer('zz visible tail')];
    merge(content, [thinking('', 'zzsig-omitted'), thinking('zz reasoning one', 'zzsig-real')]);

    // The visible text wears the signature that produced it, exactly once.
    expect(carriers(content)).toEqual([
      ['', 'zzsig-omitted'],
      ['zz reasoning one', 'zzsig-real'],
    ]);
  });

  it('never text-matches a signature-only block (prepend-only)', () => {
    const merge = merger();
    const content = [thinking('zz reasoning two'), answer('zz visible tail')];
    merge(content, [thinking('', 'zzsig-omitted-only')]);

    const signed = carriers(content).filter(([text]) => text === 'zz reasoning two');
    expect(signed).toEqual([['zz reasoning two', undefined]]);
  });

  it('leaves an XML-visible thinking block unsigned when no provider block matches it', () => {
    // anthropic-xml prefills the literal "Claude: <thinking>" turn prefix, so
    // the parser emits a thinking block made of VISIBLE XML TEXT. Stamping a
    // native signature on it exports an unverifiable carrier.
    const merge = merger();
    const content = [thinking('zz xml-visible reasoning'), answer('zz visible tail')];
    merge(content, [thinking('zz native reasoning', 'zzNativeSig')]);

    expect(carriers(content)).toEqual([
      ['zz native reasoning', 'zzNativeSig'],
      ['zz xml-visible reasoning', undefined],
    ]);
  });

  it('does not duplicate a block the parser and the provider both produced', () => {
    const merge = merger();
    const content = [thinking('zz reasoning three', 'zzsig-three'), answer('zz visible tail')];
    merge(content, [thinking('zz reasoning three', 'zzsig-three')]);

    expect(carriers(content)).toEqual([['zz reasoning three', 'zzsig-three']]);
  });

  it('splits a spanning parsed block back into the provider fragments that produced it', () => {
    // Continuation across a max_tokens boundary: capture runs per round and
    // collects two provider blocks, while the parser sees one concatenated
    // block. The spanning block must NOT wear the round-1 signature.
    const merge = merger();
    const content = [
      thinking('zz part one of the thought and part two after the length stop'),
      answer('zz final answer'),
    ];
    merge(content, [
      thinking('zz part one of the thought ', 'zz-sig-round1'),
      thinking('and part two after the length stop', 'zz-sig-round2'),
    ]);

    expect(carriers(content)).toEqual([
      ['zz part one of the thought ', 'zz-sig-round1'],
      ['and part two after the length stop', 'zz-sig-round2'],
    ]);
    expect(content[content.length - 1]).toEqual(answer('zz final answer'));
  });

  it('prepends the originals and leaves the parsed block unsigned when the span does not reconstruct', () => {
    const merge = merger();
    const content = [thinking('zz unrelated parsed reasoning'), answer('zz final answer')];
    merge(content, [
      thinking('zz fragment alpha', 'zz-sig-alpha'),
      thinking('zz fragment beta', 'zz-sig-beta'),
    ]);

    expect(carriers(content)).toEqual([
      ['zz fragment alpha', 'zz-sig-alpha'],
      ['zz fragment beta', 'zz-sig-beta'],
      ['zz unrelated parsed reasoning', undefined],
    ]);
  });

  it('prepends redacted_thinking verbatim, without duplicating one already present', () => {
    const merge = merger();
    const redacted = { type: 'redacted_thinking', data: 'zz-encrypted-payload' } as unknown as ContentBlock;
    const content = [{ ...redacted } as ContentBlock, answer('zz final answer')];
    merge(content, [redacted]);

    expect(content.filter((b) => b.type === 'redacted_thinking')).toHaveLength(1);
  });
});
