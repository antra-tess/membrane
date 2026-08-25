/**
 * Helpers for pairing provider-native thinking carriers (which hold the
 * signatures) with parser-derived thinking blocks (which hold the text).
 * See Membrane.mergeProviderThinkingBlocks for the pairing rules.
 */
import type { ContentBlock } from '../types/index.js';

/**
 * Identity for thinking text, insensitive to two artifacts that ride the
 * parser's view of the same reasoning:
 *
 *  - stream scaffolding: the XML path prefills `Claude: <thinking>` and asks
 *    the adapter to wrap native thinking deltas, so a parsed block can carry
 *    a literal `<thinking>` / `</thinking>` tag the provider block never had.
 *  - boundary whitespace: the continuation path trims the accumulation at
 *    each round boundary (`buildContinuationRequest` trimEnds before
 *    re-prefilling), so a fragment and the parsed concatenation can differ by
 *    exactly that whitespace.
 *
 * Comparison only — stored text is never rewritten. Empty text is never
 * identical to anything: signature-only carriers are prepend-only.
 */
export function sameThinkingText(left: string, right: string): boolean {
  if (left === right) return left !== '';
  if (left === '' || right === '') return false;
  const normalized = (text: string) =>
    text.replace(/<\/?(antml:)?thinking>/g, '').replace(/\s+/g, '');
  const normalizedLeft = normalized(left);
  if (normalizedLeft === '') return false;
  return normalizedLeft === normalized(right);
}

/**
 * Find a RUN of consecutive still-unpaired provider blocks whose concatenated
 * thinking reconstructs `parsedText` (an auto-continuation split across a
 * max_tokens boundary). Returns the provider indices in order, or undefined
 * when no run of two or more reconstructs it.
 */
export function findSpanningProviderRun(
  providerThinking: Array<{ thinking?: string; signature?: string }>,
  pairedProviderBlocks: ReadonlySet<number>,
  parsedText: string
): number[] | undefined {
  for (let start = 0; start < providerThinking.length; start++) {
    if (pairedProviderBlocks.has(start)) continue;
    let concatenated = providerThinking[start]!.thinking ?? '';
    const run = [start];
    for (let next = start + 1; next < providerThinking.length; next++) {
      if (pairedProviderBlocks.has(next)) break;
      concatenated += providerThinking[next]!.thinking ?? '';
      run.push(next);
      if (sameThinkingText(concatenated, parsedText)) return [...run];
    }
  }
  return undefined;
}

/**
 * De-duplication key for a thinking / redacted_thinking carrier: two carriers
 * are the same carrier when their payload and signature match. Any other block
 * type gets a unique key so it can never collide.
 */
export function thinkingCarrierKey(block: ContentBlock): string {
  if (block.type === 'thinking') {
    const { thinking, signature } = block as { thinking?: string; signature?: string };
    return `thinking\u0000${thinking ?? ''}\u0000${signature ?? ''}`;
  }
  if (block.type === 'redacted_thinking') {
    return `redacted\u0000${(block as unknown as { data?: string }).data ?? ''}`;
  }
  return `other\u0000${JSON.stringify(block)}`;
}
