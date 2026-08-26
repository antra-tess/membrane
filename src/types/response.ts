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

  /** Tokens used for thinking/reasoning */
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

export interface CostBreakdown {
  input: number;
  output: number;
  cacheWrite?: number;
  cacheRead?: number;
  total: number;
  currency: string;
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
  
  /** Model ID that actually ran (may differ due to routing/fallback) */
  actual: string;
  
  /** Provider that served the request */
  provider: string;
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
  /** Number of cache markers in request */
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
}

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
