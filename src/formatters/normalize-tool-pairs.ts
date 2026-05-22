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
 * Companion design doc: `membrane/docs/normalize-tool-pairs-plan.md`.
 */

import type { NormalizeEvent } from './types.js';

// ============================================================================
// Public API
// ============================================================================

export type ProviderBlock = Record<string, unknown> & { type: string };

export interface ProviderMessage {
  role: 'user' | 'assistant';
  content: ProviderBlock[];
}

export interface NormalizeOptions {
  /** See `BuildOptions.pendingToolCallIds`. */
  pendingToolCallIds?: ReadonlySet<string>;
  /** See `BuildOptions.normalizationPolicy`. Default: 'live'. */
  policy?: 'live' | 'compression';
  /** See `BuildOptions.onNormalize`. */
  onEvent?: (event: NormalizeEvent) => void;
}

export interface NormalizeResult {
  messages: ProviderMessage[];
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
    public readonly input: ProviderMessage[],
    public readonly output: ProviderMessage[],
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
 * remains the caller's responsibility (NativeFormatter.mergeConsecutiveRoles)
 * so existing cache-control / breakpoint logic continues to work.
 */
export function normalizeToolPairs(
  input: ReadonlyArray<ProviderMessage>,
  options: NormalizeOptions = {},
): NormalizeResult {
  const pending = options.pendingToolCallIds ?? new Set<string>();
  const policy = options.policy ?? 'live';
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
  envelopes = evictInterlopers(envelopes, policy, onEvent);

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
  // ---------------------------------------------------------------------
  if (orphanRes.firstSyntheticEnvelope !== null) {
    suppressCacheControlFrom(envelopes, orphanRes.firstSyntheticEnvelope, onEvent);
  }

  // ---------------------------------------------------------------------
  // Phase 6: drop empty envelopes (can arise from phase 4 dropping or
  // phase 3 hoisting), repair first-message-must-be-user, validate. We
  // deliberately do NOT merge consecutive same-role envelopes here —
  // that's the formatter's job.
  // ---------------------------------------------------------------------
  envelopes = envelopes.filter((e) => e.content.length > 0);

  // First-message-must-be-user repair: only repair the case where the
  // original input's first message WAS user, but re-roling moved blocks
  // to a leading assistant envelope (e.g. misplaced thinking block).
  // If the producer genuinely shipped an assistant-first conversation,
  // that's a real bug and validate() will throw.
  const originalFirstRole = input.length > 0 ? input[0]!.role : 'user';
  if (
    envelopes.length > 0 &&
    envelopes[0]!.role === 'assistant' &&
    originalFirstRole === 'user'
  ) {
    envelopes.unshift({ role: 'user', content: [{ type: 'text', text: '[continuing]' }] });
  }

  // Validate. When `ready === false` we intentionally have an unmatched
  // tool_use (the in-flight one), so we skip the use→result invariant.
  // Other invariants still apply.
  validate(envelopes, input, ready);

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

function requiredRoleOf(block: ProviderBlock): RequiredRole {
  switch (block.type) {
    case 'tool_use':
    case 'thinking':
    case 'redacted_thinking':
      return 'assistant';
    case 'tool_result':
      return 'user';
    default:
      return 'inherit';
  }
}

function rebuildEnvelopes(
  input: ReadonlyArray<ProviderMessage>,
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

    for (const block of msg.content) {
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
        .map((b) => (b as { tool_use_id?: string; toolUseId?: string }).tool_use_id ?? (b as { toolUseId?: string }).toolUseId)
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
  policy: 'live' | 'compression',
  onEvent: (e: NormalizeEvent) => void,
): Envelope[] {
  // For every assistant envelope ending with a tool_use, the
  // immediately-following user envelope's tool_results should appear
  // BEFORE any interloping text/image/etc. — otherwise the agent's
  // forward timeline reads "tool called, then [unrelated event], then
  // tool result." Phase 3 already places hoisted results at the front,
  // but locally-present results may sit after text in the same envelope
  // (e.g. user sent a chat message and the tool_result is appended
  // afterward by the producer).
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
      const resultId = isResult
        ? ((block as { tool_use_id?: string; toolUseId?: string }).tool_use_id
            ?? (block as { toolUseId?: string }).toolUseId)
        : undefined;
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

    if (policy === 'compression') {
      for (const block of interlopers) {
        onEvent({
          kind: 'interloper_dropped',
          blockType: block.type,
          fromEnvelope: i + 1,
        });
      }
      next.content = [...matching, ...rest];
    } else {
      // 'live': defer interlopers to after the matching tool_results.
      for (const block of interlopers) {
        onEvent({
          kind: 'interloper_deferred',
          blockType: block.type,
          fromEnvelope: i + 1,
        });
      }
      next.content = [...matching, ...interlopers, ...rest];
    }
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
      const id = (block as { tool_use_id?: string; toolUseId?: string }).tool_use_id
        ?? (block as { toolUseId?: string }).toolUseId;
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
        .map((b) => (b as { tool_use_id?: string; toolUseId?: string }).tool_use_id ?? (b as { toolUseId?: string }).toolUseId)
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
  onEvent: (e: NormalizeEvent) => void,
): void {
  let suppressed = false;
  for (let i = startIndex; i < envelopes.length; i++) {
    const env = envelopes[i]!;
    for (const block of env.content) {
      if ('cache_control' in block) {
        delete (block as Record<string, unknown>).cache_control;
        suppressed = true;
      }
    }
  }
  if (suppressed) {
    onEvent({ kind: 'cache_suppressed_for_synthetic', envelopeIndex: startIndex });
  }
}

function validate(
  envelopes: Envelope[],
  input: ReadonlyArray<ProviderMessage>,
  ready: boolean,
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

  // When ready=false, an unmatched trailing tool_use is intentional
  // (the in-flight one). Skip the use→result invariant in that case.
  if (!ready) return;

  // Every tool_use in an assistant envelope must have a matching
  // tool_result in the immediately-following user envelope.
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
            .map((b) => (b as { tool_use_id?: string; toolUseId?: string }).tool_use_id ?? (b as { toolUseId?: string }).toolUseId)
            .filter((id): id is string => typeof id === 'string')
        : [],
    );
    for (const useId of useIds) {
      if (!presentIds.has(useId)) {
        throw new MembraneNormalizerError(
          `tool_use id='${useId}' in envelope ${i} has no matching tool_result in envelope ${i + 1}. ` +
            `This indicates a bug in the normalizer itself — phase 5 should have synthesized one ` +
            `unless the id was marked pending (in which case ready=false should have been returned).`,
          input.map(cloneMsg),
          envelopes.map(toProviderMessage),
        );
      }
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

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
      const id = (block as { tool_use_id?: string; toolUseId?: string }).tool_use_id
        ?? (block as { toolUseId?: string }).toolUseId;
      if (id === useId) {
        env.content.splice(j, 1);
        return { block, fromEnvelope: i };
      }
    }
  }
  return null;
}

function syntheticToolResult(toolUseId: string): ProviderBlock {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: '[pending]',
    is_error: false,
  };
}

function toProviderMessage(env: Envelope): ProviderMessage {
  return { role: env.role, content: env.content };
}

function cloneMsg(msg: ProviderMessage): ProviderMessage {
  return {
    role: msg.role,
    content: Array.isArray(msg.content) ? [...msg.content] : msg.content,
  };
}

function noop(): void {
  /* intentionally empty */
}
