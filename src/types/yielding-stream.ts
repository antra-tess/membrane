/**
 * Yielding stream types for membrane
 *
 * This module defines the interface for a streaming API that yields control
 * back to the caller when tool calls are detected, rather than handling them
 * internally via callbacks.
 *
 * @see agent-framework/docs/yielding-stream-architecture.md
 */

import type { ContentBlock } from './content.js';
import type { NormalizedMessage } from './message.js';
import type { ToolCall, ToolResult, ToolContext } from './tools.js';
import type { DetailedUsage, NormalizedResponse, StopReason } from './response.js';
import type { ChunkMeta, BlockEvent } from './streaming.js';

// ============================================================================
// Stream Events
// ============================================================================

/**
 * Token/chunk event - raw text as it arrives from the LLM.
 */
export interface TokensEvent {
  type: 'tokens';
  content: string;
  meta: ChunkMeta;
}

/**
 * Block event - structural block start/complete notifications.
 */
export interface StreamBlockEvent {
  type: 'block';
  event: BlockEvent;
}

/**
 * Tool calls event - LLM has requested tool execution.
 * The stream pauses here until results are provided via provideToolResults().
 */
export interface ToolCallsEvent {
  type: 'tool-calls';
  calls: ToolCall[];
  context: ToolContext;
}

/**
 * Usage update event - token counts updated.
 *
 * On the yielding paths it is emitted once per provider round whose response
 * stands (after any refusal retries), and then carries `round`: that round's
 * own report. Streams created with `emitUsage: false` emit no usage events,
 * so no round reports either. A round whose response arrives after the
 * stream was cancelled isn't reported: the stream ended at its aborted event.
 * Nor is a round the cancel aborts in flight, since no response arrives.
 */
export interface UsageEvent {
  type: 'usage';
  /** Turn total so far (cumulative across rounds). */
  usage: DetailedUsage;
  /** The round that just stood (yielding paths). */
  round?: RoundReport;
}

/**
 * A round's token counts, each present only when the provider reported it (a
 * reported 0 is 0). Counts only: accounting's estimates (estimatedCost) are
 * not part of the evidence, since a default-derived count would price to a
 * claimed zero.
 */
export interface RoundUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  /** Thinking tokens, already inside outputTokens (see DetailedUsage.thinkingTokens). */
  thinkingTokens?: number;
}

/**
 * One provider round whose response stands, as its producer saw it.
 *
 * Coordinates: `altered.messages` indexes the `NormalizedRequest.messages`
 * the consumer submitted. Injected messages are addressed as `[batch, index]`:
 * a batch is one non-empty `injectedMessages` array supplied to
 * `provideToolResults`, numbered from 0 in supply order within the stream;
 * `index` is the position within that array. Every batch still retained in
 * the round's request is reported, not only the newest.
 */
export interface RoundReport {
  /** Zero-based index of this returned round (refusal re-issues within a round are not rounds). */
  index: number;
  /**
   * Mapped stop reason of the attempt that stands. 'refusal' means the
   * provider refused the round (its own stop reason), which is unrelated to
   * tool invocations a parser declined.
   */
  stopReason: StopReason;
  /**
   * This round's own usage, only what the provider reported: a count it did
   * not report is absent, not 0 (even where accounting keeps a 0 default),
   * and a reported 0 is 0. An adapter that declares its cache convention has
   * its counts in membrane's one convention: `inputTokens` excludes the cached
   * span, so a cache-inclusive provider's input count is restated without its
   * cache reads and writes (`normalizeUsageToCacheExcluded`), and
   * `inputTokens + cacheCreationTokens + cacheReadTokens` is the prompt the
   * provider counted. An adapter whose convention is `'unknown'` passes its
   * counts through as the provider gave them.
   */
  usage: RoundUsage;
  /**
   * The newest injected batch, and how many of its supplied positions, as an
   * ordered prefix, this round's request accounts for. With established
   * fidelity, each of those was carried verbatim unless `altered.injected`
   * names it. A message whose tool blocks were stripped is named there even
   * when nothing else of it was left to send, while one supplied empty
   * carried nothing and is not.
   * The native path accounts for the whole batch (`applied` is its supplied
   * size); the XML prefill path carries none (`applied` is 0).
   */
  injectedBatch?: { batch: number; applied: number };
  /**
   * Consumer messages this round's request did not carry verbatim (known
   * alterations). Where a path sends a provider-native raw form in place of
   * the fields it stands in for (on the OpenAI Responses formatter, a
   * block's `rawItem` and a message's `openaiResponsesItems`; in the
   * Responses API adapter, a `redacted_thinking` block's reasoning
   * `rawItem`; on the XML prefill path, `rawXml`), "verbatim" means that raw
   * form: content a consumer edited without dropping its raw form isn't
   * named, because the edit never reaches the wire (utils/fidelity.ts). A
   * zero-width carrier (`''` text holding an object `rawItem`) that a path
   * leaves out is named. Membrane's own messages (each assistant round, and
   * the tool_result envelopes it builds from `provideToolResults`) aren't the
   * consumer's and have no address here, so their alterations aren't
   * reported and don't touch `fidelity`, which speaks for the consumer's
   * messages.
   */
  altered: { messages: number[]; injected: Array<[number, number]> };
  /**
   * 'established' when every step of the build and transport reports its
   * alterations and none was unattributable; 'unknown' otherwise (an
   * uninstrumented path, an image opt-in shedding replaced, a beforeRequest
   * hook that changed either of its arguments, or an earlier round's hook
   * that changed one in place). With 'unknown', an empty `altered` proves
   * nothing.
   */
  fidelity: 'established' | 'unknown';
  /**
   * The signed thinking this round's request sent back that failed the
   * provider's binding check, as the provider reported it: Anthropic's
   * `input_transformations`, which come back when the request carries the
   * binding (`thinking.blockBinding`'s doc names the requests that don't).
   * Absent when the response carried no report; both lists empty when it
   * reported that nothing failed. This is the provider's account, beside
   * `altered`, which is membrane's: a dropped block was carried on the
   * request verbatim and removed before the model saw it. Entries of a type
   * membrane doesn't know are left out.
   */
  thinking?: {
    /** Blocks the provider removed before the model saw them (`thinking_dropped`). */
    dropped: ThinkingBindingEntry[];
    /**
     * Blocks that failed the check and were shown to the model anyway,
     * because the check isn't enforced for this request
     * (`thinking_mismatch_allowed`). Where it is enforced they would have been
     * dropped, or the request refused. The provider lists these block by
     * block while a drop can take more, so they are a lower bound on what
     * enforcement would remove.
     */
    mismatchAllowed: ThinkingBindingEntry[];
  };
}

/**
 * One signed thinking block that failed a provider's binding check
 * (RoundReport.thinking).
 */
export interface ThinkingBindingEntry {
  /**
   * Which check it failed, as the provider names it:
   * 'prefix_binding_mismatch' (the conversation before it differs from the
   * one it was minted in), 'model_binding_mismatch',
   * 'organization_binding_mismatch' or 'end_user_binding_mismatch'.
   */
  reason: string;
  /**
   * Where it was in the request the provider received,
   * `messages.{i}.content.{j}`. Membrane's build merges and adds messages,
   * so these are the request's coordinates, not the consumer's.
   */
  path: string;
  /** The consumer message it came from, in `altered.messages`' coordinates, when membrane can say. */
  message?: number;
  /** The injected message it came from, in `altered.injected`'s coordinates. */
  injected?: [number, number];
  /** The earlier round of this stream whose content it was (`ToolContext.roundContent`). */
  round?: number;
  /** Its index in that message's content (or that round's), when exactly one block there is it. */
  block?: number;
}

/**
 * Complete event - inference cycle finished successfully.
 */
export interface CompleteEvent {
  type: 'complete';
  response: NormalizedResponse;
}

/**
 * Error event - something went wrong. When a provider call failed, the error
 * is a MembraneError.
 */
export interface ErrorEvent {
  type: 'error';
  error: Error;
}

/**
 * Retrying event — the provider ended the attempt with
 * `stop_reason: 'refusal'` and membrane is re-issuing it (opt-in via
 * `refusalRetries`).
 *
 * **The consumer MUST discard what the refused attempt emitted**: the
 * `tokens` and `block` events of the round it belongs to, since the stream
 * began or since the `tool-calls` event whose results began that round, and
 * any partially built assistant content from them. They belong to an attempt
 * that no longer exists, and a fresh sequence follows. Earlier rounds stand:
 * the call's text (`rawAssistantText`) keeps what they produced. Consumers
 * that have already shown the refused attempt's tokens to a human (a TUI, a
 * chat surface) must retract or overwrite them.
 *
 * Why this exists: near the classifier threshold a refusal is probabilistic
 * rather than a property of the payload — the same bytes pass and refuse
 * minutes apart — so re-asking is the cheapest correct response. Retrying
 * silently would corrupt any consumer that already rendered the discarded
 * attempt, which is why it is opt-in and announced rather than invisible.
 */
export interface RetryingEvent {
  type: 'retrying';
  /** 1-based index of the retry about to be issued. */
  attempt: number;
  /** Configured maximum number of retries. */
  maxAttempts: number;
  /** Always 'refusal' today; widened only if other retryable stops appear. */
  reason: 'refusal';
  /** Provider's refusal category when it supplies one (e.g. 'cyber'). */
  category?: string;
}

/**
 * Aborted event: the stream ended before the turn finished. It carries what
 * the turn had recorded by then: the text so far (`rawAssistantText`, and as
 * blocks in `partialContent`) and the tool rounds run (`toolCalls`,
 * `toolResults`). A round whose tools were still running shows its calls with
 * no results.
 */
export interface AbortedEvent {
  type: 'aborted';
  reason: 'user' | 'timeout' | 'error';
  partialContent?: ContentBlock[];
  rawAssistantText?: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
}

/**
 * Union of all stream events.
 */
export type StreamEvent =
  | TokensEvent
  | StreamBlockEvent
  | RetryingEvent
  | ToolCallsEvent
  | UsageEvent
  | CompleteEvent
  | ErrorEvent
  | AbortedEvent;

// ============================================================================
// Yielding Stream Interface
// ============================================================================

/**
 * A streaming inference that yields control to the caller for tool execution.
 *
 * Usage:
 * ```typescript
 * const stream = membrane.streamYielding(request, options);
 *
 * for await (const event of stream) {
 *   switch (event.type) {
 *     case 'tokens':
 *       process.stdout.write(event.content);
 *       break;
 *     case 'tool-calls':
 *       const results = await executeTools(event.calls);
 *       stream.provideToolResults(results);
 *       break;
 *     case 'complete':
 *       console.log('Done:', event.response);
 *       break;
 *     case 'error':
 *       console.error('Error:', event.error);
 *       break;
 *   }
 * }
 * ```
 */
/**
 * A user-side message injected into the conversation between tool rounds.
 *
 * This is how a consumer lets the model see events that arrived while the
 * turn was in flight (e.g. a chat reply landing mid-way through a long
 * tool-using turn): pass it alongside the tool results and the next
 * inference round's request includes it as a user message AFTER the
 * tool_result envelope.
 *
 * Placement guarantee: injected messages always land after the round's
 * tool_results (the wire normalizer additionally enforces results-first
 * ordering inside a merged envelope), so they never break the
 * tool_use → tool_result adjacency or signed-thinking constraints.
 *
 * Shape: NormalizedMessage minus cacheBreakpoint (breakpoints are the
 * request compiler's concern), with `participant` optional — it defaults to
 * the generic user participant. Non-assistant participants get the standard
 * "Name: " text prefix when rendered to the provider. Content must be
 * user-side blocks only (text/image); tool blocks are stripped with a
 * warning. On the native path, which carries injected messages, round
 * reports name such a message altered at the position it was supplied at,
 * even if nothing else of it was left to send; the XML prefill path carries
 * none (`RoundReport.injectedBatch.applied` is 0). NOTE: a
 * participant equal to the request's assistantParticipant would render as
 * an ASSISTANT turn (a prefill) — callers should not inject messages named
 * as the assistant.
 */
export type InjectedMessage =
  Omit<NormalizedMessage, 'participant' | 'cacheBreakpoint'> & {
    participant?: string;
  };

/**
 * Options for provideToolResults().
 */
export interface ProvideToolResultsOptions {
  /**
   * Messages that arrived while the turn was in flight, to be appended to
   * the conversation after this round's tool_result envelope so the NEXT
   * inference round sees them.
   *
   * Supported in native tool mode (Anthropic Messages, OpenAI Responses,
   * OpenRouter). The XML prefill path currently ignores these (the
   * continuation is an assistant prefill, not a message array) — callers
   * on XML-mode models should deliver mid-turn events on the next turn
   * instead.
   */
  injectedMessages?: InjectedMessage[];
}

export interface YieldingStream extends AsyncIterable<StreamEvent> {
  /**
   * Provide tool results after receiving a 'tool-calls' event.
   * The stream will resume and continue generating.
   *
   * @param results - Results for the tool calls (must match call IDs)
   * @param options - Optionally inject mid-turn user messages into the
   *   next round (see ProvideToolResultsOptions.injectedMessages)
   * @throws Error if called when not waiting for tool results
   */
  provideToolResults(results: ToolResult[], options?: ProvideToolResultsOptions): void;

  /**
   * Cancel the stream. Any in-flight requests will be aborted.
   * The iterator will yield an 'aborted' event and then complete, with
   * nothing after it. The event carries what the turn had recorded when
   * cancel() was called (see AbortedEvent). Results passed to
   * provideToolResults() just before it aren't recorded yet, so their calls
   * show no results. If the stream has already queued or delivered its
   * complete, error or aborted event, cancel() adds no event of its own, and
   * that event stays the stream's last.
   */
  cancel(): void;

  /**
   * Check if the stream is currently waiting for tool results.
   */
  readonly isWaitingForTools: boolean;

  /**
   * Get the IDs of tool calls we're waiting for results for.
   * Empty if not waiting for tools.
   */
  readonly pendingToolCallIds: string[];

  /**
   * Current tool execution depth (0 = first inference, 1 = after first tool round, etc.)
   */
  readonly toolDepth: number;
}

// ============================================================================
// Yielding Stream Options
// ============================================================================

/**
 * Options for streamYielding().
 * Simpler than StreamOptions since tool execution is handled externally.
 */
export interface YieldingStreamOptions {
  /** Abort signal for cancellation */
  signal?: AbortSignal;

  /** Request timeout (per API call, not total) */
  timeoutMs?: number;

  /**
   * The liveness bound, per provider call (default: 180000 ms): no byte of
   * the response, keepalive pings included, for this long ends the call with
   * an `aborted` event whose reason is `'timeout'`, carrying what arrived, in
   * any phase: the connection is taken as gone. It's armed by the first sign
   * of the transport an adapter can see and report: `AnthropicAdapter`
   * reports each chunk of the response body, `BedrockAdapter` each keepalive
   * ping. Any provider event renews it too. A positive number of ms sets it,
   * `Infinity` included, and `null` counts as unset; 0 turns it off, as any
   * other value does (a negative number, NaN).
   */
  idleTimeoutMs?: number;

  /**
   * The progress deadline, per provider call. On expiry the stream ends with
   * an `aborted` event whose reason is `'timeout'`, carrying what arrived.
   *
   * Unset (the default, `null` included), it's bounded per phase on a
   * stream whose adapter reports its phases (`AnthropicAdapter`,
   * `BedrockAdapter`; see SendReport):
   * - before the first content delta, 400 s from the send;
   * - a silent think (thinking whose display isn't `'summarized'`, which
   *   sends nothing while it thinks) is allowed its request's whole
   *   `max_tokens` at 35 tokens a second from its start, and before content
   *   the call ends only once both that and the 400 s have run out;
   * - after content, 180 s between provider events, or the think's allowance
   *   after a silent think's start when that's longer.
   * On any other adapter, whose stream can be silent until its answer comes
   * (reasoning a provider doesn't stream, or an adapter that streams no
   * events, such as `OpenAIResponsesAdapter`), the bound is 400 s plus
   * `max_tokens` at 35 tokens a second, from the send and again from each
   * provider event. Every parsed provider event counts (an SDK event, an SSE
   * data frame that parses to an object); keepalives, SSE comments and raw
   * bytes don't, so a connection that stays up while the model sends nothing
   * still ends. Time between provider calls, such as waiting for
   * `provideToolResults()`, never counts.
   *
   * A positive number of ms, `Infinity` included, replaces these with one
   * flat bound: that long from the send and from each provider event,
   * whatever the phase. Set it above the longest silence you expect, since a
   * silent think can outlast it. 0 turns the progress deadline off, as any
   * other value does (a negative number, NaN).
   */
  progressTimeoutMs?: number;

  /** Request ID for correlation/logging */
  requestId?: string;

  /**
   * Re-issue an attempt that ends with `stop_reason: 'refusal'`, up to this
   * many times. Default 0 (off); a value that isn't a finite number of at
   * least 0 asks for none. Native tool mode only: in XML tool mode it's
   * ignored, with a warning, and the refusal stands.
   *
   * Enabling it means the stream can emit `RetryingEvent` — **consumers MUST
   * handle it and discard what the refused attempt emitted** (its round's
   * tokens and blocks; see RetryingEvent), or two attempts will be
   * concatenated. That is why it is off by default and why
   * turning it on is a per-call decision by a consumer that has been updated.
   *
   * Rationale: near the content-policy threshold a refusal is probabilistic,
   * not a property of the payload — identical bytes pass and refuse minutes
   * apart. Re-asking is cheaper and less invasive than rewriting the
   * conversation, and the replay is cache-warm, so only the discarded output
   * tokens are real spend.
   */
  refusalRetries?: number;

  /**
   * Whether membrane retries the stream's failed provider calls itself.
   * Default true: a call that fails with a retryable error before it
   * delivered anything is sent again, in any round, on the `retry` config's
   * schedules. With `false`, membrane retries none of the call's failed
   * requests, whatever the error and whatever the config says: the failure
   * ends the stream with an `error` event, carrying the provider's advice
   * (`retryable`, and a stated wait on `retryAfterMs`), and `hooks.onError`,
   * which is asked before each retry, isn't asked. For a caller whose own
   * layer retries. Two sends stay: a refusal re-issue, which a call in native
   * tool mode asks for with `refusalRetries`, and the one resend with
   * refreshed credentials that an adapter with a credential resolver makes
   * after an HTTP 401.
   */
  retry?: boolean;

  /**
   * Maximum tool execution depth. Default: unlimited.
   *
   * The yielding stream's caller (typically an agent framework) is expected
   * to budget its own work, so we don't impose a per-stream cap by default.
   * Pass a non-negative integer to enforce one. `-1` is accepted as an
   * explicit "unlimited" sentinel; any other negative value is taken at
   * face value as the cap (which would terminate the stream immediately),
   * so don't compute caps as `userCap - N` without bounds-checking.
   */
  maxToolDepth?: number;

  /**
   * Cap on AUTOMATIC false-positive stop-sequence resumptions per turn —
   * membrane's own re-streams, not the caller's tool work. Tool rounds are
   * deliberately NOT counted: this path's uncapped-by-default tool-loop
   * contract stands (the caller budgets its own work via maxToolDepth).
   * What this bounds is membrane's own failure surface — how many times a
   * turn may re-send its full context on membrane's initiative; an
   * unlimited resumption bound is how the 43-round Ash spin happened
   * (issue #39). Exceeding it ends the turn with stopReason 'round_limit'.
   * Default: 24. `-1` for unlimited, at your own risk.
   */
  maxResumptionRounds?: number;

  /**
   * Whether to emit 'tokens' events.
   * Set to false if you only care about tool calls and final response.
   * Default: true
   */
  emitTokens?: boolean;

  /**
   * Whether to emit 'block' events.
   * Default: true
   */
  emitBlocks?: boolean;

  /**
   * Whether to emit 'usage' events, and with them the per-round reports
   * (`UsageEvent.round`). Default: true
   */
  emitUsage?: boolean;
}

// ============================================================================
// Type Guards
// ============================================================================

export function isTokensEvent(event: StreamEvent): event is TokensEvent {
  return event.type === 'tokens';
}

export function isToolCallsEvent(event: StreamEvent): event is ToolCallsEvent {
  return event.type === 'tool-calls';
}

export function isCompleteEvent(event: StreamEvent): event is CompleteEvent {
  return event.type === 'complete';
}

export function isErrorEvent(event: StreamEvent): event is ErrorEvent {
  return event.type === 'error';
}

export function isAbortedEvent(event: StreamEvent): event is AbortedEvent {
  return event.type === 'aborted';
}

/**
 * Check if the stream has terminated (complete, error, or aborted).
 */
export function isTerminalEvent(event: StreamEvent): event is CompleteEvent | ErrorEvent | AbortedEvent {
  return event.type === 'complete' || event.type === 'error' || event.type === 'aborted';
}
