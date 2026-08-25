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

export interface DetailedUsage extends BasicUsage {
  /** Tokens used for cache creation */
  cacheCreationTokens?: number;
  
  /** Tokens read from cache */
  cacheReadTokens?: number;
  
  /** Tokens used for thinking/reasoning */
  thinkingTokens?: number;

  /**
   * Reasoning tokens the provider reported separately from its visible-output
   * count, already INCLUDED in `outputTokens` (they are billed at the output
   * rate). Surfaced so a caller can attribute spend to reasoning; summing it
   * with `outputTokens` would double-count. Gemini's `thoughtsTokenCount` is
   * the current source.
   */
  reasoningTokens?: number;
  
  /** Estimated cost breakdown */
  estimatedCost?: CostBreakdown;
}

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
  
  /** Number of retry attempts */
  attempts: number;
  
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
