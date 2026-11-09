/**
 * Anthropic's API enforces structural rules on tool cycles, and returns 400
 * when one is broken (e.g. `tool_use blocks can only be in assistant
 * messages`):
 *
 *   - `tool_use` blocks must live in assistant-role messages.
 *   - `tool_result` blocks must live in user-role messages.
 *   - Every `tool_use` must be matched by its `tool_result` in the very
 *     next user-role message.
 *   - `thinking` blocks must live in assistant turns.
 *
 * A tool_result answers the nearest tool_use with its id before it, and the
 * API accepts an id reused across turns.
 */

import type { ProviderTurnMessage as LooseProviderMessage } from './types.js';
import type { NormalizeEvent } from './types.js';
import { MembraneError } from '../types/errors.js';
import { hasNonEmptyText } from '../utils/empty-text.js';

/**
 * Block shape used internally and exposed for callers that want to
 * build inputs without the full Anthropic SDK types. `type` names the kind
 * of block: `tool_use`, `thinking` and `redacted_thinking` blocks are moved
 * to an assistant envelope and `tool_result` blocks to a user envelope during
 * normalization; any other type stays with its message's role, and an
 * unknown `tool_*` or `thinking*` type warns once.
 */
export type ProviderBlock = Record<string, unknown> & { type: string };

const NORMALIZE_EVENT_REWRITES_PREFIX: Record<NormalizeEvent['kind'], boolean> = {
  block_re_roled: false,
  tool_result_hoisted: false,
  interloper_deferred: false,
  synthetic_pending_result: true,
  orphan_tool_result_dropped: true,
  stray_tool_result_dropped: true,
  pending_in_flight: false,
  leading_user_synthesized: false,
};

function deriveKindsThatRewritePrefix(): ReadonlySet<NormalizeEvent['kind']> {
  const kinds = Object.entries(NORMALIZE_EVENT_REWRITES_PREFIX)
    .filter(([, rewritesPrefix]) => rewritesPrefix)
    .map(([kind]) => kind as NormalizeEvent['kind']);
  return new Set(kinds);
}

export const PREFIX_REWRITING_NORMALIZE_EVENT_KINDS: ReadonlySet<NormalizeEvent['kind']> =
  deriveKindsThatRewritePrefix();

export interface NormalizeOptions {
  /** See `BuildOptions.pendingToolCallIds`. */
  pendingToolCallIds?: ReadonlySet<string>;
  /** See `BuildOptions.onNormalize`. */
  onEvent?: (event: NormalizeEvent) => void;
  /**
   * Hears each input block the normalizer left out: a tool_result whose call
   * is in none of the messages, or a second result for a call that already
   * has one. For a caller that follows its blocks by object identity
   * (request fidelity). A tool_result spelled `toolUseId` is copied to
   * rename the key, without calling this.
   */
  onBlockDropped?: (original: ProviderBlock) => void;
  /**
   * Hears each block the normalizer put in an input block's place: a copy of
   * the last cacheable block before a dropped one, taking the dropped block's
   * cache marker, and the leading text a user turn holds once drops have
   * emptied it, or the first pending result that fills it, in place of the
   * last block dropped from it. For a caller that follows its blocks by
   * object identity.
   */
  onBlockReplaced?: (original: ProviderBlock, replacement: ProviderBlock) => void;
  /**
   * Text of the synthetic user envelope prepended when the first envelope is
   * assistant, and of a user turn that dropped results have emptied.
   * `[continuing]` when absent, empty or only whitespace.
   */
  leadingUserText?: string;
}

export interface NormalizeResult {
  /**
   * Normalized messages, structurally compatible with the loose
   * `ProviderMessage` from `./types.js`. Block contents are
   * `ProviderBlock[]` at runtime.
   */
  messages: LooseProviderMessage[];
  /**
   * `false` iff some unmatched tool_use's id was in `pendingToolCallIds`,
   * wherever it sits: nothing is synthesized for it. The caller should wait
   * for the in-flight result to land and rebuild instead of shipping the
   * request.
   */
  ready: boolean;
}

/**
 * A history the normalizer refuses: a producer defect it can't repair
 * without guessing, or, after repair, a violation that is the normalizer's
 * own bug. The refusal is deterministic for its input, so it is an
 * `invalid_request` no retry can change, and Membrane hands it to the
 * caller as it is.
 */
export class MembraneNormalizerError extends MembraneError {
  constructor(
    message: string,
    public readonly input: ReadonlyArray<LooseProviderMessage>,
    public readonly output: ReadonlyArray<LooseProviderMessage>,
  ) {
    super({ type: 'invalid_request', message, retryable: false, rawError: undefined });
    this.name = 'MembraneNormalizerError';
  }
}

/**
 * Normalize a sequence of provider messages so the output is API-valid
 * with respect to Anthropic's tool-cycle structural rules.
 *
 * Consecutive messages of one role become one envelope as their blocks are
 * reflowed, but the output can still hold adjacent envelopes of one role,
 * which the API accepts.
 */
export function normalizeToolPairs(
  input: ReadonlyArray<LooseProviderMessage>,
  options: NormalizeOptions = {},
): NormalizeResult {
  assertPendingToolCallIdsIsSetLike(options.pendingToolCallIds, input);
  assertInputWellFormed(input);

  const pending = options.pendingToolCallIds ?? new Set<string>();
  const onEvent = options.onEvent ?? noop;

  let envelopes = rebuildEnvelopes(input, onEvent);
  assertCallIdsUniquePerTurn(envelopes, input);

  envelopes = hoistMatchingResults(envelopes, onEvent);

  // Each envelope a result was dropped from, with the last one dropped.
  const droppedFrom = new Map<Envelope, ProviderBlock>();
  const drop: Drop = (envelopes, at, before, block, event) => {
    droppedFrom.set(envelopes[at]!, block);
    onEvent(event);
    options.onBlockDropped?.(block);
    const marker = cacheMarkerOf(block);
    if (marker) moveCacheMarker(envelopes, at, before, marker, options.onBlockReplaced);
  };

  envelopes = repairStrayResults(envelopes, onEvent, drop);

  const orphanRes = resolveOrphans(envelopes, pending, onEvent, drop);
  envelopes = orphanRes.envelopes;
  const ready = orphanRes.ready;

  envelopes = evictInterlopers(envelopes, onEvent);

  // Anthropic rejects a text block that is only whitespace.
  const leadingText = options.leadingUserText?.trim() ? options.leadingUserText : '[continuing]';
  // A drop that empties a user turn leaves the turn in place, holding the
  // leading case's text: removing it would merge the assistant turns around
  // it, or end the request on the assistant, which the API reads as a prefill.
  // A turn the drops emptied that pending results then filled stands in the
  // last dropped block's place through the first of them.
  for (const [envelope, last] of droppedFrom) {
    if (envelope.role !== 'user') continue;
    if (envelope.content.length > 0) {
      if (envelope.content.every((block) => synthesized.has(block))) options.onBlockReplaced?.(last, envelope.content[0]!);
      continue;
    }
    const held: ProviderBlock = { type: 'text', text: leadingText };
    envelope.content.push(held);
    options.onBlockReplaced?.(last, held);
  }

  envelopes = envelopes.filter((e) => e.content.length > 0);

  // Anthropic requires `messages[0].role === 'user'`.
  if (envelopes.length > 0 && envelopes[0]!.role === 'assistant') {
    const originalFirstRole = input[0]!.role;
    const leadingBlockTypes = envelopes[0]!.content.map((b) => b.type);
    envelopes.unshift({ role: 'user', content: [{ type: 'text', text: leadingText }] });
    onEvent({ kind: 'leading_user_synthesized', originalFirstRole, leadingBlockTypes });
  }

  validate(envelopes, input, pending, AFTER_REPAIR);

  return { messages: envelopes.map(toProviderMessage), ready };
}

/**
 * Assert that an already-normalized message list satisfies Anthropic's
 * tool-cycle pairing rules: every tool_use paired by a tool_result in the
 * very next user envelope (modulo `pendingToolCallIds`), every tool_result
 * preceded by its own tool_use, and exactly one result per use. All results
 * must precede text, images, and other blocks in their user envelope.
 *
 * {@link normalizeToolPairs} ends with this check. A caller holding messages
 * from a path that doesn't go through it can use it to check pairing and
 * known strict-role placement. This is not a complete provider-schema or
 * cache-budget validator. Explicitly pending calls may remain unmatched;
 * success with a pending set does not establish that the request is ready
 * to send.
 *
 * The messages are judged as the provider reads them: consecutive messages
 * with one role are one turn, as the API combines them. Nothing else is
 * repaired, and a refusal names the messages at fault.
 */
export function assertToolPairsValid(
  messages: ReadonlyArray<LooseProviderMessage>,
  pendingToolCallIds?: ReadonlySet<string>,
): void {
  assertPendingToolCallIdsIsSetLike(pendingToolCallIds, messages);
  assertInputWellFormed(messages);
  const { envelopes, origin } = turnsAsGiven(messages);
  assertCallIdsUniquePerTurn(envelopes, messages, origin);
  validate(envelopes, messages, pendingToolCallIds ?? new Set<string>(), origin);
}

function describeShape(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `Array(${value.length})`;
  const primitive = typeof value;
  if (primitive !== 'object') return primitive;
  return (value as { constructor?: { name?: string } }).constructor?.name ?? 'object';
}

function assertPendingToolCallIdsIsSetLike(
  value: ReadonlySet<string> | null | undefined,
  input: ReadonlyArray<LooseProviderMessage>,
): void {
  if (value === undefined || value === null) return;
  const candidate = value as { has?: unknown; [Symbol.iterator]?: unknown };
  if (typeof candidate.has !== 'function' || typeof candidate[Symbol.iterator] !== 'function') {
    throw new MembraneNormalizerError(
      `normalizeToolPairs option 'pendingToolCallIds' must be a ReadonlySet<string> — ` +
        `the normalizer consults it with .has(id). Received ${describeShape(value)}. ` +
        `Build one at the call site with new Set(ids); the normalizer will not coerce, ` +
        `because a silent coercion here would hide the producer-side type error.`,
      snapshot(input),
      [],
    );
  }
  for (const member of value as Iterable<unknown>) {
    if (typeof member === 'string') continue;
    throw new MembraneNormalizerError(
      `normalizeToolPairs option 'pendingToolCallIds' must hold tool_use ids as strings. ` +
        `Received ${describeShape(value)} holding ${describeShape(member)}, which .has(id) never ` +
        `matches, so an in-flight call would get a fabricated '[pending]' result.`,
      snapshot(input),
      [],
    );
  }
}

function assertInputWellFormed(input: ReadonlyArray<LooseProviderMessage>): void {
  for (let i = 0; i < input.length; i++) {
    const msg = input[i] as unknown;
    const role = (msg as { role?: unknown } | null)?.role;
    if (msg === null || typeof msg !== 'object' || (role !== 'user' && role !== 'assistant')) {
      throw new MembraneNormalizerError(
        `Message ${i} is ${describeMessage(msg)}; normalizeToolPairs accepts objects with ` +
          `role 'user' or 'assistant'.`,
        snapshot(input),
        [],
      );
    }
    const content = (msg as LooseProviderMessage).content;
    if (content === null || content === undefined || typeof content === 'string') continue;
    if (!Array.isArray(content)) {
      throw new MembraneNormalizerError(
        `Message ${i} (role '${role}') has content of type ${describeShape(content)}; ` +
          `normalizeToolPairs accepts a block array or a plain string. Coercing this with ` +
          `String() would ship the literal text '[object Object]' to the model.`,
        snapshot(input),
        [],
      );
    }
    for (let j = 0; j < content.length; j++) {
      const block = content[j] as unknown;
      const type = (block as { type?: unknown } | null)?.type;
      if (block === null || typeof block !== 'object' || typeof type !== 'string') {
        throw new MembraneNormalizerError(
          `Message ${i} (role '${role}') block ${j} is ${describeBlock(block)}; every content ` +
            `block must be an object with a string 'type'.`,
          snapshot(input),
          [],
        );
      }
      if (type !== 'tool_use') continue;
      const id = (block as { id?: unknown }).id;
      if (typeof id === 'string') continue;
      throw new MembraneNormalizerError(
        `Message ${i} (role '${role}') block ${j} is a tool_use whose id is ${describeShape(id)}, ` +
          `not a string. A tool_result names its call by id, so nothing can answer this call.`,
        snapshot(input),
        [],
      );
    }
  }
}

function describeMessage(msg: unknown): string {
  if (msg === null || typeof msg !== 'object') return describeShape(msg);
  const role = (msg as { role?: unknown }).role;
  return typeof role === 'string'
    ? `a message with role '${role}'`
    : `a message whose role is ${describeShape(role)}`;
}

function describeBlock(block: unknown): string {
  if (block === null || typeof block !== 'object') return describeShape(block);
  return `an object whose type is ${describeShape((block as { type?: unknown }).type)}`;
}

/** The API refuses two calls with one id in the same turn ("tool_use ids must be unique"). */
function assertCallIdsUniquePerTurn(
  envelopes: ReadonlyArray<Envelope>,
  input: ReadonlyArray<LooseProviderMessage>,
  origin?: ValidationOrigin,
): void {
  for (let i = 0; i < envelopes.length; i++) {
    const env = envelopes[i]!;
    if (env.role !== 'assistant') continue;
    const seen = new Set<string>();
    for (const id of collectToolUseIds(env)) {
      if (!seen.has(id)) {
        seen.add(id);
        continue;
      }
      throw new MembraneNormalizerError(
        `Two tool_use blocks in one assistant turn${origin ? ` (${origin.turn(i)})` : ''} share ` +
          `the id '${id}'. A tool_result names its call by id alone, so their results can't be ` +
          `told apart, and the API refuses such a request. Mint a fresh id per call.`,
        snapshot(input),
        envelopes.map(toProviderMessage),
      );
    }
  }
}

interface Envelope {
  role: 'user' | 'assistant';
  content: ProviderBlock[];
}

type RequiredRole = 'user' | 'assistant' | 'inherit';

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

/** The reasoning block types Anthropic pins to the assistant role. */
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
  let currentFirstCallInputIndex = -1;

  for (let m = 0; m < input.length; m++) {
    const msg = input[m]!;
    if (typeof msg.content === 'string') {
      const role = msg.role;
      if (current === null || current.role !== role) {
        if (current) out.push(current);
        current = { role, content: [] };
        currentFirstCallInputIndex = -1;
      }
      current.content.push({ type: 'text', text: msg.content });
      continue;
    }

    for (const raw of (msg.content ?? []) as ProviderBlock[]) {
      const block = withCanonicalResultId(raw);
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

      const wouldWeldReasoningPastToolUse =
        isStrictReasoningBlock(block) &&
        current !== null &&
        current.role === 'assistant' &&
        currentFirstCallInputIndex >= 0 &&
        currentFirstCallInputIndex < m;

      if (current === null || current.role !== targetRole || wouldWeldReasoningPastToolUse) {
        if (current) out.push(current);
        current = { role: targetRole, content: [] };
        currentFirstCallInputIndex = -1;
      }
      current.content.push(block);
      if (block.type === 'tool_use' && currentFirstCallInputIndex < 0) currentFirstCallInputIndex = m;
    }
  }

  if (current) out.push(current);
  return out;
}

function hoistMatchingResults(
  envelopes: Envelope[],
  onEvent: (e: NormalizeEvent) => void,
): Envelope[] {
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
    const presentIds = new Set(
      nextEnv.content
        .filter((b) => b.type === 'tool_result')
        .map(getToolUseId)
        .filter((id): id is string => typeof id === 'string'),
    );

    for (let useIdIndex = 0; useIdIndex < useIds.length; useIdIndex++) {
      const useId = useIds[useIdIndex]!;
      if (presentIds.has(useId)) continue;

      const found = removeFirstMatchingResult(
        envelopes,
        nextIdx + 1,
        nextCallIndex(envelopes, useId, nextIdx + 1),
        useId,
      );
      if (found) {
        nextEnv.content.splice(
          callOrderInsertionIndex(nextEnv, useIds, useIdIndex),
          0,
          found.block,
        );
        onEvent({
          kind: 'tool_result_hoisted',
          toolUseId: useId,
          fromEnvelope: found.fromEnvelope,
          toEnvelope: nextIdx,
        });
      }
    }
  }
  return envelopes;
}

/**
 * Leave out a result: `before` is what its envelope, `envelopes[at]`, keeps
 * ahead of it.
 */
type Drop = (
  envelopes: Envelope[],
  at: number,
  before: ProviderBlock[],
  block: ProviderBlock,
  event: NormalizeEvent,
) => void;

/** A result's cache marker: its own, or else the last one inside its content, where a provider reads one too. */
function cacheMarkerOf(block: ProviderBlock): unknown {
  if (block.cache_control) return block.cache_control;
  const content = (block as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  for (let i = content.length - 1; i >= 0; i--) {
    const marker = (content[i] as { cache_control?: unknown } | null)?.cache_control;
    if (marker) return marker;
  }
  return undefined;
}

/** Thinking blocks can't carry a cache marker. */
export function isCacheableBlock(block: Record<string, unknown> | null | undefined): boolean {
  return block?.type !== 'thinking' && block?.type !== 'redacted_thinking';
}

/**
 * A dropped block's cache marker goes to the last cacheable block before it
 * that the wire keeps, so the request still caches the prefix the marker
 * asked for, unless that block carries a marker already, on itself or in its
 * content. With nothing such before it, the marker goes too.
 */
function moveCacheMarker(
  envelopes: Envelope[],
  at: number,
  before: ProviderBlock[],
  marker: unknown,
  onBlockReplaced: NormalizeOptions['onBlockReplaced'],
): void {
  const earlier = [before, ...envelopes.slice(0, at).reverse().map((envelope) => envelope.content)];
  for (const blocks of earlier) {
    for (let k = blocks.length - 1; k >= 0; k--) {
      const target = blocks[k]!;
      if (!isCacheableBlock(target) || (target.type === 'text' && !hasNonEmptyText(target.text))) continue;
      if (cacheMarkerOf(target)) return;
      const copy = { ...target, cache_control: marker };
      blocks[k] = copy;
      onBlockReplaced?.(target, copy);
      return;
    }
  }
}

function repairStrayResults(
  envelopes: Envelope[],
  onEvent: (e: NormalizeEvent) => void,
  drop: Drop,
): Envelope[] {
  const callEnvelopesOfId = new Map<string, number[]>();
  for (let i = 0; i < envelopes.length; i++) {
    const env = envelopes[i]!;
    if (env.role !== 'assistant') continue;
    for (const id of collectToolUseIds(env)) {
      const calls = callEnvelopesOfId.get(id);
      if (calls) calls.push(i);
      else callEnvelopesOfId.set(id, [i]);
    }
  }
  if (callEnvelopesOfId.size === 0) return envelopes;

  for (let i = 0; i < envelopes.length; i++) {
    const env = envelopes[i]!;
    if (env.role !== 'user') continue;
    const previous = envelopes[i - 1];
    const idsPairedHere = new Set(
      previous?.role === 'assistant' ? collectToolUseIds(previous) : [],
    );

    const kept: ProviderBlock[] = [];
    const idsConsumedHere = new Set<string>();
    for (const block of env.content) {
      if (block.type !== 'tool_result') {
        kept.push(block);
        continue;
      }
      const id = getToolUseId(block);
      if (typeof id !== 'string') {
        kept.push(block);
        continue;
      }
      if (idsPairedHere.has(id)) {
        if (!idsConsumedHere.has(id)) {
          idsConsumedHere.add(id);
          kept.push(block);
          continue;
        }
        drop(envelopes, i, kept, block, { kind: 'stray_tool_result_dropped', toolUseId: id, fromEnvelope: i, reason: 'duplicate_in_cycle' });
        continue;
      }
      const calls = callEnvelopesOfId.get(id);
      if (calls === undefined) {
        kept.push(block);
        continue;
      }
      const useEnvelope = owningCall(calls, i);

      const cycleEnvelope = envelopes[useEnvelope + 1];
      const cycleIsOpen =
        cycleEnvelope !== undefined &&
        cycleEnvelope.role === 'user' &&
        !cycleEnvelope.content.some(
          (b) => b.type === 'tool_result' && getToolUseId(b) === id,
        );

      if (cycleIsOpen) {
        const cycleUseIds = collectToolUseIds(envelopes[useEnvelope]!);
        cycleEnvelope!.content.splice(
          callOrderInsertionIndex(cycleEnvelope!, cycleUseIds, cycleUseIds.indexOf(id)),
          0,
          block,
        );
        onEvent({
          kind: 'tool_result_hoisted',
          toolUseId: id,
          fromEnvelope: i,
          toEnvelope: useEnvelope + 1,
        });
        continue;
      }

      drop(envelopes, i, kept, block, { kind: 'stray_tool_result_dropped', toolUseId: id, fromEnvelope: i, reason: 'cycle_closed' });
    }
    env.content = kept;
  }
  return envelopes;
}

function evictInterlopers(
  envelopes: Envelope[],
  onEvent: (e: NormalizeEvent) => void,
): Envelope[] {
  for (let i = 0; i < envelopes.length; i++) {
    const env = envelopes[i]!;
    if (env.role !== 'user') continue;
    const results: ProviderBlock[] = [];
    const other: ProviderBlock[] = [];
    let deferredCount = 0;
    for (const block of env.content) {
      if (block.type === 'tool_result') {
        results.push(block);
        deferredCount = other.length;
      } else {
        other.push(block);
      }
    }
    if (deferredCount === 0) continue;
    for (const block of other.slice(0, deferredCount)) {
      onEvent({ kind: 'interloper_deferred', blockType: block.type, fromEnvelope: i });
    }
    env.content = [...results, ...other];
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
  drop: Drop,
): OrphanResolution {
  let ready = true;

  const allUseIds = new Set<string>();
  for (const env of envelopes) {
    for (const block of env.content) {
      if (block.type === 'tool_use') {
        const id = (block as { id?: string }).id;
        if (typeof id === 'string') allUseIds.add(id);
      }
    }
  }
  for (let i = 0; i < envelopes.length; i++) {
    const env = envelopes[i]!;
    if (env.role !== 'user') continue;
    const kept: ProviderBlock[] = [];
    for (const block of env.content) {
      const id = block.type === 'tool_result' ? getToolUseId(block) : undefined;
      if (block.type !== 'tool_result' || (typeof id === 'string' && allUseIds.has(id))) kept.push(block);
      else drop(envelopes, i, kept, block, { kind: 'orphan_tool_result_dropped', toolUseId: id ?? '<missing>' });
    }
    env.content = kept;
  }

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
      nextEnv.content.splice(callOrderInsertionIndex(nextEnv, useIds, useIdIndex), 0, synth);
      onEvent({
        kind: 'synthetic_pending_result',
        toolUseId: useId,
        reason: isTrailing ? 'trailing' : 'mid_stream',
      });
    }
  }

  return { envelopes, ready };
}

function callOrderInsertionIndex(
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

interface ValidationOrigin {
  readonly turn: (i: number) => string;
  readonly blame: string;
}

const AFTER_REPAIR: ValidationOrigin = {
  turn: (i) => `envelope ${i}`,
  blame: ' The repair should have prevented this, so this is a bug in the normalizer itself.',
};

function turnsAsGiven(messages: ReadonlyArray<LooseProviderMessage>): {
  envelopes: Envelope[];
  origin: ValidationOrigin;
} {
  const envelopes: Envelope[] = [];
  const first: number[] = [];
  const last: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    const blocks: ProviderBlock[] =
      typeof msg.content === 'string'
        ? [{ type: 'text', text: msg.content }]
        : ((msg.content ?? []) as ProviderBlock[]);
    if (blocks.length === 0) continue;
    const turn = envelopes.length - 1;
    if (turn >= 0 && envelopes[turn]!.role === msg.role) {
      envelopes[turn]!.content.push(...blocks);
      last[turn] = i;
    } else {
      envelopes.push({ role: msg.role, content: [...blocks] });
      first.push(i);
      last.push(i);
    }
  }
  return {
    envelopes,
    origin: {
      turn: (i) => (first[i] === last[i] ? `message ${first[i]}` : `messages ${first[i]}–${last[i]}`),
      blame: ' The history itself breaks the rule; normalizeToolPairs repairs a history like this.',
    },
  };
}

function validate(
  envelopes: Envelope[],
  input: ReadonlyArray<LooseProviderMessage>,
  pending: ReadonlySet<string>,
  origin: ValidationOrigin,
): void {
  if (envelopes.length === 0) return;

  const refuse = (description: string): never => {
    throw new MembraneNormalizerError(
      description + origin.blame,
      snapshot(input),
      envelopes.map(toProviderMessage),
    );
  };

  for (let i = 0; i < envelopes.length; i++) {
    const envelope = envelopes[i]!;
    for (const block of envelope.content) {
      if (typeof block.type !== 'string') continue;
      const required = requiredRoleOf(block);
      if (required !== 'inherit' && envelope.role !== required) {
        refuse(`${block.type} in ${origin.turn(i)} has role '${envelope.role}'; expected '${required}'.`);
      }
    }
  }

  if (envelopes[0]!.role !== 'user') {
    refuse(`The first message must have role 'user', got '${envelopes[0]!.role}'.`);
  }

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
      if (pending.has(useId)) continue;
      refuse(
        `tool_use id='${useId}' in ${origin.turn(i)} has no matching tool_result in the user ` +
          `turn right after it, and the id is not in pendingToolCallIds.`,
      );
    }
  }

  for (let i = 0; i < envelopes.length; i++) {
    const env = envelopes[i]!;
    if (env.role !== 'user') continue;
    const previous = envelopes[i - 1];
    const availableUseIds = new Set(
      previous?.role === 'assistant' ? collectToolUseIds(previous) : [],
    );
    const resultsPerId = new Map<string, number>();
    let seenNonResult = false;
    for (const block of env.content) {
      if (block.type !== 'tool_result') {
        seenNonResult = true;
        continue;
      }
      if (seenNonResult) {
        refuse(
          `A tool_result in ${origin.turn(i)} appears after non-result content. ` +
            `All tool_result blocks must appear before text, images, and other blocks.`,
        );
      }
      const resultId = getToolUseId(block);
      if (typeof resultId !== 'string' || !availableUseIds.has(resultId)) {
        refuse(
          (typeof resultId === 'string'
            ? `The tool_result for id='${resultId}' in ${origin.turn(i)} has no matching tool_use `
            : `A tool_result without a tool_use_id in ${origin.turn(i)} has no matching tool_use `) +
            `in the assistant turn right before it. Anthropic requires each tool_result to ` +
            `follow its tool_use immediately.`,
        );
      }
      const id = resultId as string;
      const copiesSoFar = (resultsPerId.get(id) ?? 0) + 1;
      resultsPerId.set(id, copiesSoFar);
      if (copiesSoFar > 1) {
        refuse(
          `The tool_result for id='${id}' appears ${copiesSoFar} times in ${origin.turn(i)}; a ` +
            `tool_use takes exactly one tool_result. A one-call/two-result cycle is wire-shaped ` +
            `enough to reach the provider, which then rejects it or picks a copy by rules ` +
            `Membrane does not control.`,
        );
      }
    }
  }
}

/** Anthropic pairs a result with its call by `tool_use_id` alone. */
function getToolUseId(block: ProviderBlock): string | undefined {
  const id = (block as { tool_use_id?: unknown }).tool_use_id;
  return typeof id === 'string' ? id : undefined;
}

function withCanonicalResultId(block: ProviderBlock): ProviderBlock {
  if (block.type !== 'tool_result' || !('toolUseId' in block)) return block;
  const { toolUseId, ...rest } = block as ProviderBlock & { toolUseId?: unknown };
  if (typeof rest.tool_use_id !== 'string' && typeof toolUseId === 'string') {
    return { ...rest, tool_use_id: toolUseId } as ProviderBlock;
  }
  return rest as ProviderBlock;
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

function nextCallIndex(envelopes: ReadonlyArray<Envelope>, id: string, from: number): number {
  for (let i = from; i < envelopes.length; i++) {
    const env = envelopes[i]!;
    if (env.role === 'assistant' && collectToolUseIds(env).includes(id)) return i;
  }
  return envelopes.length;
}

function owningCall(calls: ReadonlyArray<number>, at: number): number {
  let owner = calls[0]!;
  for (const call of calls) {
    if (call > at) break;
    owner = call;
  }
  return owner;
}

function removeFirstMatchingResult(
  envelopes: Envelope[],
  fromIdx: number,
  toIdx: number,
  useId: string,
): { block: ProviderBlock; fromEnvelope: number } | null {
  for (let i = fromIdx; i < toIdx; i++) {
    const env = envelopes[i]!;
    if (env.role !== 'user') continue;
    for (let j = 0; j < env.content.length; j++) {
      const block = env.content[j]!;
      if (block.type !== 'tool_result') continue;
      if (getToolUseId(block) === useId) {
        env.content.splice(j, 1);
        return { block, fromEnvelope: i };
      }
    }
  }
  return null;
}

/** The `[pending]` results the normalizer made, which no input block is. */
const synthesized = new WeakSet<ProviderBlock>();

function syntheticToolResult(toolUseId: string): ProviderBlock {
  const block: ProviderBlock = {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: '[pending]',
    is_error: false,
  };
  synthesized.add(block);
  return block;
}

function toProviderMessage(env: Envelope): LooseProviderMessage {
  return { role: env.role, content: env.content };
}

function snapshot(input: ReadonlyArray<LooseProviderMessage>): LooseProviderMessage[] {
  return input.map((msg) =>
    msg !== null && typeof msg === 'object'
      ? { role: msg.role, content: Array.isArray(msg.content) ? [...msg.content] : msg.content }
      : msg,
  );
}

function noop(): void {
}

/**
 * Anthropic's API accepts adjacent same-role messages, but counts one token
 * more at each boundary than for the same blocks in one message.
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
