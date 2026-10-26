/**
 * Helpers for pairing provider-native thinking carriers (which hold the
 * signatures) with parser-derived thinking blocks (which hold the text).
 * See Membrane.mergeProviderThinkingBlocks for the pairing rules.
 */
import type { ContentBlock } from '../types/index.js';

/**
 * Anthropic validates a thinking block's signature against its text, so a
 * signature on text whose internal whitespace differs fails when the history
 * is sent back.
 */
export function sameThinkingText(left: string, right: string): boolean {
  if (left === right) return left !== '';
  if (left === '' || right === '') return false;
  const normalized = (text: string) => text.replace(/<\/?(antml:)?thinking>/g, '').trim();
  const normalizedLeft = normalized(left);
  if (normalizedLeft === '') return false;
  return normalizedLeft === normalized(right);
}

/**
 * Find a RUN of consecutive still-unpaired provider blocks whose concatenated
 * thinking reconstructs `parsedText` (an auto-continuation split across a
 * max_tokens boundary). Returns the provider indices in order, or undefined
 * when no run of two or more reconstructs it.
 *
 * Two joins are tried, because the round boundary itself is the one place a
 * fragment's whitespace can legitimately vanish: `buildContinuationRequest`
 * trimEnds the accumulation before re-prefilling, so the resumed text may
 * pick up exactly where the trim left off. Modelling that single
 * transformation keeps internal whitespace comparable everywhere else —
 * `sameThinkingText` treats it as payload.
 */
export function findSpanningProviderRun(
  providerThinking: Array<{ thinking?: string; signature?: string }>,
  pairedProviderBlocks: ReadonlySet<number>,
  parsedText: string
): number[] | undefined {
  for (let start = 0; start < providerThinking.length; start++) {
    if (pairedProviderBlocks.has(start)) continue;
    const firstFragment = providerThinking[start]!.thinking ?? '';
    let verbatimJoin = firstFragment;
    let trimmedJoin = firstFragment;
    const run = [start];
    for (let next = start + 1; next < providerThinking.length; next++) {
      if (pairedProviderBlocks.has(next)) break;
      const fragment = providerThinking[next]!.thinking ?? '';
      verbatimJoin += fragment;
      trimmedJoin = trimmedJoin.trimEnd() + fragment;
      run.push(next);
      if (sameThinkingText(verbatimJoin, parsedText) || sameThinkingText(trimmedJoin, parsedText)) {
        return [...run];
      }
    }
  }
  return undefined;
}

/**
 * Whether the API rejects thinking beside an assistant prefill is model
 * dependent: `claude-haiku-4-5-20251001` accepts an assistant prefill with
 * `thinking: {type: 'enabled'}` (and answers with no thinking block), while
 * `claude-sonnet-4-6` refuses assistant prefill outright with a 400, "This
 * model does not support assistant message prefill."
 */
export function stripThinkingForPrefill<T extends { thinking?: unknown; extra?: unknown }>(
  providerRequest: T
): T {
  delete providerRequest.thinking;
  const extra = providerRequest.extra;
  if (extra && typeof extra === 'object') {
    delete (extra as Record<string, unknown>).thinking;
  }
  return providerRequest;
}

/**
 * Anthropic's API refuses a thinking block with no signature
 * (antra-tess/membrane#191), and refuses another provider's reasoning, such as
 * Gemini's thought parts, under any signature it could be given. A
 * signature-only block, with empty thinking and a signature, is Anthropic's
 * own.
 */
export function isUnsignedThinking(block: unknown): boolean {
  const value = block as { type?: unknown; signature?: unknown } | null | undefined;
  return value?.type === 'thinking' && !value.signature;
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
