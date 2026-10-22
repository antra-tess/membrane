/**
 * Response types for membrane
 */

import type { ContentBlock } from './content.js';
import type { ToolCall, ToolResult } from './tools.js';

// ============================================================================
// Stop Reason
// ============================================================================

export type StopReason =
  | 'end_turn'       // Natural completion
  | 'max_tokens'     // Hit token limit
  | 'stop_sequence'  // Hit stop sequence
  | 'tool_use'       // Stopped for tool use
  | 'pause_turn'     // Provider paused a long-running turn; the caller is
                     // expected to resume it (Anthropic pause_turn)
  | 'refusal'        // Content refused by safety
  | 'abort'          // Request was aborted
  | 'no_progress'    // Stall guard ended the turn (issue #39): consecutive
                     // automatic resumptions re-sent context without advancing
  | 'round_limit';   // Resumption round cap ended the turn: the turn kept
                     // resuming (with progress) past maxResumptionRounds

// ============================================================================
// Usage Information
// ============================================================================

export interface BasicUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * What ONE priced unit of work cost — a turn, or the discarded attempts summed
 * together. Held apart from `DetailedUsage` so the discarded-spend record can
 * carry every token field without also inheriting `discardedAttempts`, which
 * would let the type describe discarded spend nested inside discarded spend:
 * a shape nothing produces and nothing could read sensibly.
 */
export interface CallUsage extends BasicUsage {
  /** Tokens used for cache creation */
  cacheCreationTokens?: number;

  /** Tokens read from cache */
  cacheReadTokens?: number;

  /**
   * Thinking/reasoning tokens the provider reported separately from its
   * visible-output count, already INCLUDED in `outputTokens` (they are billed
   * at the output rate). Surfaced so a caller can attribute spend to thinking;
   * summing it with `outputTokens` would double-count. Gemini's
   * `thoughtsTokenCount` is the current source.
   */
  thinkingTokens?: number;

  /** Estimated cost breakdown */
  estimatedCost?: CostBreakdown;
}

export interface DetailedUsage extends CallUsage {
  /**
   * Spend on provider calls whose output was thrown away — today, refusal
   * retries. Those attempts were completed, billed HTTP calls; the response
   * describes only the attempt that STANDS, so without this the real cost of
   * a turn is invisible. Absent when nothing was discarded.
   *
   * Reported on `details.usage` only: the top-level `usage` stays the
   * surviving attempt's, so existing consumers keep their meaning.
   */
  discardedAttempts?: DiscardedAttemptsUsage;
}

export interface DiscardedAttemptsUsage extends CallUsage {
  /** How many billed-but-abandoned provider calls are summed here. */
  attempts: number;
}

type Assert<TCondition extends true> = TCondition;

/**
 * Erased at build; checked by `tsc --noEmit`, which covers src/ and not the
 * test suite — so this is where a type-level guarantee can actually fail the
 * build. Re-widening the discarded record to `DetailedUsage` reintroduces
 * discarded-spend-inside-discarded-spend and turns this line red.
 */
type DiscardedSpendDoesNotNest = Assert<
  'discardedAttempts' extends keyof DiscardedAttemptsUsage ? false : true
>;

/**
 * One provider round of a turn: the model that served it and what that round
 * alone used and cost. `usage.estimatedCost` here is priced at THIS round's
 * model, which is why the rounds can be summed into a turn total that a
 * multi-model turn's bill actually matches.
 */
export interface TurnRoundUsage {
  /** Model the provider named as having served this round; the requested id when it named none. */
  model: string;

  /** This round's own tokens and its own cost. */
  usage: DetailedUsage;
}

export interface CostBreakdown {
  input: number;
  output: number;
  cacheWrite?: number;
  cacheRead?: number;
  total: number;
  currency: string;

  /**
   * ISO date the rates behind this breakdown were last verified against the
   * provider's published prices, when the pricing source records one. Unset
   * means the source vouches for no date, NOT that the numbers are current.
   */
  pricingAsOf?: string;
}

// ============================================================================
// Stop Information
// ============================================================================

export interface StopInfo {
  reason: StopReason;
  
  /** Which stop sequence triggered (if stop_sequence) */
  triggeredSequence?: string;
  
  /** Whether output was truncated */
  wasTruncated: boolean;

  /**
   * The provider's own stop token, verbatim, as the adapter reports it in
   * ProviderResponse.providerStopReason. When the adapter reports none, its
   * stopReason if membrane doesn't map that token, so the token isn't lost
   * behind the end_turn it becomes; that may be the adapter's own word rather
   * than the provider's. Omitted when the adapter reports no providerStopReason
   * and its stopReason is a token membrane maps. A null or empty value counts
   * as none in either field.
   * This can differ from the normalized reason (for example, OpenAI's length,
   * or a provider's token beside a stop sequence membrane found itself).
   */
  providerReason?: string;

  /**
   * XML tool mode: the turn ended with a tool block still open — a
   * `<function_calls>` opener with no closer, or text cut mid-tag. The loop
   * does not resume on a length stop, so this is the shape a max_tokens
   * truncation leaves behind. A consumer persisting the turn must not write it
   * back bare: on the next round the stale opener would be read as part of that
   * round's block.
   */
  unclosedToolBlock?: boolean;
}

// ============================================================================
// Model Information
// ============================================================================

export interface ModelInfo {
  /** Model ID that was requested */
  requested: string;
  
  /** Model ID that actually ran (may differ due to routing/fallback). On a
   *  multi-round turn this is the model that served the LAST round; see
   *  {@link perRound} for the whole roster. */
  actual: string;
  
  /** Provider that served the request */
  provider: string;

  /**
   * Every provider round of this turn in order, each naming the model that
   * served it and what that round alone used and cost — the audit trail behind
   * `usage.estimatedCost`, which is their sum. A routed turn can change models
   * mid-turn (OpenRouter re-picks a provider per call), so `actual` alone
   * cannot say what was billed at which rate.
   *
   * Set on the streaming/tool-loop paths, which are the ones that sum. Unset
   * on `complete()`, which makes exactly one call: `actual` is the whole story
   * there.
   */
  perRound?: TurnRoundUsage[];
}

// ============================================================================
// Timing Information
// ============================================================================

export interface TimingInfo {
  /** Total request duration */
  totalDurationMs: number;
  
  /** Time to first token (streaming only) */
  timeToFirstTokenMs?: number;
  
  /** Tokens per second (streaming only) */
  tokensPerSecond?: number;
  
  /**
   * Provider calls this turn actually cost: retries plus, on the streaming
   * paths, every continuation round and refusal re-issue. A stitched
   * multi-call turn used to report 1 here, indistinguishable in durable
   * logs from a single-shot one.
   */
  attempts: number;

  /**
   * Continuation rounds that made up the turn — tool rounds and automatic
   * resumptions. 1 for a single-round turn; lower than `attempts` whenever a
   * round was re-issued. Streaming paths only.
   */
  rounds?: number;

  /** Delay between retries */
  retryDelaysMs?: number[];
}

// ============================================================================
// Cache Information
// ============================================================================

export interface CacheInfo {
  /** Cache markers in the last logical request, using the adapter's
   * cacheReceiptBasis. The default counts post-hook semantic markers;
   * wire-request adapters count their final onRequest body. If an opted-in
   * adapter omits that observation, the adapter-input count is the fallback. */
  markersInRequest: number;
  
  /** Tokens created in cache */
  tokensCreated: number;
  
  /** Tokens read from cache */
  tokensRead: number;
  
  /** Cache hit ratio (0-1) */
  hitRatio: number;
}

// ============================================================================
// Response Details
// ============================================================================

export interface ResponseDetails {
  stop: StopInfo;
  usage: DetailedUsage;
  timing: TimingInfo;
  model: ModelInfo;
  cache: CacheInfo;

  /**
   * Rounds where the provider broke its own response contract and membrane
   * noticed, one entry per occurrence, in round order. Absent when there
   * were none.
   */
  anomalies?: ResponseAnomaly[];
}

// ============================================================================
// Provider anomalies
// ============================================================================

/**
 * A round the provider ended with a literal `stop_reason: end_turn` while its
 * content held client tool calls. A round with no provider stop token (an
 * adapter that reports none, or an OpenAI-family server that sends no
 * `finish_reason`) is not this case: it runs nothing, as before. The provider
 * contract is
 * that a response carrying a tool call stops with `tool_use`; a caller that
 * gates on the stop reason runs nothing and the turn ends with the calls
 * unanswered, silently.
 *
 * When every call in the round is complete (its block stopped and its input
 * parsed to an object), membrane treats the round as `tool_use`: the calls
 * run (or are returned to the caller) exactly as for a `tool_use` stop, and
 * `treatedAsToolUse` is true. When any call is incomplete the round keeps its
 * reported stop, nothing runs, and `treatedAsToolUse` is false. Either way
 * `providerStopReason` here keeps the round's own token. `details.stop`
 * describes the response's final round: from `complete()` that is this one,
 * while a loop that ran the calls goes on to a later round unless its tool
 * depth limit ends it first.
 */
export interface ToolUseWithEndTurnAnomaly {
  kind: 'tool_use_with_end_turn';

  /** 0-based round index within this call (the index round reports use). */
  round: number;

  /** The provider's stop token: always `end_turn`, the only token that qualifies. */
  providerStopReason: 'end_turn';

  /** The round's tool calls, in content order. */
  toolNames: string[];
  toolUseIds: string[];

  /** Whether membrane treated the round as a `tool_use` stop. */
  treatedAsToolUse: boolean;

  /** Model that served the round. */
  model: string;

  /** The provider's response id (Anthropic message id), when it sent one. */
  messageId?: string;

  /** The provider's request id (Anthropic `request-id` header), when known. */
  requestId?: string;
}

export type ResponseAnomaly = ToolUseWithEndTurnAnomaly;

// ============================================================================
// Raw Access
// ============================================================================

export interface RawAccess {
  /** Exact request body sent to provider */
  request: unknown;
  
  /** Exact response received from provider */
  response: unknown;
  
  /** Response headers */
  headers?: Record<string, string>;
}

// ============================================================================
// Normalized Response
// ============================================================================

export interface NormalizedResponse {
  /** Response content blocks (parsed/structured) */
  content: ContentBlock[];

  /**
   * Raw assistant output text including all XML.
   * Use this for building subsequent turn context (verbatim prefill).
   */
  rawAssistantText: string;

  /**
   * Tool calls extracted from the response.
   * Convenience accessor - these are also in content as tool_use blocks.
   */
  toolCalls: ToolCall[];

  /**
   * Tool results that were executed during this response.
   * Empty if no tools were called or tool execution was disabled.
   */
  toolResults: ToolResult[];

  /** Why generation stopped */
  stopReason: StopReason;

  /** Basic usage (always available) */
  usage: BasicUsage;

  /** Detailed response information */
  details: ResponseDetails;

  /** Raw request/response for debugging */
  raw: RawAccess;
}

// ============================================================================
// Aborted Response
// ============================================================================

export interface AbortedResponse {
  aborted: true;

  /** Content received before abort */
  partialContent?: ContentBlock[];

  /** Tokens consumed before abort */
  partialUsage?: BasicUsage;

  /** Why it was aborted */
  reason: 'user' | 'timeout' | 'error';

  /**
   * Raw assistant text accumulated before abort.
   * Use for displaying partial output or as prefill to continue.
   */
  rawAssistantText?: string;

  /**
   * Tool calls that were executed before abort.
   */
  toolCalls?: ToolCall[];

  /**
   * Tool results received before abort.
   */
  toolResults?: ToolResult[];
}

export function isAbortedResponse(
  response: NormalizedResponse | AbortedResponse
): response is AbortedResponse {
  return 'aborted' in response && response.aborted === true;
}
