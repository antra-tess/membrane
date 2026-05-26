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
 * net: every formatter funnels through `normalizeToolPairs` before its
 * output is shipped, so producer-side bugs cannot leak the same 400 family
 * (compression-bug 5/6/7/8/9, agent-framework #37, 2026-05-22 miner stall).
 *
 * Algorithm overview (eight phases): reclassify blocks by required role,
 * reflow into role-correct envelopes, hoist matching tool_results across
 * the assistant→user boundary, evict interlopers wedged between use and
 * result, synthesize `[pending]` results for trailing orphans (or signal
 * not-ready when the id is in the caller-supplied pending set), drop
 * empty envelopes, prepend a synthetic `[continuing]` user envelope when
 * the first envelope ended up assistant-role, validate.
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
  // Phase 5.5: suppress cache_control on/after any envelope containing
  // a synthetic block, so cache keys don't get invalidated when the
  // real result arrives in a later round.
  //
  // The suppression itself happens here (we know which envelope is the
  // first synthetic by its position in the current array), but the
  // `cache_suppressed_for_synthetic` telemetry is deferred until after
  // phase 6 (which can drop empty envelopes before the synthetic) and
  // phase 7 (which can prepend a `[continuing]` envelope, shifting
  // everything by +1). The event's `envelopeIndex` must refer to the
  // final output array so consumers can index back into it reliably.
  // We pin the envelope by reference and recompute the index after
  // those phases settle.
  // ---------------------------------------------------------------------
  let pendingCacheSuppressionRef: Envelope | null = null;
  if (orphanRes.firstSyntheticEnvelope !== null) {
    const ref = envelopes[orphanRes.firstSyntheticEnvelope]!;
    const suppressed = suppressCacheControlFrom(envelopes, orphanRes.firstSyntheticEnvelope);
    if (suppressed) {
      pendingCacheSuppressionRef = ref;
    }
  }

  // ---------------------------------------------------------------------
  // Phase 6: drop empty envelopes (can arise from phase 4 dropping or
  // phase 3 hoisting). We deliberately do NOT merge consecutive
  // same-role envelopes here — that's the formatter's job.
  //
  // The synthetic-bearing envelope (held by `pendingCacheSuppressionRef`)
  // cannot be dropped here — phase 5 unshifts its synthetic block onto
  // that envelope's content, so it's guaranteed non-empty.
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
  // Deferred phase 5.5 telemetry: emit `cache_suppressed_for_synthetic`
  // now that index-mutating phases (6, 7) have settled. The envelope
  // reference pinned in phase 5.5 survives both — phase 6 can't drop it
  // (the synthetic block keeps it non-empty), and phase 7 either leaves
  // it in place or shifts it by +1 via unshift.
  // ---------------------------------------------------------------------
  if (pendingCacheSuppressionRef !== null) {
    const envelopeIndex = envelopes.indexOf(pendingCacheSuppressionRef);
    // Assertion: indexOf must succeed. Phases 6 and 7 only filter/prepend;
    // neither can remove an envelope holding a synthetic block.
    if (envelopeIndex < 0) {
      throw new MembraneNormalizerError(
        `Phase 5.5 envelope reference vanished between phase 6 and phase 7 — ` +
          `internal bug: synthetic-bearing envelope should be reachable after both phases.`,
        input.map(cloneMsg),
        envelopes.map(toProviderMessage),
      );
    }
    onEvent({ kind: 'cache_suppressed_for_synthetic', envelopeIndex });
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
  switch (block.type) {
    case 'tool_use':
    case 'thinking':
    case 'redacted_thinking':
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
      // Defensive: provider message with non-array content (e.g. a plain
      // string). Treat it as a single text block under the message's
      // declared role.
      const role = msg.role;
      if (current === null || current.role !== role) {
        if (current) out.push(current);
        current = { role, content: [] };
      }
      current.content.push({ type: 'text', text: String(msg.content ?? '') });
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

      if (current === null || current.role !== targetRole) {
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
  firstSyntheticEnvelope: number | null;
}

function resolveOrphans(
  envelopes: Envelope[],
  pending: ReadonlySet<string>,
  onEvent: (e: NormalizeEvent) => void,
): OrphanResolution {
  let ready = true;
  let firstSyntheticEnvelope: number | null = null;

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
        const inner = (block as { content?: unknown }).content;
        const innerText = typeof inner === 'string' ? inner : '';
        onEvent({ kind: 'orphan_tool_result_textified', toolUseId: id ?? '<missing>' });
        return {
          type: 'text',
          text: `[orphan tool_result for ${id ?? '<missing>'}]: ${innerText}`,
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

    for (const useId of useIds) {
      if (presentIds.has(useId)) continue;
      if (pending.has(useId)) {
        ready = false;
        onEvent({ kind: 'pending_in_flight', toolUseId: useId });
        continue;
      }
      const synth = syntheticToolResult(useId);
      // Place at the front so it's adjacent to the tool_use.
      nextEnv.content.unshift(synth);
      presentIds.add(useId);
      if (firstSyntheticEnvelope === null) firstSyntheticEnvelope = nextIdx;
      onEvent({
        kind: 'synthetic_pending_result',
        toolUseId: useId,
        reason: isTrailing ? 'trailing' : 'mid_stream',
      });
    }
  }

  return { envelopes, ready, firstSyntheticEnvelope };
}

function suppressCacheControlFrom(
  envelopes: Envelope[],
  startIndex: number,
): boolean {
  // Strip cache_control from blocks at-or-after startIndex. We must NOT
  // mutate the caller's input blocks (envelopes share references with
  // the input via rebuildEnvelopes), so clone-on-write: replace any
  // block carrying cache_control with a shallow copy that omits it.
  // The envelope's content array is replaced wholesale via .map; this
  // is the only place in the normalizer that creates new block objects
  // out of existing ones (synthetics aside).
  //
  // Returns whether any block was actually suppressed, so the caller
  // can decide whether to emit telemetry. Emission is deferred until
  // after phases 6 and 7 settle the final envelope ordering.
  let suppressed = false;
  for (let i = startIndex; i < envelopes.length; i++) {
    const env = envelopes[i]!;
    env.content = env.content.map((block) => {
      if (!('cache_control' in block)) return block;
      suppressed = true;
      const { cache_control: _drop, ...rest } = block as ProviderBlock & {
        cache_control?: unknown;
      };
      return rest as ProviderBlock;
    });
  }
  return suppressed;
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
