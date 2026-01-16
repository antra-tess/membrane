/**
 * Streaming types for membrane
 */

import type { ContentBlock } from './content.js';
import type { ToolCall, ToolResult, ToolContext } from './tools.js';
import type { BasicUsage } from './response.js';

// Re-export block event types from stream-parser
export type { BlockEvent, BlockDelta } from '../utils/stream-parser.js';

// ============================================================================
// Stream State
// ============================================================================

export interface StreamState {
  /** Accumulated text output */
  accumulated: string;
  
  /** Current content blocks (updated during stream) */
  contentBlocks: ContentBlock[];
  
  /** Current tool execution depth */
  toolDepth: number;
  
  /** Tool calls executed so far */
  toolCallsExecuted: ToolCall[];
  
  /** Tokens generated so far (estimate) */
  tokensGenerated: number;
  
  /** Abort function */
  abort: () => void;
}

// ============================================================================
// Stream Callbacks
// ============================================================================

/**
 * Callback for text chunks - called immediately as tokens arrive
 */
export type OnChunkCallback = (chunk: string) => void;

/**
 * Callback for content block updates (thinking, images)
 */
export type OnContentBlockCallback = (index: number, block: ContentBlock) => void;

/**
 * Callback for tool execution
 * Return tool results to continue; throw to abort
 */
export type OnToolCallsCallback = (
  calls: ToolCall[],
  context: ToolContext
) => Promise<ToolResult[]>;

/**
 * Callback for pre-tool content notification
 * Called with content that appeared before tool calls
 */
export type OnPreToolContentCallback = (content: string) => Promise<void> | void;

/**
 * Callback for usage updates during streaming
 */
export type OnUsageCallback = (usage: BasicUsage) => void;

/**
 * Callback for structured block events during streaming.
 * Provides parsed block information as it's detected.
 */
export type OnBlockCallback = (event: import('../utils/stream-parser.js').BlockEvent) => void;

// ============================================================================
// Stream Options
// ============================================================================

export interface StreamOptions {
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  
  /** Request timeout */
  timeoutMs?: number;
  
  /** Request ID for correlation */
  requestId?: string;
  
  // ---- Callbacks ----
  
  /** Called immediately for each text chunk */
  onChunk?: OnChunkCallback;
  
  /** Called when content blocks update (thinking, images) */
  onContentBlockUpdate?: OnContentBlockCallback;
  
  /** Called when tool calls are detected; return results to continue */
  onToolCalls?: OnToolCallsCallback;
  
  /** Called with content before tool calls (for UI preview) */
  onPreToolContent?: OnPreToolContentCallback;
  
  /** Called with usage updates */
  onUsage?: OnUsageCallback;

  /** Called for structured block events (thinking, tool_use, tool_result) */
  onBlock?: OnBlockCallback;

  // ---- Tool Loop Config ----

  /** Maximum tool execution depth (default: 10) */
  maxToolDepth?: number;

  /** Timeout for each tool execution */
  toolTimeoutMs?: number;
}

// ============================================================================
// Non-Streaming Options
// ============================================================================

export interface CompleteOptions {
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  
  /** Request timeout */
  timeoutMs?: number;
  
  /** Request ID for correlation */
  requestId?: string;
}
