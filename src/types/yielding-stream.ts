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
import type { ToolCall, ToolResult, ToolContext } from './tools.js';
import type { BasicUsage, NormalizedResponse, StopReason } from './response.js';
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
  usage: BasicUsage;
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
export interface YieldingStream extends AsyncIterable<StreamEvent> {
  /**
   * Provide tool results after receiving a 'tool-calls' event.
   * The stream will resume and continue generating.
   *
   * @param results - Results for the tool calls (must match call IDs)
   * @throws Error if called when not waiting for tool results
   */
  provideToolResults(results: ToolResult[]): void;

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

  /** Request ID for correlation/logging */
  requestId?: string;

  /** Maximum tool execution depth (default: 10) */
  maxToolDepth?: number;

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
