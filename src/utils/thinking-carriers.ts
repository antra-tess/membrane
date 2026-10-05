/**
 * Helpers for pairing provider-native thinking carriers (which hold the
 * signatures) with parser-derived thinking blocks (which hold the text).
 * See Membrane.mergeProviderThinkingBlocks for the pairing rules.
 */
import type { ContentBlock } from '../types/index.js';

/**
 * Identity for thinking text, insensitive to exactly two artifacts that ride
 * the parser's view of the same reasoning — and to nothing else:
 *
 *  - stream scaffolding: the XML path prefills `Claude: <thinking>` and asks
 *    the adapter to wrap native thinking deltas, so a parsed block can carry
 *    a literal `<thinking>` / `</thinking>` tag the provider block never had.
 *  - OUTER boundary whitespace: the continuation path trims the accumulation
 *    at each round boundary (`buildContinuationRequest` trimEnds before
 *    re-prefilling), so a fragment and the parsed text can differ by leading
 *    or trailing whitespace.
 *
 * INTERNAL whitespace is payload and is compared verbatim. Erasing it (the
 * first implementation stripped every `\s`) makes distinct signed payloads
 * collide on nothing but where their spaces fall, and the caller then stamps
 * one payload's signature onto the other's text — a carrier that fails
 * Anthropic signature validation when the consumer ships its history back.
 *
 * Comparison only — stored text is never rewritten. Empty text is never
 * identical to anything: signature-only carriers are prepend-only.
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
 * Drop the extended-thinking config from a prefill-shaped provider request —
 * from BOTH channels the `thinkingEnabled` resolver reads.
 *
 * Whether the API rejects thinking beside an assistant prefill is MODEL
 * DEPENDENT, not a universal law. Measured live 2026-08-25 against the
 * Anthropic Messages API: `claude-haiku-4-5-20251001` accepts an assistant
 * prefill together with `thinking: {type: 'enabled'}` (HTTP 200, and the
 * response carries no thinking block), while `claude-sonnet-4-6` refuses
 * assistant prefill outright — HTTP 400, "This model does not support
 * assistant message prefill."
 *
 * So the strip is the prefill path's DESIGN wherever prefill works: the XML
 * formatter uses the thinking config to emit a literal `<thinking>` text
 * prefix rather than the API feature, and sending both pays for API thinking
 * the prefill format does not consume. On models that reject the combination
 * it is additionally the 400 guard it always was. Either way both channels
 * must agree, and the guard that only deleted the top-level field left
 * `extra.thinking` (spread from `providerParams`) riding the adapter's
 * `Object.assign(params, rest)` onto the wire — reproducing both the 400 and
 * the interleaved-thinking beta header, since the resolver correctly saw the
 * smuggled config. Mutates and returns the request; callers must own `extra`
 * (never alias the caller's `providerParams`).
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
