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
 */
export interface UsageEvent {
  type: 'usage';
  usage: DetailedUsage;
}

/**
 * Complete event - inference cycle finished successfully.
 */
export interface CompleteEvent {
  type: 'complete';
  response: NormalizedResponse;
}

/**
 * Error event - something went wrong.
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
 * **The consumer MUST discard everything this call has emitted so far**:
 * `tokens`, `block`, and any partially built assistant content belong to an
 * attempt that no longer exists. A fresh sequence follows. Consumers that
 * have already shown those tokens to a human (a TUI, a chat surface) must
 * retract or overwrite them.
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
 * Aborted event - stream was cancelled.
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
 * warning. NOTE: a participant equal to the request's assistantParticipant
 * would render as an ASSISTANT turn (a prefill) — callers should not inject
 * messages named as the assistant.
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
   * The iterator will yield an 'aborted' event and then complete.
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

  /** Abort if no SSE event arrives within this many ms (default: 120000) */
  idleTimeoutMs?: number;

  /** Request ID for correlation/logging */
  requestId?: string;

  /**
   * Re-issue an attempt that ends with `stop_reason: 'refusal'`, up to this
   * many times. Default 0 (off).
   *
   * Enabling it means the stream can emit `RetryingEvent` — **consumers MUST
   * handle it and discard what they have received for the call**, or two
   * attempts will be concatenated. That is why it is off by default and why
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
   * Whether to emit 'usage' events.
   * Default: true
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
