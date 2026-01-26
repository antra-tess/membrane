/**
 * Streaming types for membrane
 */

import type { ContentBlock } from './content.js';
import type { ToolCall, ToolResult, ToolContext } from './tools.js';
import type { BasicUsage } from './response.js';

// ============================================================================
// Membrane Block Types (logical content regions, not API types)
// ============================================================================

/**
 * Membrane block types - logical content regions at the context level.
 * These are abstract structures, not tied to any wire format.
 */
export type MembraneBlockType = 'text' | 'thinking' | 'tool_call' | 'tool_result';

/**
 * Membrane block - a logical content region with full content.
 * Used in block_complete events.
 */
export interface MembraneBlock {
  type: MembraneBlockType;
  content?: string;           // Full content (for text, thinking, tool_result)
  toolId?: string;            // For tool_call / tool_result
  toolName?: string;          // For tool_call
  input?: Record<string, unknown>;  // For tool_call (parsed parameters)
  isError?: boolean;          // For tool_result
}

// ============================================================================
// Chunk Metadata
// ============================================================================

/**
 * Chunk type - alias for MembraneBlockType for clarity in chunk contexts
 */
export type ChunkType = MembraneBlockType;

/**
 * Metadata about a streaming chunk.
 * Provides context about which block the chunk belongs to and its visibility.
 */
export interface ChunkMeta {
  /** Which membrane block type this chunk belongs to */
  type: ChunkType;

  /** Convenience flag for TTS/display filtering - false for thinking/tool content */
  visible: boolean;

  /** Which content block this belongs to (0-indexed) */
  blockIndex: number;

  /** Tool nesting depth (for nested tool calls) */
  depth?: number;

  /** For tool_call chunks - which part of the tool call is streaming */
  toolCallPart?: 'name' | 'id' | 'input';

  /** Tool use ID (for tool_call / tool_result chunks) */
  toolId?: string;

  /** Tool name (for tool_call chunks, once known) */
  toolName?: string;
}

// ============================================================================
// Block Events
// ============================================================================

/**
 * Block start event - signals a new block is starting.
 * Fired before any onChunk calls for that block.
 */
export interface BlockStartEvent {
  event: 'block_start';
  index: number;
  block: { type: MembraneBlockType };
}

/**
 * Block complete event - signals a block is done.
 * Includes full accumulated content. Fired after all onChunk calls for that block.
 */
export interface BlockCompleteEvent {
  event: 'block_complete';
  index: number;
  block: MembraneBlock;
}

/**
 * Block event - either start or complete.
 * Note: No block_delta - streaming content is provided via onChunk with metadata.
 */
export type BlockEvent = BlockStartEvent | BlockCompleteEvent;

/**
 * @deprecated Use BlockEvent instead. BlockDelta is no longer used;
 * streaming content is provided via onChunk with ChunkMeta.
 */
export type BlockDelta =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_input'; partialJson: string };

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
 * Callback for text chunks - called immediately as tokens arrive.
 * Includes metadata about block type, visibility, and position.
 */
export type OnChunkCallback = (chunk: string, meta: ChunkMeta) => void;

/**
 * @deprecated Use onBlock + onChunk with ChunkMeta instead.
 * This callback is superseded by:
 * - onBlock for structured block_start/block_complete events
 * - onChunk with ChunkMeta for streaming content with block context
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
export type OnBlockCallback = (event: BlockEvent) => void;

/**
 * Callback called with the raw provider request before it's sent.
 * Useful for logging/debugging.
 */
export type OnRequestCallback = (rawRequest: unknown) => void;

/**
 * Callback called with the raw provider response after each API call.
 * Called for each API request during multi-turn tool execution.
 * Useful for logging/debugging.
 */
export type OnResponseCallback = (rawResponse: unknown) => void;

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

  /** Called with raw provider request before sending (for logging) */
  onRequest?: OnRequestCallback;

  /** Called with raw provider response after each API call (for logging) */
  onResponse?: OnResponseCallback;

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

  /** Called with raw provider request before sending (for logging) */
  onRequest?: OnRequestCallback;
}
