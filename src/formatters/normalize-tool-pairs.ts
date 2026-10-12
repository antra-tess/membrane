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
 * COVERAGE — what actually funnels through `normalizeToolPairs`:
 *
 *   - `NativeFormatter.buildMessages` — COVERED. Membrane's shared
 *     construction uses this pass for complete and native streaming/yielding
 *     requests built by NativeFormatter, including native loop rebuilds and
 *     AnthropicXmlFormatter's native-mode delegation.
 *   - `AnthropicXmlFormatter` in XML mode and `CompletionsFormatter` — NOT
 *     covered, and they do not need to be: both emit flattened text with no
 *     structural tool blocks, so tool-cycle placement rules have nothing
 *     to bind to in their output.
 *   - `OpenAIResponsesFormatter` — NOT covered. It owns provider-native
 *     `function_call` / `function_call_output` items, whose ids, encrypted
 *     reasoning, assistant phases and compaction items must survive shared
 *     construction rather than being forced through this Anthropic-shaped
 *     normalizer. Responses item pairing is outside this module's scope;
 *     that formatter's `ready: true` is not this pass's validation result.
 *
 * Custom formatters own their structural validation. Sharing the formatter
 * build does not imply that every formatter invokes this normalizer.
 *
 * Algorithm overview (phases): refuse malformed input at entry (phase 0 —
 * a `pendingToolCallIds` that isn't a set of strings, a message that isn't
 * a user or assistant message with string or block-array content, a block
 * without a string `type`, a tool_use without a string id), reclassify
 * blocks by required role, reflow into role-correct envelopes, refuse two
 * calls sharing one id in a turn, hoist matching tool_results across the
 * assistant→user boundary, sweep the converse direction so every
 * tool_result sits with its own tool_use, synthesize `[pending]` results
 * for orphans (or signal not-ready for caller-declared pending ids), put
 * all results before non-results while preserving order within each group,
 * drop empty envelopes, prepend a synthetic user envelope (`[continuing]`,
 * or the caller's `leadingUserText`) when the first envelope ended up
 * assistant-role, validate both
 * directions of the pairing rule and its one-to-one arity.
 *
 * PAIRING IS POSITIONAL, as on the wire: a tool_result answers the nearest
 * tool_use with its id before it. Ids are normally unique, but a history
 * can reuse one across turns (a provider that omits or recycles ids), and
 * the API accepts that; every phase below pairs by position, so a reused
 * id needs no refusal. Only two calls with one id in the same turn can't be
 * answered apart, and the API refuses those.
 */

import type { ProviderMessage as LooseProviderMessage } from './types.js';
import type { NormalizeEvent } from './types.js';
import { MembraneError } from '../types/errors.js';

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

/**
 * Does this repair REWRITE prefix bytes, or only re-shape envelopes?
 *
 * The `true` entries rewrite content: synthetic `[pending]` results, orphan
 * textification, and duplicate-result textification. A pending result or
 * orphan can change again when its real pairing arrives, so a cache
 * breakpoint placed at or past one caches a prefix that is about to change,
 * poisoning every subsequent read.
 *
 * EVERY kind is listed, and the type is a `Record` over the whole union
 * precisely so the compiler forces that: a new `NormalizeEvent` kind is a
 * missing-property error here until someone decides which side it falls on.
 * The previous shape (`[...] satisfies Array<NormalizeEvent['kind']>`) only
 * checked that the listed kinds were REAL, and a `satisfies` on an array
 * accepts any subset — so a new prefix-rewriting repair could be added to the
 * union, never listed, and silently escape the cache gate below while the
 * comment claimed a compile error that did not exist.

 */
const NORMALIZE_EVENT_REWRITES_PREFIX: Record<NormalizeEvent['kind'], boolean> = {
  block_re_roled: false,
  tool_result_hoisted: false,
  interloper_deferred: false,
  synthetic_pending_result: true,
  orphan_tool_result_textified: true,
  stray_tool_result_textified: true,
  pending_in_flight: false,
  leading_user_synthesized: false,
};

function deriveKindsThatRewritePrefix(): ReadonlySet<NormalizeEvent['kind']> {
  const kinds = Object.entries(NORMALIZE_EVENT_REWRITES_PREFIX)
    .filter(([, rewritesPrefix]) => rewritesPrefix)
    .map(([kind]) => kind as NormalizeEvent['kind']);
  return new Set(kinds);
}

/**
 * The repairs that rewrite prefix bytes, derived from the exhaustive
 * classification above. Consumers gate cache placement on this SET rather
 * than on a single kind, so a normalizer that grows another prefix-rewriting
 * repair is covered at every cache site by classifying it once.
 */
export const PREFIX_REWRITING_NORMALIZE_EVENT_KINDS: ReadonlySet<NormalizeEvent['kind']> =
  deriveKindsThatRewritePrefix();

export interface NormalizeOptions {
  /** See `BuildOptions.pendingToolCallIds`. */
  pendingToolCallIds?: ReadonlySet<string>;
  /** See `BuildOptions.onNormalize`. */
  onEvent?: (event: NormalizeEvent) => void;
  /**
   * Text of the synthetic user envelope prepended when the first envelope is
   * assistant (phase 7). `[continuing]` when absent, empty or only
   * whitespace. NativeFormatter passes `BuildOptions.prefillUserMessage`, so
   * a caller's text is used wherever the conversation needs a leading user
   * turn, whatever made it need one.
   */
  leadingUserText?: string;
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
  // Phase 1 + 2: reclassify blocks by required role and reflow envelopes.
  // A turn is now an envelope, so this is where two calls sharing an id in
  // one turn can be seen.
  // ---------------------------------------------------------------------
  let envelopes = rebuildEnvelopes(input, onEvent);
  assertCallIdsUniquePerTurn(envelopes, input);

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
  // Phase 4: resolve orphans. Textification can create new non-result
  // blocks before or between results, so ordering repair must follow it.
  // ---------------------------------------------------------------------
  const orphanRes = resolveOrphans(envelopes, pending, onEvent);
  envelopes = orphanRes.envelopes;
  const ready = orphanRes.ready;

  // ---------------------------------------------------------------------
  // Phase 5: put every tool_result before all other user-envelope blocks.
  // This includes text just created by orphan/duplicate recovery.
  // ---------------------------------------------------------------------
  envelopes = evictInterlopers(envelopes, onEvent);

  // ---------------------------------------------------------------------
  // Phase 6: drop empty envelopes left by hoisting or relocation.
  // We deliberately do NOT merge consecutive same-role envelopes here —
  // that's the formatter's job.
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
  // Both cases get the same repair (prepend a synthetic user envelope:
  // the caller's `leadingUserText` when given, else `[continuing]`)
  // because deletion would lose content in case (a) — the
  // re-roled blocks are real conversation content the producer
  // expected to ship. The synthetic costs a leading cache miss
  // (deterministic literal, so idempotent across identical inputs)
  // but preserves API correctness and producer simplicity. We emit
  // a warn-level event so telemetry can distinguish the causes and
  // alert on (b) without coupling control flow to attribution.
  //
  // Idempotency: the synthetic content is fixed for a given call. Running
  // normalize twice on the same input produces identical output the
  // second time (envelope[0] is user, gate doesn't fire).
  // ---------------------------------------------------------------------
  if (envelopes.length > 0 && envelopes[0]!.role === 'assistant') {
    // `input` is guaranteed non-empty here: rebuildEnvelopes only
    // produces envelopes when iterating input messages, so a non-empty
    // envelopes implies a non-empty input.
    const originalFirstRole = input[0]!.role;
    const leadingBlockTypes = envelopes[0]!.content.map((b) => b.type);
    // Blank text would be a whitespace-only block, which Anthropic rejects
    // and stripEmptyTextRequest drops, leaving an assistant first again.
    const leadingText = options.leadingUserText?.trim() ? options.leadingUserText : '[continuing]';
    envelopes.unshift({ role: 'user', content: [{ type: 'text', text: leadingText }] });
    onEvent({ kind: 'leading_user_synthesized', originalFirstRole, leadingBlockTypes });
  }

  // ---------------------------------------------------------------------
  // Phase 8: validate. When `ready === false` we intentionally have
  // unmatched tool_uses — but ONLY the ones in `pending` are allowed to
  // remain unsynthesized. Any other gap is a bug in phase 4 and must
  // throw. The first-message-must-be-user branch should be unreachable
  // after phase 7; it remains as defense-in-depth against a future
  // phase introducing a leading assistant envelope without firing
  // phase 7.
  // ---------------------------------------------------------------------
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
 * This is phase 8 of {@link normalizeToolPairs}, reachable on its own. The
 * validator's contract has to hold independently of the repair phases that
 * normally establish it — otherwise the only evidence it refuses a shape is
 * that no earlier phase produced one, which is a claim about the sweep, not
 * about the validator. Callers holding messages from a path that does NOT
 * funnel through this module (see the COVERAGE note in the file header) can
 * use it to check pairing and known strict-role placement. This is not a
 * complete provider-schema or cache-budget validator. Explicitly pending
 * calls may remain unmatched; success with a pending set does not establish
 * that the request is ready to send.
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
 * A set of the wrong members is quieter still: a Set of numbers answers
 * every `.has(id)` with false, so an in-flight call gets a fabricated
 * `[pending]` result and `ready` stays true.
 *
 * Refuse at entry, unconditionally: the value must be set-like (a callable
 * `has`, iterable) and hold only strings. `undefined`, and `null` as untyped
 * configuration writes it, mean nothing is pending. Deliberately NOT
 * `new Set(value)`: coercing here would launder the caller's type error into
 * behaviour that happens to work, and the public type stays a membership set
 * rather than growing a permanent union plus an O(n) scan per unmatched id.
 */
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

/**
 * Structural preconditions on the input message list. Each one turns a
 * producer defect into a typed refusal before any phase runs, where it would
 * otherwise surface as an untyped TypeError mid-pipeline or as a silently
 * wrong request.
 *
 * (a) A message is an object with role 'user' or 'assistant'.
 *
 * (b) Content is a block array or a plain string; `null` or `undefined` is
 *     an empty block list, as the old `String(msg.content ?? '')` made it
 *     empty text. Anything else used to reach that `String()`, which puts
 *     the literal text `[object Object]` in front of the model — a poisoned
 *     turn that no downstream phase can detect or undo.
 *
 * (c) Every block is an object with a string `type`.
 *
 * (d) A tool_use has a string id: a tool_result names its call by id, so a
 *     call without one can never be answered, and every pairing phase would
 *     pass over it on its way to the provider's refusal.
 *
 * Ids may repeat across turns (see PAIRING IS POSITIONAL in the header); two
 * calls sharing an id within one turn are refused after reflow, by
 * {@link assertCallIdsUniquePerTurn}, since a turn is only known then.
 */
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

/**
 * Two calls with one id in the same turn can't be answered apart: a result
 * names its call by id alone, and the API refuses such a request ("tool_use
 * ids must be unique"). A turn is an assistant envelope, which is one wire
 * message. Ids reused across turns are fine (see the header).
 *
 * `origin`, given for a caller's own history, names the messages at fault;
 * without it the turn is one of the normalizer's reflowed envelopes, which a
 * caller can't index, so the id alone identifies it.
 */
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
  // The input message whose tool_use first entered `current`; -1 for none.
  let currentFirstCallFrom = -1;

  for (let m = 0; m < input.length; m++) {
    const msg = input[m]!;
    if (typeof msg.content === 'string') {
      // Provider message with plain-string content. Treat it as a single
      // text block under the message's declared role. The phase-0 guard
      // (assertInputWellFormed) has already refused every other non-array
      // shape but null and undefined, which carry no blocks, so no coercion
      // is needed or wanted here.
      const role = msg.role;
      if (current === null || current.role !== role) {
        if (current) out.push(current);
        current = { role, content: [] };
        currentFirstCallFrom = -1;
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

      // A reasoning block must not join a turn that an EARLIER message has
      // already used to call a tool, whether the block was re-roled or
      // arrived in an assistant message. Opening on role change alone put a
      // thinking block from message N — signature and all — inside message
      // N-1's turn, AFTER its tool_use: content attributed to the wrong turn,
      // and signed reasoning claiming to belong to a cycle it did not
      // produce. Two assistant messages in a row (the results message
      // between them lost) weld the same way without any re-roling. A
      // message's own reasoning after its own call stays where it was put.
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
        isStrictReasoningBlock(block) &&
        current !== null &&
        current.role === 'assistant' &&
        currentFirstCallFrom >= 0 &&
        currentFirstCallFrom < m;

      if (current === null || current.role !== targetRole || wouldWeldReasoningPastToolUse) {
        if (current) out.push(current);
        current = { role: targetRole, content: [] };
        currentFirstCallFrom = -1;
      }
      current.content.push(block);
      if (block.type === 'tool_use' && currentFirstCallFrom < 0) currentFirstCallFrom = m;
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

    for (let useIdIndex = 0; useIdIndex < useIds.length; useIdIndex++) {
      const useId = useIds[useIdIndex]!;
      if (presentIds.has(useId)) continue;

      // Search downstream envelopes for this id and hoist the first match,
      // but never from past a later call that reuses the id: a result
      // answers the nearest call with its id before it, so one sitting past
      // that later call is the later call's.
      const found = removeFirstMatchingResult(
        envelopes,
        nextIdx + 1,
        nextCallIndex(envelopes, useId, nextIdx + 1),
        useId,
      );
      if (found) {
        // Place the hoisted result at its own call's position, which is the
        // front while no earlier call's result has landed — so hoisted
        // results still precede any interloping content already present, but
        // a batch of them no longer comes back reversed.
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
      // If not found downstream, leave it — phase 4 will synthesize.
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
 * the real payload as a tool_result and stops phase 4 from synthesizing a
 * `[pending]` over a result that actually landed. C cannot be relocated
 * without displacing the real result, so it is textified — content
 * preserved, structure dropped. A result whose id appears nowhere is left
 * alone here; phase 4's orphan pass owns that case.
 *
 * Pairing is ONE-TO-ONE, so this scan CONSUMES ids rather than testing
 * membership: the first result carrying an id its envelope actually pairs
 * takes that id, and any later copy of it is shape C wearing a different
 * costume — same cycle, same repair. A membership test (`is this id called
 * here?`) is blind to the second copy by construction, which is how a
 * one-call/two-result envelope reached the provider through every phase.
 *
 * Which call a stray belongs to is positional, as on the wire: the nearest
 * call with its id before it, or, for a result written before every such
 * call (A and B), the nearest one after it. With unique ids that is simply
 * the id's one call.
 */
function repairStrayResults(
  envelopes: Envelope[],
  onEvent: (e: NormalizeEvent) => void,
): Envelope[] {
  // Each id's call envelopes, in order.
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
        kept.push(textifyDuplicateResult(block, id, i, 'duplicate_in_cycle', onEvent));
        continue;
      }
      const calls = callEnvelopesOfId.get(id);
      if (calls === undefined) {
        // Id appears nowhere — phase 4's orphan textification owns it.
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
        // At its own call's position, never at the front: unshifting each
        // relocated result reversed a multi-call batch ([ite1, ite2] came
        // back as [ite2, ite1]), which is the read-order defect phase 4
        // already fixed for synthetics.
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

      kept.push(textifyDuplicateResult(block, id, i, 'cycle_closed', onEvent));
    }
    env.content = kept;
  }
  return envelopes;
}

/**
 * The one repair both duplicate shapes take: keep the payload as text under a
 * deterministic provenance line, drop the tool_result structure that has no
 * open call to attach to. `reason` is the only thing that differs between a
 * copy stranded outside its (already-answered) cycle and a copy sitting
 * behind the result that answered its call inside it.
 */
function textifyDuplicateResult(
  block: ProviderBlock,
  toolUseId: string,
  fromEnvelope: number,
  reason: 'cycle_closed' | 'duplicate_in_cycle',
  onEvent: (e: NormalizeEvent) => void,
): ProviderBlock {
  const textified = textifyResult(block, `duplicate tool_result for ${toolUseId}`);
  onEvent({
    kind: 'stray_tool_result_textified',
    toolUseId,
    fromEnvelope,
    recoveredChars: textified.recoveredChars,
    reason,
  });
  return textified.block;
}

/**
 * The text block both textifications (orphan and duplicate) put in a
 * result's place. It carries:
 *   - the payload, as {@link renderResultContent} renders it, after a
 *     provenance line, which also says when the result was an error, since
 *     a failed call's output must not read as a successful one;
 *   - one cache marker, TTL included: the result's own, else the last one
 *     among its content parts. The block stands where the result stood, so a
 *     caller's breakpoint stays at that boundary; several markers inside one
 *     result can merge into one, never move past it, so the request's marker
 *     count never grows.
 */
function textifyResult(
  block: ProviderBlock,
  provenance: string,
): { block: ProviderBlock; recoveredChars: number } {
  const recovered = renderResultContent(block);
  const label = block.is_error === true ? `${provenance}, an error` : provenance;
  const marker = resultCacheMarker(block);
  return {
    block: {
      type: 'text',
      text: `[${label}]: ${recovered}`,
      ...(marker ? { cache_control: marker } : {}),
    },
    recoveredChars: recovered.length,
  };
}

function resultCacheMarker(block: ProviderBlock): unknown {
  if (block.cache_control) return block.cache_control;
  const content = (block as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  for (let i = content.length - 1; i >= 0; i--) {
    const marker = (content[i] as { cache_control?: unknown } | null)?.cache_control;
    if (marker) return marker;
  }
  return undefined;
}

function evictInterlopers(
  envelopes: Envelope[],
  onEvent: (e: NormalizeEvent) => void,
): Envelope[] {
  // Results must form a prefix, not merely start the envelope. Partition
  // after every repair that can create text, preserving the relative order
  // and payloads of both groups. No user content is discarded.
  for (let i = 0; i < envelopes.length; i++) {
    const env = envelopes[i]!;
    if (env.role !== 'user') continue;
    const results: ProviderBlock[] = [];
    const other: ProviderBlock[] = [];
    let deferredCount = 0;
    for (const block of env.content) {
      if (block.type === 'tool_result') {
        results.push(block);
        // Only non-results before the LAST result are displaced. A suffix
        // already after all results needs neither repair nor an event.
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
        const textified = textifyResult(block, `orphan tool_result for ${id ?? '<missing>'}`);
        onEvent({
          kind: 'orphan_tool_result_textified',
          toolUseId: id ?? '<missing>',
          recoveredChars: textified.recoveredChars,
        });
        return textified.block;
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

/**
 * Where the result for `useIds[useIdIndex]` belongs in the cycle's user
 * envelope: immediately after the result of the nearest earlier call that
 * already landed, or at the front when no earlier call has one. Every phase
 * that puts a result into a cycle envelope (synthesis in phase 4, relocation
 * in phase 3.5) routes through here. Only the inserted result is placed:
 * results already in the envelope keep their order. So an envelope whose
 * results are in call order stays in call order whichever phase inserts and
 * in whatever sequence, because each insertion anchors on landed neighbours
 * rather than a running counter; one whose results arrived out of call order
 * keeps them as they are.
 */
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

/**
 * Whose history a validation judges, which decides how its refusals read:
 * after {@link normalizeToolPairs}'s repair a violation is the normalizer's
 * own bug; in a caller's history given to {@link assertToolPairsValid} it is
 * that history's defect, at messages the caller can find.
 */
interface ValidationOrigin {
  /** Names turn `i` in a refusal. */
  readonly turn: (i: number) => string;
  /** Says whose defect a refusal is, after its description. */
  readonly blame: string;
}

const AFTER_REPAIR: ValidationOrigin = {
  turn: (i) => `envelope ${i}`,
  blame: ' The repair should have prevented this, so this is a bug in the normalizer itself.',
};

/**
 * A caller's messages as the provider reads them, for
 * {@link assertToolPairsValid}: consecutive messages with one role are one
 * turn, concatenated as the API (and {@link mergeConsecutiveRoles}) combine
 * them. A message without blocks adds nothing and doesn't separate turns,
 * as in {@link rebuildEnvelopes}. Nothing else is repaired.
 */
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
  // Empty input → empty output is fine.
  if (envelopes.length === 0) return;

  const refuse = (description: string): never => {
    throw new MembraneNormalizerError(
      description + origin.blame,
      snapshot(input),
      envelopes.map(toProviderMessage),
    );
  };

  // The standalone assertion reaches this phase without the repair pass.
  // Check the same strict-role policy used by reflow before role-filtered
  // pairing loops can accidentally ignore a misplaced block.
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

  // First message must be user (Anthropic requirement). Repair prepends a
  // synthetic user envelope (phase 7); if it still isn't user here, fail.
  if (envelopes[0]!.role !== 'user') {
    refuse(`The first message must have role 'user', got '${envelopes[0]!.role}'.`);
  }

  // Every tool_use in an assistant envelope must have a matching
  // tool_result in the immediately-following user envelope — except
  // tool_uses whose id is in `pending` (the in-flight set the caller
  // declared off-limits for synthesis). After repair, a gap on any other
  // id means phase 4 failed to synthesize.
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
      refuse(
        `tool_use id='${useId}' in ${origin.turn(i)} has no matching tool_result in the user ` +
          `turn right after it, and the id is not in pendingToolCallIds.`,
      );
    }
  }

  // The mirror of the loop above. Anthropic's rule binds in both directions,
  // and for years only the forward half was checked — so an unpaired
  // tool_result (out-of-order append, leading result, duplicate re-append)
  // passed every phase AND this validation on its way to a 400. Phase 3.5
  // repairs all three shapes; this asserts the repair actually held.
  //
  // Membership is not the whole rule: the pairing is one-to-one, so results
  // are COUNTED per id here rather than tested for presence. Counting per
  // envelope is complete: a result answers the call right before it, ids
  // are unique within a turn (assertCallIdsUniquePerTurn), and any result
  // whose id that turn doesn't call already fails the membership check. This
  // assertion stands on its own: it refuses a second result even if some
  // future phase (or a caller of `assertToolPairsValid`) hands it a
  // duplicate the sweep never saw.
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

// ============================================================================
// Helpers
// ============================================================================

/**
 * Read a tool_result's id: Anthropic's `tool_use_id`, the only field the wire
 * pairs by. Phase 1 has already rewritten a `toolUseId`-only result into this
 * form ({@link withCanonicalResultId}); in a caller's history given to
 * {@link assertToolPairsValid}, a result without `tool_use_id` answers
 * nothing, as on the wire.
 */
function getToolUseId(block: ProviderBlock): string | undefined {
  const id = (block as { tool_use_id?: unknown }).tool_use_id;
  return typeof id === 'string' ? id : undefined;
}

/**
 * A tool_result that names its call as `toolUseId`, as Membrane's own content
 * types spell it, leaves phase 1 naming it as `tool_use_id`, the only field
 * the provider pairs by. Pairing it here under the camelCase name alone would
 * send an answer the provider can't see. Results leave the normalizer with
 * the one spelling. A copy; the caller's block is untouched.
 */
function withCanonicalResultId(block: ProviderBlock): ProviderBlock {
  if (block.type !== 'tool_result' || !('toolUseId' in block)) return block;
  const { toolUseId, ...rest } = block as ProviderBlock & { toolUseId?: unknown };
  if (typeof rest.tool_use_id !== 'string' && typeof toolUseId === 'string') {
    return { ...rest, tool_use_id: toolUseId } as ProviderBlock;
  }
  return rest as ProviderBlock;
}

/**
 * Render a tool_result's payload as text for the two repairs that must
 * abandon the tool_result structure (orphan and duplicate textification),
 * keeping everything text can carry:
 *   - string content as it is, and null or undefined content as nothing;
 *   - a text part as its text;
 *   - inline base64 data (an image, a generated image, a base64 document,
 *     audio or video) as a placeholder naming its media type and size: its
 *     bytes mean nothing as text and would cost their whole length in every
 *     later prompt;
 *   - every other part (a url or file source, a text-source document, a part
 *     type this module doesn't know) and any other content as its JSON, the
 *     way text-only tool-result wires already carry it
 *     (`textOnlyToolResultContent` in `providers/utils.ts`).
 *
 * `ToolResult.content` is `string | ToolResultContentBlock[]`, and the array
 * form is a first-class feature — image results ride it. The previous
 * recovery read only the string branch, so every array-shaped payload was
 * replaced by the empty string with no signal of the loss.
 *
 * This deliberately does not reuse `renderResultContentString` from
 * `utils/tool-parser.ts`: that helper takes an internal `ToolResult` whose
 * image blocks carry camelCase `mediaType`, while blocks arriving here are
 * provider-shaped, and a part's media type may be spelled as Anthropic's
 * wire-form `media_type`, as Membrane's `mediaType` (a part a builder passed
 * through unconverted), or as `mimeType` (an MCP-style or generated image).
 * Reading all three spellings is the point; the image placeholder text is
 * kept identical so the two renderings stay recognisable as the same thing
 * to a model.
 */
function renderResultContent(block: ProviderBlock): string {
  const content = (block as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (content === null || content === undefined) return '';
  if (!Array.isArray(content)) return renderResultPart(content);
  return content
    .map(renderResultPart)
    .filter((part) => part !== '')
    .join('\n');
}

function renderResultPart(part: unknown): string {
  if (part === null || part === undefined) return '';
  if (typeof part !== 'object') return JSON.stringify(part);
  const fields = part as Record<string, unknown>;
  if (fields.type === 'text' && typeof fields.text === 'string') return fields.text;
  return inlineDataPlaceholder(fields) ?? JSON.stringify(fields);
}

/**
 * Part types whose inline `data` is binary, and how a placeholder names them:
 * every media type Membrane's content model carries as base64
 * (`isMediaContent`), and a provider-generated image.
 */
const INLINE_DATA_LABELS: ReadonlyMap<unknown, string> = new Map([
  ['image', 'Image'],
  ['generated_image', 'Image'],
  ['document', 'Document'],
  ['audio', 'Audio'],
  ['video', 'Video'],
]);

function inlineDataPlaceholder(part: Record<string, unknown>): string | undefined {
  const label = INLINE_DATA_LABELS.get(part.type);
  if (label === undefined) return undefined;
  const source = part.source as Record<string, unknown> | null | undefined;
  // Wire form keeps the data in `source` (a text source's data is text, not
  // bytes); MCP-style and generated images keep it on the part itself.
  const holder =
    source !== null && typeof source === 'object' && typeof source.data === 'string'
      ? source.type === 'text' ? undefined : source
      : typeof part.data === 'string' ? part : undefined;
  if (holder === undefined) return undefined;
  const data = holder.data as string;
  const mediaType =
    [holder.media_type, holder.mediaType, holder.mimeType].find(
      (value): value is string => typeof value === 'string' && value !== '',
    ) ?? 'unknown';
  const sizeKb = Math.round((data.length * 0.75) / 1024);
  return `[${label}: ${mediaType}, ~${sizeKb}KB]`;
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

/**
 * The first assistant envelope at or after `from` that calls `id`, or the
 * envelope count when none does: the end of the stretch whose results can
 * answer an earlier call with that id.
 */
function nextCallIndex(envelopes: ReadonlyArray<Envelope>, id: string, from: number): number {
  for (let i = from; i < envelopes.length; i++) {
    const env = envelopes[i]!;
    if (env.role === 'assistant' && collectToolUseIds(env).includes(id)) return i;
  }
  return envelopes.length;
}

/**
 * The call envelope a result in envelope `at` belongs to, given its id's call
 * envelopes in order: the nearest one before it, as the wire pairs, or, when
 * the result was written before every one of them, the nearest one after it.
 */
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

/**
 * The caller's messages as a refusal reports them: each message and its
 * block list shallow-copied, so later changes to the caller's arrays don't
 * rewrite the report. A malformed entry, which phase 0 refuses, is kept as
 * it was given.
 */
function snapshot(input: ReadonlyArray<LooseProviderMessage>): LooseProviderMessage[] {
  return input.map((msg) =>
    msg !== null && typeof msg === 'object'
      ? { role: msg.role, content: Array.isArray(msg.content) ? [...msg.content] : msg.content }
      : msg,
  );
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
