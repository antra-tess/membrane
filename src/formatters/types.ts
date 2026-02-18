/**
 * Prefill Formatter Types
 *
 * Interfaces for pluggable prefill formatting and parsing.
 */

import type {
  NormalizedMessage,
  ContentBlock,
  ToolDefinition,
  ToolCall,
  ToolResult,
  BlockEvent,
} from '../types/index.js';
import type {
  ChunkMeta,
  MembraneBlockType,
} from '../types/streaming.js';
import type { StreamEmission, ProcessChunkResult } from '../utils/stream-parser.js';

// Re-export types used by formatters
export type { BlockEvent, ChunkMeta, MembraneBlockType, StreamEmission };

/** Block type alias for formatter contexts */
export type BlockType = MembraneBlockType;

// ============================================================================
// Configuration
// ============================================================================

export interface FormatterConfig {
  /** How to handle unsupported media (images, etc.). Default: 'error' */
  unsupportedMedia?: 'error' | 'strip';

  /** Warn when stripping content. Default: true */
  warnOnStrip?: boolean;
}

export interface BuildOptions {
  /** How to handle multiple participants */
  participantMode: 'simple' | 'multiuser';

  /** Name of the assistant participant */
  assistantParticipant: string;

  /** Name of the human participant (for simple mode) */
  humanParticipant?: string;

  /** Tool definitions to include */
  tools?: ToolDefinition[];

  /** Whether thinking is enabled */
  thinking?: { enabled: boolean; budgetTokens?: number };

  /** System prompt content */
  systemPrompt?: string | ContentBlock[];

  /** Enable prompt caching (Anthropic-specific) */
  promptCaching?: boolean;

  /** Cache TTL for Anthropic prompt caching - '5m' (default) or '1h' for extended */
  cacheTtl?: '5m' | '1h';

  /** Additional stop sequences to include */
  additionalStopSequences?: string[];

  /** Maximum participants to include in stop sequences */
  maxParticipantsForStop?: number;

  /** Context prefix for simulacrum seeding (injected as first cached assistant message) */
  contextPrefix?: string;

  /** Custom content for the synthetic user message when first message is assistant role.
   *  In prefill formatters: defaults to '<cmd>cat untitled.txt</cmd>' with a CLI simulation
   *  system prompt when no system prompt is configured, or '[Start]' when a system prompt is set. */
  prefillUserMessage?: string;

  /**
   * Function to check if a message has a cache marker.
   * When provided, content before the marked message gets cache_control.
   * This enables per-message cache boundaries in the conversation.
   */
  hasCacheMarker?: (message: NormalizedMessage, index: number) => boolean;
}

// ============================================================================
// Build Result
// ============================================================================

export interface BuildResult {
  /** Messages in provider format */
  messages: ProviderMessage[];

  /** System content (if separate from messages) */
  systemContent?: unknown;

  /** Assistant prefill content (appended to last assistant message) */
  assistantPrefill?: string;

  /** Stop sequences for this format */
  stopSequences: string[];

  /** Tool definitions for API (if using native tools) */
  nativeTools?: unknown[];

  /** Number of cache control markers applied (for Anthropic prompt caching) */
  cacheMarkersApplied?: number;
}

export interface ProviderMessage {
  role: 'user' | 'assistant';
  content: unknown;
}

// ============================================================================
// Stream Parser
// ============================================================================

/** Parse result from processing a chunk */
export type ParseResult = ProcessChunkResult;

export interface StreamParser {
  /**
   * Process a chunk of streamed content.
   * Returns parsed events (text, blocks, etc.)
   */
  processChunk(chunk: string): ParseResult;

  /**
   * Flush any buffered content at end of stream.
   */
  flush(): ParseResult;

  /**
   * Get full accumulated content.
   */
  getAccumulated(): string;

  /**
   * Reset parser state completely.
   */
  reset(): void;

  /**
   * Push content without emitting (for prefill initialization).
   */
  push(content: string): void;

  /**
   * Get current block type being parsed.
   */
  getCurrentBlockType(): BlockType;

  /**
   * Get current block index.
   */
  getBlockIndex(): number;

  /**
   * Increment block index (for external block tracking).
   */
  incrementBlockIndex(): void;

  /**
   * Check if parser is inside a block (e.g., unclosed XML tag).
   * Used for false-positive stop sequence detection.
   */
  isInsideBlock(): boolean;

  /**
   * Reset streaming state for a new API iteration.
   * Keeps accumulated text and block depth state, but resets
   * per-stream tracking so processChunk works correctly.
   */
  resetForNewIteration(): void;
}

// ============================================================================
// Prefill Formatter Interface
// ============================================================================

export interface PrefillFormatter {
  /** Formatter name for identification */
  readonly name: string;

  /** Whether this formatter uses prefill (vs native pass-through) */
  readonly usesPrefill: boolean;

  // ==========================================================================
  // REQUEST BUILDING
  // ==========================================================================

  /**
   * Transform normalized messages into provider-ready format.
   */
  buildMessages(
    messages: NormalizedMessage[],
    options: BuildOptions
  ): BuildResult;

  /**
   * Format tool results for continuation request.
   * Called when injecting tool results back into the conversation.
   */
  formatToolResults(
    results: ToolResult[],
    options?: { thinking?: boolean }
  ): string;

  // ==========================================================================
  // RESPONSE PARSING
  // ==========================================================================

  /**
   * Create a stream parser for this format.
   * Parser tracks state across chunks (e.g., XML depth, token boundaries).
   */
  createStreamParser(): StreamParser;

  /**
   * Parse tool calls from accumulated content.
   * Returns empty array if no tool calls detected.
   */
  parseToolCalls(content: string): ToolCall[];

  /**
   * Check if content indicates tool use.
   * Used to determine stop reason.
   */
  hasToolUse(content: string): boolean;

  /**
   * Parse content blocks from accumulated response.
   * Extracts text, thinking, tool_use blocks, etc.
   */
  parseContentBlocks(content: string): ContentBlock[];
}
