/**
 * Response types for membrane
 */

import type { ContentBlock } from './content.js';

// ============================================================================
// Stop Reason
// ============================================================================

export type StopReason =
  | 'end_turn'       // Natural completion
  | 'max_tokens'     // Hit token limit
  | 'stop_sequence'  // Hit stop sequence
  | 'tool_use'       // Stopped for tool use
  | 'refusal'        // Content refused by safety
  | 'abort';         // Request was aborted

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
  
  /** Estimated cost breakdown */
  estimatedCost?: CostBreakdown;
}

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
  /** Response content blocks */
  content: ContentBlock[];
  
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
}

export function isAbortedResponse(
  response: NormalizedResponse | AbortedResponse
): response is AbortedResponse {
  return 'aborted' in response && response.aborted === true;
}
