/**
 * Tool-Pair Normalizer
 *
 * Anthropic's API enforces structural rules on tool cycles that any of
 * Membrane's upstreams can accidentally violate:
 *
 *   - `tool_use` blocks must live in assistant-role messages.
 *   - `tool_result` blocks must live in user-role messages.
 *   - Every `tool_use` must be matched by its `tool_result` in the very
 *     next user-role message.
 *   - `thinking` blocks must live in assistant turns.
 *
 * When these are violated, the API returns 400 (e.g. `tool_use blocks can
 * only be in assistant messages`). This module is the wire-boundary safety
 * net for the paths that reach it, so producer-side bugs cannot leak the
 * same 400 family (compression-bug 5/6/7/8/9, agent-framework #37,
 * 2026-05-22 miner stall).
 *
 * COVERAGE — what actually funnels through `normalizeToolPairs`. This
 * header used to claim "every formatter", which was false, and a false
 * safety claim is worse than a known gap because it is the thing that
 * stops anyone from looking. There are four formatters; ONE calls this
 * module, and the second caller is not a formatter at all:
 *
 *   - `NativeFormatter.buildMessages` — COVERED.
 *   - `Membrane.buildNativeToolRequest` — COVERED (the streaming-native
 *     tool loop; not a formatter, but it ships Anthropic-shaped blocks).
 *   - `AnthropicXmlFormatter`, `CompletionsFormatter` — NOT covered, and
 *     they do not need to be: both emit flattened text documents with no
 *     structural tool blocks, so tool-cycle placement rules have nothing
 *     to bind to in their output.
 *   - `OpenAiResponsesFormatter` — NOT covered, and it DOES carry
 *     provider-native tool items (`function_call` / `function_call_output`),
 *     so it genuinely needs pairing discipline. The bypass is deliberate:
 *     membrane.ts routes this formatter around `buildNativeToolRequest`
 *     because that Anthropic-specific builder would normalize away item
 *     ids, encrypted reasoning, assistant phases and compaction items.
 *     That reasoning is sound, and it applies to this module too — the
 *     repair is NOT to call `normalizeToolPairs` on Responses items.
 *     FUTURE WORK: an items-level pairing pass for the Responses shape.
 *     Until it exists, that formatter's `ready: true` is a hardcoded
 *     literal, not a checked claim, and the one path carrying
 *     provider-native tool items has no net by construction.
 *
 * Algorithm overview (phases): refuse malformed input at entry (phase 0 —
 * non-set `pendingToolCallIds`, duplicate tool_use ids, non-array/
 * non-string content), reclassify blocks by required role, reflow into
 * role-correct envelopes, hoist matching tool_results across the
 * assistant→user boundary, sweep the converse direction so every
 * tool_result sits with its own tool_use, evict interlopers wedged
 * between use and result, synthesize `[pending]` results for orphans (or
 * signal not-ready when the id is in the caller-supplied pending set),
 * drop empty envelopes, prepend a synthetic `[continuing]` user envelope
 * when the first envelope ended up assistant-role, validate both
 * directions of the pairing rule.
 */

import type { ProviderMessage as LooseProviderMessage } from './types.js';
import type { NormalizeEvent } from './types.js';

// ============================================================================
// Public API
// ============================================================================

/**
 * Block shape used internally and exposed for callers that want to
 * build inputs without the full Anthropic SDK types. The required
 * `type` discriminator names the kind of block; any block whose `type`
 * matches a strict-role entry in `requiredRoleOf` is re-roled to its
 * required role during normalization. Unrecognized `tool_*` or
 * `thinking*` types fall through as `inherit` — see the one-shot
 * warning below.
 */
export type ProviderBlock = Record<string, unknown> & { type: string };

export interface NormalizeOptions {
  /** See `BuildOptions.pendingToolCallIds`. */
  pendingToolCallIds?: ReadonlySet<string>;
  /** See `BuildOptions.onNormalize`. */
  onEvent?: (event: NormalizeEvent) => void;
}

export interface NormalizeResult {
  /**
   * Normalized messages, structurally compatible with the loose
   * `ProviderMessage` from `./types.js`. Block contents are
   * `ProviderBlock[]` at runtime; the loose type is preserved at the
   * public boundary so callers wired against `./types.js` don't need
   * to cast.
   */
  messages: LooseProviderMessage[];
  /**
   * `false` iff a trailing unmatched tool_use's id was in
   * `pendingToolCallIds`. Caller should wait for the in-flight result
   * to land and retry instead of shipping the request.
   */
  ready: boolean;
}

export class MembraneNormalizerError extends Error {
  constructor(
    message: string,
    public readonly input: ReadonlyArray<LooseProviderMessage>,
    public readonly output: ReadonlyArray<LooseProviderMessage>,
  ) {
    super(message);
    this.name = 'MembraneNormalizerError';
  }
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Normalize a sequence of provider messages so the output is API-valid
 * with respect to Anthropic's tool-cycle structural rules.
 *
 * This function does NOT merge consecutive same-role envelopes — that
 * is the responsibility of `mergeConsecutiveRoles` (exported below). Run
 * the two together at every wire boundary; splitting them keeps the
 * normalize step independently testable and lets callers preserve their
 * own cache-control / breakpoint logic between the two steps if needed.
 */
export function normalizeToolPairs(
  input: ReadonlyArray<LooseProviderMessage>,
  options: NormalizeOptions = {},
): NormalizeResult {
  // ---------------------------------------------------------------------
  // Phase 0: entry guards. Producer defects refuse HERE — typed, before any
  // phase has rebuilt an envelope — rather than surfacing later as a silent
  // mis-repair or an untyped mid-pipeline TypeError.
  // ---------------------------------------------------------------------
  assertPendingToolCallIdsIsSetLike(options.pendingToolCallIds, input);
  assertInputWellFormed(input);

  const pending = options.pendingToolCallIds ?? new Set<string>();
  const onEvent = options.onEvent ?? noop;

  // ---------------------------------------------------------------------
  // Phase 1 + 2: reclassify blocks by required role and reflow envelopes
  // ---------------------------------------------------------------------
  let envelopes = rebuildEnvelopes(input, onEvent);

  // ---------------------------------------------------------------------
  // Phase 3: pair tool_use → tool_result across assistant→user boundary
  // ---------------------------------------------------------------------
  envelopes = hoistMatchingResults(envelopes, onEvent);

  // ---------------------------------------------------------------------
  // Phase 3.5: the converse sweep. Phase 3 asks "does every tool_use have
  // its result in the next user envelope?"; nothing asked the mirror
  // question, so a tool_result whose tool_use is NOT in the immediately-
  // preceding assistant envelope passed every phase untouched — and phase
  // 3 itself creates one such shape by hoisting a matching result into an
  // envelope that already holds a non-matching one.
  // ---------------------------------------------------------------------
  envelopes = repairStrayResults(envelopes, onEvent);

  // ---------------------------------------------------------------------
  // Phase 4: evict interlopers wedged between a tool_use and its result
  // ---------------------------------------------------------------------
  envelopes = evictInterlopers(envelopes, onEvent);

  // ---------------------------------------------------------------------
  // Phase 5: resolve orphans
  // ---------------------------------------------------------------------
  const orphanRes = resolveOrphans(envelopes, pending, onEvent);
  envelopes = orphanRes.envelopes;
  const ready = orphanRes.ready;

  // ---------------------------------------------------------------------
  // Phase 6: drop empty envelopes (can arise from phase 4 dropping or
  // phase 3 hoisting). We deliberately do NOT merge consecutive
  // same-role envelopes here — that's the formatter's job.
  // ---------------------------------------------------------------------
  envelopes = envelopes.filter((e) => e.content.length > 0);

  // ---------------------------------------------------------------------
  // Phase 7: ensure first envelope is user-role.
  //
  // Anthropic requires `messages[0].role === 'user'`. The leading
  // envelope can become assistant for two distinct reasons:
  //
  //   (a) Re-roling artifact — a strict-role block (thinking, tool_use)
  //       lived under a user-role input message and phase 1+2 moved it
  //       to a new leading assistant envelope. `originalFirstRole`
  //       is `'user'`.
  //
  //   (b) Producer bug — a context strategy genuinely selected an
  //       assistant message as the first message of its compiled view
  //       (the 2026-05-26 reviewer postmortem: PassthroughStrategy
  //       `selectFromEnd` cut on an assistant turn). `originalFirstRole`
  //       is `'assistant'`.
  //
  // Both cases get the same repair (prepend a `[continuing]` user
  // envelope) because deletion would lose content in case (a) — the
  // re-roled blocks are real conversation content the producer
  // expected to ship. The synthetic costs a leading cache miss
  // (deterministic literal, so idempotent across identical inputs)
  // but preserves API correctness and producer simplicity. We emit
  // a warn-level event so telemetry can distinguish the causes and
  // alert on (b) without coupling control flow to attribution.
  //
  // Idempotency: the synthetic content is a fixed literal. Running
  // normalize twice on the same input produces identical output the
  // second time (envelope[0] is user, gate doesn't fire).
  // ---------------------------------------------------------------------
  if (envelopes.length > 0 && envelopes[0]!.role === 'assistant') {
    // `input` is guaranteed non-empty here: rebuildEnvelopes only
    // produces envelopes when iterating input messages, so a non-empty
    // envelopes implies a non-empty input.
    const originalFirstRole = input[0]!.role;
    const leadingBlockTypes = envelopes[0]!.content.map((b) => b.type);
    envelopes.unshift({ role: 'user', content: [{ type: 'text', text: '[continuing]' }] });
    onEvent({ kind: 'leading_user_synthesized', originalFirstRole, leadingBlockTypes });
  }

  // ---------------------------------------------------------------------
  // Phase 8: validate. When `ready === false` we intentionally have
  // unmatched tool_uses — but ONLY the ones in `pending` are allowed to
  // remain unsynthesized. Any other gap is a bug in phase 5 and must
  // throw. The first-message-must-be-user branch should be unreachable
  // after phase 7; it remains as defense-in-depth against a future
  // phase introducing a leading assistant envelope without firing
  // phase 7.
  // ---------------------------------------------------------------------
  validate(envelopes, input, pending);

  return { messages: envelopes.map(toProviderMessage), ready };
}

// ============================================================================
// Phase 0: entry guards
// ============================================================================

/**
 * Render a runtime value's shape for a refusal message. Constructor names
 * beat `typeof` here — `object` tells a caller nothing, `Map` tells them
 * exactly which wrong container they reached for.
 */
function describeShape(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `Array(${value.length})`;
  const primitive = typeof value;
  if (primitive !== 'object') return primitive;
  return (value as { constructor?: { name?: string } }).constructor?.name ?? 'object';
}

/**
 * `pendingToolCallIds` is typed `ReadonlySet<string>` and consumed solely
 * through `.has(id)`. Both `.has()` sites are reached ONLY for a tool_use
 * with no matching result, so a wrong container (an array — the shape a
 * config round-trip through JSON produces, since a Set cannot survive one)
 * sails through every well-formed transcript and throws untyped, mid-
 * pipeline, the first time the safety net actually has repair work to do.
 *
 * Refuse at entry, unconditionally. Deliberately NOT `new Set(value)`:
 * coercing here would launder the caller's type error into behaviour that
 * happens to work, and the public type stays a membership set rather than
 * growing a permanent union plus an O(n) scan per unmatched id.
 */
function assertPendingToolCallIdsIsSetLike(
  value: ReadonlySet<string> | undefined,
  input: ReadonlyArray<LooseProviderMessage>,
): void {
  if (value === undefined) return;
  const membershipTest = (value as { has?: unknown } | null)?.has;
  if (typeof membershipTest === 'function') return;
  throw new MembraneNormalizerError(
    `normalizeToolPairs option 'pendingToolCallIds' must be a ReadonlySet<string> — ` +
      `the normalizer consults it with .has(id). Received ${describeShape(value)}. ` +
      `Build one at the call site with new Set(ids); the normalizer will not coerce, ` +
      `because a silent coercion here would hide the producer-side type error.`,
    input.map(cloneMsg),
    [],
  );
}

/**
 * Structural preconditions on the input message list.
 *
 * (a) Content must be a block array or a plain string. Anything else used
 *     to reach `String(msg.content ?? '')`, which puts the literal text
 *     `[object Object]` in front of the model — a poisoned turn that no
 *     downstream phase can detect or undo.
 *
 * (b) tool_use ids must be unique across the whole list. Phase 3 hoists the
 *     FIRST id match with no notion of which cycle it belongs to, so a
 *     reused id reattributes cycle N's real result to cycle 1's tool_use
 *     and leaves cycle N with a synthetic `[pending]`. The output is
 *     wire-valid and silently wrong, which is worse than a refusal. A
 *     duplicate id is always a producer defect: ids are minted per call.
 */
function assertInputWellFormed(input: ReadonlyArray<LooseProviderMessage>): void {
  const seenToolUseIds = new Set<string>();
  for (let i = 0; i < input.length; i++) {
    const msg = input[i]!;
    const content = msg.content;
    if (!Array.isArray(content)) {
      if (typeof content === 'string') continue;
      throw new MembraneNormalizerError(
        `Message ${i} (role '${msg.role}') has content of type ${describeShape(content)}; ` +
          `normalizeToolPairs accepts a block array or a plain string. Coercing this with ` +
          `String() would ship the literal text '[object Object]' to the model.`,
        input.map(cloneMsg),
        [],
      );
    }
    for (const block of content as ProviderBlock[]) {
      if (block?.type !== 'tool_use') continue;
      const id = (block as { id?: unknown }).id;
      if (typeof id !== 'string') continue;
      if (seenToolUseIds.has(id)) {
        throw new MembraneNormalizerError(
          `Duplicate tool_use id '${id}' (seen again in message ${i}). Tool-use ids must be ` +
            `unique across the message list: phase 3 pairs a tool_result to the FIRST tool_use ` +
            `carrying its id, so a reused id silently reattributes one cycle's real result to ` +
            `another cycle and leaves the second with a synthetic '[pending]'. Always a ` +
            `producer defect — mint a fresh id per call.`,
          input.map(cloneMsg),
          [],
        );
      }
      seenToolUseIds.add(id);
    }
  }
}

// ============================================================================
// Phase implementations
// ============================================================================

interface Envelope {
  role: 'user' | 'assistant';
  content: ProviderBlock[];
}

type RequiredRole = 'user' | 'assistant' | 'inherit';

/**
 * Role-strict block types. Extending Anthropic's tool surface
 * (e.g. `server_tool_use`, `web_search_tool_result`, `computer_use`)
 * means adding entries here. Unknown block types whose `type` starts
 * with `tool_` or `thinking` fall through to 'inherit' and trigger a
 * one-shot console warning so the next addition doesn't sail silently
 * through the safety net.
 */
function requiredRoleOf(block: ProviderBlock): RequiredRole {
  if (isStrictReasoningBlock(block)) return 'assistant';
  switch (block.type) {
    case 'tool_use':
      return 'assistant';
    case 'tool_result':
      return 'user';
    default:
      if (block.type.startsWith('tool_') || block.type.startsWith('thinking')) {
        warnUnknownStrictType(block.type);
      }
      return 'inherit';
  }
}

/**
 * The reasoning block types Anthropic pins to the assistant role, listed
 * once so {@link requiredRoleOf} and the weld guard in
 * {@link rebuildEnvelopes} cannot drift apart. Membership is exact, not
 * prefix-based: `redacted_thinking` does not start with `thinking`, and a
 * `startsWith` test here silently exempted the one variant whose payload is
 * opaque — a misattributed one cannot even be read back out of the
 * transcript. Any unknown `thinking`-prefixed type is 'inherit' (see the
 * default branch), so it never reaches the guard at all.
 */
const STRICT_REASONING_BLOCK_TYPES: ReadonlySet<string> = new Set([
  'thinking',
  'redacted_thinking',
]);

function isStrictReasoningBlock(block: ProviderBlock): boolean {
  return STRICT_REASONING_BLOCK_TYPES.has(block.type);
}

const _warnedTypes = new Set<string>();
function warnUnknownStrictType(blockType: string): void {
  if (_warnedTypes.has(blockType)) return;
  _warnedTypes.add(blockType);
  // eslint-disable-next-line no-console
  console.warn(
    `[membrane:normalize-tool-pairs] Unknown strict-role block type '${blockType}' — ` +
      `falling through as 'inherit'. If this type has role placement rules at the API, ` +
      `add it to requiredRoleOf in normalize-tool-pairs.ts.`,
  );
}

function rebuildEnvelopes(
  input: ReadonlyArray<LooseProviderMessage>,
  onEvent: (e: NormalizeEvent) => void,
): Envelope[] {
  const out: Envelope[] = [];
  let current: Envelope | null = null;

  for (const msg of input) {
    if (!Array.isArray(msg.content)) {
      // Provider message with plain-string content. Treat it as a single
      // text block under the message's declared role. The phase-0 guard
      // (assertInputWellFormed) has already refused every other non-array
      // shape, so no coercion is needed or wanted here.
      const role = msg.role;
      if (current === null || current.role !== role) {
        if (current) out.push(current);
        current = { role, content: [] };
      }
      current.content.push({ type: 'text', text: msg.content as string });
      continue;
    }

    for (const block of msg.content as ProviderBlock[]) {
      const req = requiredRoleOf(block);
      const targetRole: 'user' | 'assistant' = req === 'inherit' ? msg.role : req;

      if (req !== 'inherit' && req !== msg.role) {
        onEvent({
          kind: 'block_re_roled',
          blockType: block.type,
          from: msg.role,
          to: req,
        });
      }

      // A re-roled reasoning block must not join a turn that has already
      // called a tool. Opening on role change alone put a thinking block
      // from message N — signature and all — inside message N-1's turn,
      // AFTER its tool_use: content attributed to the wrong turn, and
      // signed reasoning claiming to belong to a cycle it did not produce.
      // This is a content-correctness repair, NOT 400-prevention: measured
      // live on 2026-08-25 (claude-haiku-4-5, and sonnet-4-6 independently),
      // replaying a genuinely signed thinking block positioned after its
      // tool_use returns 200, exactly as the correctly-ordered control does.
      // Re-measured the same day for redacted_thinking (a real block from the
      // documented magic-string trigger, claude-haiku-4-5): welded 200,
      // control 200 — same verdict, so both variants move for attribution.
      // types/tools.ts:100 still asserts this shape "fails API validation" —
      // that claim is stale.
      // Phase 3 guarantees a user envelope after any tool_use-bearing
      // assistant envelope, so the fresh envelope opened here cannot be
      // concatenated back by the mergeConsecutiveRoles that follows.
      const wouldWeldReasoningPastToolUse =
        req === 'assistant' &&
        req !== msg.role &&
        isStrictReasoningBlock(block) &&
        current !== null &&
        current.role === 'assistant' &&
        current.content.some((held) => held.type === 'tool_use');

      if (current === null || current.role !== targetRole || wouldWeldReasoningPastToolUse) {
        if (current) out.push(current);
        current = { role: targetRole, content: [] };
      }
      current.content.push(block);
    }
  }

  if (current) out.push(current);
  return out;
}

function hoistMatchingResults(
  envelopes: Envelope[],
  onEvent: (e: NormalizeEvent) => void,
): Envelope[] {
  // For every assistant envelope, ensure its tool_use ids have matching
  // tool_results in the immediately-following user envelope. If a
  // matching tool_result lives further downstream, hoist it forward.
  for (let i = 0; i < envelopes.length; i++) {
    const env = envelopes[i]!;
    if (env.role !== 'assistant') continue;
    const useIds = collectToolUseIds(env);
    if (useIds.length === 0) continue;

    // Ensure there is a user envelope at i+1. If not, insert an empty one.
    let nextIdx = i + 1;
    if (nextIdx >= envelopes.length || envelopes[nextIdx]!.role !== 'user') {
      envelopes.splice(nextIdx, 0, { role: 'user', content: [] });
    }
    const nextEnv = envelopes[nextIdx]!;
    const presentIds = new Set(
      nextEnv.content
        .filter((b) => b.type === 'tool_result')
        .map(getToolUseId)
        .filter((id): id is string => typeof id === 'string'),
    );

    for (const useId of useIds) {
      if (presentIds.has(useId)) continue;

      // Search downstream envelopes for this id; hoist the first match.
      const found = removeFirstMatchingResult(envelopes, nextIdx + 1, useId);
      if (found) {
        // Place the hoisted result at the front of nextEnv to keep
        // tool_results adjacent to (and before) any interloping content
        // already present.
        nextEnv.content.unshift(found.block);
        presentIds.add(useId);
        onEvent({
          kind: 'tool_result_hoisted',
          toolUseId: useId,
          fromEnvelope: found.fromEnvelope,
          toEnvelope: nextIdx,
        });
      }
      // If not found downstream, leave it — phase 5 will synthesize.
    }
  }
  return envelopes;
}

/**
 * Enforce the converse of phase 3's rule: every tool_result must sit in the
 * user envelope immediately following the assistant envelope that holds its
 * tool_use. Three reachable shapes reach here unpaired:
 *
 *   A. out-of-order append — the result was written before its own cycle;
 *   B. leading result — the window cut left it with no preceding envelope;
 *   C. duplicate re-append — the same result arrives again after a later
 *      turn (the module's doc names cancellations and stream restarts).
 *
 * A and B are RELOCATED into their own cycle's user envelope, which keeps
 * the real payload as a tool_result and stops phase 5 from synthesizing a
 * `[pending]` over a result that actually landed. C cannot be relocated
 * without displacing the real result, so it is textified — content
 * preserved, structure dropped. A result whose id appears nowhere is left
 * alone here; phase 5's orphan pass owns that case.
 */
function repairStrayResults(
  envelopes: Envelope[],
  onEvent: (e: NormalizeEvent) => void,
): Envelope[] {
  const useEnvelopeOfId = new Map<string, number>();
  for (let i = 0; i < envelopes.length; i++) {
    const env = envelopes[i]!;
    if (env.role !== 'assistant') continue;
    for (const id of collectToolUseIds(env)) useEnvelopeOfId.set(id, i);
  }
  if (useEnvelopeOfId.size === 0) return envelopes;

  for (let i = 0; i < envelopes.length; i++) {
    const env = envelopes[i]!;
    if (env.role !== 'user') continue;
    const previous = envelopes[i - 1];
    const idsPairedHere = new Set(
      previous?.role === 'assistant' ? collectToolUseIds(previous) : [],
    );

    const kept: ProviderBlock[] = [];
    for (const block of env.content) {
      if (block.type !== 'tool_result') {
        kept.push(block);
        continue;
      }
      const id = getToolUseId(block);
      if (typeof id !== 'string' || idsPairedHere.has(id)) {
        kept.push(block);
        continue;
      }
      const useEnvelope = useEnvelopeOfId.get(id);
      if (useEnvelope === undefined) {
        // Id appears nowhere — phase 5's orphan textification owns it.
        kept.push(block);
        continue;
      }

      const cycleEnvelope = envelopes[useEnvelope + 1];
      const cycleIsOpen =
        cycleEnvelope !== undefined &&
        cycleEnvelope.role === 'user' &&
        !cycleEnvelope.content.some(
          (b) => b.type === 'tool_result' && getToolUseId(b) === id,
        );

      if (cycleIsOpen) {
        cycleEnvelope!.content.unshift(block);
        onEvent({
          kind: 'tool_result_hoisted',
          toolUseId: id,
          fromEnvelope: i,
          toEnvelope: useEnvelope + 1,
        });
        continue;
      }

      const recovered = renderResultContent(block);
      onEvent({
        kind: 'stray_tool_result_textified',
        toolUseId: id,
        fromEnvelope: i,
        recoveredChars: recovered.length,
      });
      kept.push({ type: 'text', text: `[duplicate tool_result for ${id}]: ${recovered}` });
    }
    env.content = kept;
  }
  return envelopes;
}

function evictInterlopers(
  envelopes: Envelope[],
  onEvent: (e: NormalizeEvent) => void,
): Envelope[] {
  // For every assistant envelope ending with a tool_use, the
  // immediately-following user envelope's tool_results should appear
  // BEFORE any interloping text/image/etc. — otherwise the agent's
  // forward timeline reads "tool called, then [unrelated event], then
  // tool result." Phase 3 already places hoisted results at the front,
  // but locally-present results may sit after text in the same envelope
  // (e.g. user sent a chat message and the tool_result is appended
  // afterward by the producer). We always defer interlopers — never
  // drop — so that a mid-cycle user event isn't lost to the agent's
  // long-term memory after the chunk gets summarized. A summarizer LLM
  // can tolerate slight temporal reordering; it cannot reconstruct a
  // message that was discarded.
  for (let i = 0; i < envelopes.length; i++) {
    const env = envelopes[i]!;
    if (env.role !== 'assistant') continue;
    const useIds = new Set(collectToolUseIds(env));
    if (useIds.size === 0) continue;
    const next = envelopes[i + 1];
    if (!next || next.role !== 'user') continue;

    const matching: ProviderBlock[] = [];
    const interlopers: ProviderBlock[] = [];
    const rest: ProviderBlock[] = [];

    let seenMatching = false;
    for (const block of next.content) {
      const isResult = block.type === 'tool_result';
      const resultId = isResult ? getToolUseId(block) : undefined;
      const isMatching = isResult && typeof resultId === 'string' && useIds.has(resultId);

      if (isMatching) {
        matching.push(block);
        seenMatching = true;
      } else if (!seenMatching && !isResult) {
        // Block precedes the first matching tool_result. Treat as
        // interloper only if it would sit between the assistant's
        // tool_use and its result.
        interlopers.push(block);
      } else {
        rest.push(block);
      }
    }

    if (interlopers.length === 0) continue;

    for (const block of interlopers) {
      onEvent({
        kind: 'interloper_deferred',
        blockType: block.type,
        fromEnvelope: i + 1,
      });
    }
    next.content = [...matching, ...interlopers, ...rest];
  }
  return envelopes;
}

interface OrphanResolution {
  envelopes: Envelope[];
  ready: boolean;
}

function resolveOrphans(
  envelopes: Envelope[],
  pending: ReadonlySet<string>,
  onEvent: (e: NormalizeEvent) => void,
): OrphanResolution {
  let ready = true;

  // First pass: textify any tool_result whose tool_use never appeared
  // anywhere in the message list (orphan result).
  const allUseIds = new Set<string>();
  for (const env of envelopes) {
    for (const block of env.content) {
      if (block.type === 'tool_use') {
        const id = (block as { id?: string }).id;
        if (typeof id === 'string') allUseIds.add(id);
      }
    }
  }
  for (const env of envelopes) {
    if (env.role !== 'user') continue;
    env.content = env.content.map((block) => {
      if (block.type !== 'tool_result') return block;
      const id = getToolUseId(block);
      if (typeof id !== 'string' || !allUseIds.has(id)) {
        const recovered = renderResultContent(block);
        onEvent({
          kind: 'orphan_tool_result_textified',
          toolUseId: id ?? '<missing>',
          recoveredChars: recovered.length,
        });
        return {
          type: 'text',
          text: `[orphan tool_result for ${id ?? '<missing>'}]: ${recovered}`,
        };
      }
      return block;
    });
  }

  // Second pass: for each assistant envelope, every tool_use must have
  // a matching tool_result in the immediately-following user envelope.
  // If pending, signal not-ready. Else, synthesize.
  for (let i = 0; i < envelopes.length; i++) {
    const env = envelopes[i]!;
    if (env.role !== 'assistant') continue;
    const useIds = collectToolUseIds(env);
    if (useIds.length === 0) continue;

    let nextIdx = i + 1;
    if (nextIdx >= envelopes.length || envelopes[nextIdx]!.role !== 'user') {
      envelopes.splice(nextIdx, 0, { role: 'user', content: [] });
    }
    const nextEnv = envelopes[nextIdx]!;
    // 'trailing' iff after the next user envelope there are no further
    // envelopes AND the next envelope is empty (so it exists only to
    // receive our synthetic). This must be computed *after* the splice
    // because phase 3 may have already inserted an empty user envelope
    // earlier in the pipeline.
    const isTrailing =
      nextIdx + 1 >= envelopes.length && nextEnv.content.length === 0;
    const presentIds = new Set(
      nextEnv.content
        .filter((b) => b.type === 'tool_result')
        .map(getToolUseId)
        .filter((id): id is string => typeof id === 'string'),
    );

    for (let useIdIndex = 0; useIdIndex < useIds.length; useIdIndex++) {
      const useId = useIds[useIdIndex]!;
      if (presentIds.has(useId)) continue;
      if (pending.has(useId)) {
        ready = false;
        onEvent({ kind: 'pending_in_flight', toolUseId: useId });
        continue;
      }
      const synth = syntheticToolResult(useId);
      // Place the synthetic at its own call's position. Unshifting to the
      // front put a [pending] for call #2 ahead of the REAL result of call
      // #1: wire-valid, but the model then reads results in an order that
      // does not match the order it made the calls.
      nextEnv.content.splice(syntheticInsertionIndex(nextEnv, useIds, useIdIndex), 0, synth);
      presentIds.add(useId);
      onEvent({
        kind: 'synthetic_pending_result',
        toolUseId: useId,
        reason: isTrailing ? 'trailing' : 'mid_stream',
      });
    }
  }

  return { envelopes, ready };
}

/**
 * Where a synthetic result for `useIds[useIdIndex]` belongs in the cycle's
 * user envelope: immediately after the result of the nearest earlier call
 * that already landed, or at the front when no earlier call has one. Because
 * synthesis walks `useIds` in call order and each insertion is visible to the
 * next lookup, the envelope's tool_results end up ordered by call order.
 */
function syntheticInsertionIndex(
  envelope: Envelope,
  useIds: ReadonlyArray<string>,
  useIdIndex: number,
): number {
  for (let earlier = useIdIndex - 1; earlier >= 0; earlier--) {
    const earlierId = useIds[earlier]!;
    const at = envelope.content.findIndex(
      (block) => block.type === 'tool_result' && getToolUseId(block) === earlierId,
    );
    if (at >= 0) return at + 1;
  }
  return 0;
}

function validate(
  envelopes: Envelope[],
  input: ReadonlyArray<LooseProviderMessage>,
  pending: ReadonlySet<string>,
): void {
  // Empty input → empty output is fine.
  if (envelopes.length === 0) return;

  // First message must be user (Anthropic requirement). We try to
  // repair this in the caller; if it still isn't user here, fail.
  if (envelopes[0]!.role !== 'user') {
    throw new MembraneNormalizerError(
      `First message must have role 'user', got '${envelopes[0]!.role}'. ` +
        `Repair (prepending '[continuing]') did not engage — internal bug.`,
      input.map(cloneMsg),
      envelopes.map(toProviderMessage),
    );
  }

  // Every tool_use in an assistant envelope must have a matching
  // tool_result in the immediately-following user envelope — except
  // tool_uses whose id is in `pending` (the in-flight set the caller
  // declared off-limits for synthesis). A gap on any other id is a
  // phase-5 bug and must throw.
  for (let i = 0; i < envelopes.length; i++) {
    const env = envelopes[i]!;
    if (env.role !== 'assistant') continue;
    const useIds = collectToolUseIds(env);
    if (useIds.length === 0) continue;
    const next = envelopes[i + 1];
    const presentIds = new Set(
      next?.role === 'user'
        ? next.content
            .filter((b) => b.type === 'tool_result')
            .map(getToolUseId)
            .filter((id): id is string => typeof id === 'string')
        : [],
    );
    for (const useId of useIds) {
      if (presentIds.has(useId)) continue;
      if (pending.has(useId)) continue; // legitimately in-flight
      throw new MembraneNormalizerError(
        `tool_use id='${useId}' in envelope ${i} has no matching tool_result in envelope ${i + 1}, ` +
          `and the id is not in pendingToolCallIds. This indicates a bug in the normalizer itself — ` +
          `phase 5 should have synthesized a result for any non-pending unmatched id.`,
        input.map(cloneMsg),
        envelopes.map(toProviderMessage),
      );
    }
  }

  // The mirror of the loop above. Anthropic's rule binds in both directions,
  // and for years only the forward half was checked — so an unpaired
  // tool_result (out-of-order append, leading result, duplicate re-append)
  // passed every phase AND this validation on its way to a 400. Phase 3.5
  // repairs all three shapes; this asserts the repair actually held.
  for (let i = 0; i < envelopes.length; i++) {
    const env = envelopes[i]!;
    if (env.role !== 'user') continue;
    const previous = envelopes[i - 1];
    const availableUseIds = new Set(
      previous?.role === 'assistant' ? collectToolUseIds(previous) : [],
    );
    for (const block of env.content) {
      if (block.type !== 'tool_result') continue;
      const resultId = getToolUseId(block);
      if (typeof resultId === 'string' && availableUseIds.has(resultId)) continue;
      throw new MembraneNormalizerError(
        `tool_result for id='${resultId ?? '<missing>'}' in envelope ${i} has no matching ` +
          `tool_use in envelope ${i - 1}. Anthropic requires each tool_result to follow its ` +
          `tool_use immediately; this is a bug in the normalizer itself — phase 3.5 should have ` +
          `relocated or textified any stray result.`,
        input.map(cloneMsg),
        envelopes.map(toProviderMessage),
      );
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Read a tool_result's id, tolerating either Anthropic's canonical
 * `tool_use_id` (snake_case) or the camelCase `toolUseId` some
 * Membrane producers ship. Only used for *reading*; synthetic
 * tool_results MUST be written in the canonical snake_case form
 * (see {@link syntheticToolResult}) — the dual-form read is defensive
 * against producers, not a license to mix.
 */
function getToolUseId(block: ProviderBlock): string | undefined {
  const b = block as { tool_use_id?: unknown; toolUseId?: unknown };
  if (typeof b.tool_use_id === 'string') return b.tool_use_id;
  if (typeof b.toolUseId === 'string') return b.toolUseId;
  return undefined;
}

/**
 * Flatten a tool_result's payload to text for the two repairs that must
 * abandon the tool_result structure (orphan and duplicate textification).
 *
 * `ToolResult.content` is `string | ToolResultContentBlock[]`, and the array
 * form is a first-class feature — image results ride it. The previous
 * recovery read only the string branch, so every array-shaped payload was
 * replaced by the empty string with no signal of the loss.
 *
 * This deliberately does not reuse `renderResultContentString` from
 * `utils/tool-parser.ts`: that helper takes an internal `ToolResult` whose
 * image blocks carry camelCase `mediaType`, while blocks arriving here are
 * provider-shaped and carry Anthropic's wire-form `media_type`. Reading both
 * spellings is the point; the placeholder text is kept identical so the two
 * renderings stay recognisable as the same thing to a model.
 */
function renderResultContent(block: ProviderBlock): string {
  const content = (block as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const part of content as ReadonlyArray<Record<string, unknown>>) {
    if (part?.type === 'text' && typeof part.text === 'string') {
      parts.push(part.text);
      continue;
    }
    if (part?.type === 'image') {
      const source = (part.source ?? {}) as { data?: unknown; media_type?: unknown; mediaType?: unknown };
      const mediaType =
        (typeof source.media_type === 'string' && source.media_type) ||
        (typeof source.mediaType === 'string' && source.mediaType) ||
        'unknown';
      const base64Length = typeof source.data === 'string' ? source.data.length : 0;
      const sizeKb = Math.round((base64Length * 0.75) / 1024);
      parts.push(`[Image: ${mediaType}, ~${sizeKb}KB]`);
      continue;
    }
    if (typeof part?.type === 'string') parts.push(`[${part.type}]`);
  }
  return parts.join('\n');
}

function collectToolUseIds(env: Envelope): string[] {
  const ids: string[] = [];
  for (const block of env.content) {
    if (block.type === 'tool_use') {
      const id = (block as { id?: string }).id;
      if (typeof id === 'string') ids.push(id);
    }
  }
  return ids;
}

function removeFirstMatchingResult(
  envelopes: Envelope[],
  fromIdx: number,
  useId: string,
): { block: ProviderBlock; fromEnvelope: number } | null {
  for (let i = fromIdx; i < envelopes.length; i++) {
    const env = envelopes[i]!;
    if (env.role !== 'user') continue;
    for (let j = 0; j < env.content.length; j++) {
      const block = env.content[j]!;
      if (block.type !== 'tool_result') continue;
      if (getToolUseId(block) === useId) {
        // Mutates the envelope's content array in place. Caller
        // (phase 3) is expected to handle the possibly-empty source
        // envelope; phase 6's filter sweeps any envelope left empty.
        env.content.splice(j, 1);
        return { block, fromEnvelope: i };
      }
    }
  }
  return null;
}

/**
 * Synthetic tool_result for an unmatched tool_use. Writes
 * `tool_use_id` in Anthropic's canonical snake_case form — do NOT
 * change to camelCase without auditing every consumer of the
 * downstream message. The "[pending]" content is intentionally
 * tombstone-shaped (is_error: false) — most synthesis triggers are
 * normal-flow gaps (cancellations, stream restarts), not failures
 * worth alarming the agent about.
 */
function syntheticToolResult(toolUseId: string): ProviderBlock {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: '[pending]',
    is_error: false,
  };
}

function toProviderMessage(env: Envelope): LooseProviderMessage {
  return { role: env.role, content: env.content };
}

function cloneMsg(msg: LooseProviderMessage): LooseProviderMessage {
  return {
    role: msg.role,
    content: Array.isArray(msg.content) ? [...msg.content] : msg.content,
  };
}

function noop(): void {
  /* intentionally empty */
}

/**
 * Merge consecutive same-role envelopes by concatenating their content
 * arrays. Anthropic's API requires strictly alternating user/assistant
 * roles, and `normalizeToolPairs` can leave adjacent same-role envelopes
 * (e.g. an assistant turn re-roled out of a user message, or two
 * assistant turns stranded by an upstream chunker that dropped the
 * tool_result message between them).
 *
 * This is the second half of the wire-boundary safety net and should run
 * AFTER `normalizeToolPairs` at every callsite that ships messages to
 * Anthropic. Hoisted here so both `NativeFormatter.buildMessages` and
 * `Membrane.buildNativeToolRequest` share one implementation.
 */
export function mergeConsecutiveRoles(
  messages: ReadonlyArray<LooseProviderMessage>,
): LooseProviderMessage[] {
  if (messages.length === 0) return [];

  const merged: LooseProviderMessage[] = [];
  let current: LooseProviderMessage = { ...messages[0]! };

  for (let i = 1; i < messages.length; i++) {
    const next = messages[i]!;
    if (next.role === current.role) {
      const currentContent = Array.isArray(current.content) ? current.content : [current.content];
      const nextContent = Array.isArray(next.content) ? next.content : [next.content];
      current = {
        role: current.role,
        content: [...currentContent, ...nextContent],
      };
    } else {
      merged.push(current);
      current = { ...next };
    }
  }
  merged.push(current);
  return merged;
}
