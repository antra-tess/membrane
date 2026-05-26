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

  /**
   * IDs of tool_use blocks the caller knows are currently in-flight
   * (e.g. a yielding stream that has emitted the tool_use but is still
   * waiting on the result). If a trailing unmatched tool_use's id is in
   * this set, the normalizer signals `ready: false` instead of injecting
   * a synthetic `[pending]` result. Default: empty (always synthesize).
   */
  pendingToolCallIds?: ReadonlySet<string>;

  /**
   * Telemetry callback fired once per normalization action. Lets the
   * framework count/log normalizations without coupling Membrane to a
   * specific logger. See `NormalizeEvent` for the event shapes.
   */
  onNormalize?: (event: NormalizeEvent) => void;
}

/**
 * Events emitted by the tool-pair normalizer. Surfaced through
 * `BuildOptions.onNormalize`. Every normalization action emits one
 * event; treat non-zero counts as a producer-side bug to investigate.
 */
export type NormalizeEvent =
  | { kind: 'block_re_roled'; blockType: string; from: 'user' | 'assistant'; to: 'user' | 'assistant' }
  | { kind: 'tool_result_hoisted'; toolUseId: string; fromEnvelope: number; toEnvelope: number }
  | { kind: 'interloper_deferred'; blockType: string; fromEnvelope: number }
  | { kind: 'synthetic_pending_result'; toolUseId: string; reason: 'trailing' | 'mid_stream' }
  | { kind: 'orphan_tool_result_textified'; toolUseId: string }
  | { kind: 'pending_in_flight'; toolUseId: string }
  | { kind: 'cache_suppressed_for_synthetic'; envelopeIndex: number }
  | {
      /**
       * Fires when the first envelope after re-roling is assistant and a
       * synthetic `[continuing]` user envelope had to be prepended to
       * satisfy Anthropic's `messages[0].role === 'user'` requirement.
       *
       * `originalFirstRole` distinguishes the two causes a consumer might
       * want to alert on separately:
       *   - `'user'`     → re-roling artifact (a strict-role block lived
       *                    under a user-role message and was moved to a
       *                    new assistant envelope). Usually benign.
       *   - `'assistant'`→ producer shipped an assistant-first messages
       *                    list. Real producer bug worth investigating.
       *
       * (Empty input never reaches this event: `rebuildEnvelopes([])`
       * returns `[]`, and the phase-7 gate requires a non-empty envelope
       * list. So `input[0]` is always defined when this fires.)
       *
       * `leadingBlockTypes` is the block-type list of the now-second
       * envelope (i.e. what came right after the synthesized user turn),
       * useful for classifying re-roling causes (e.g. `['thinking']`
       * vs. `['text', 'tool_use']`).
       */
      kind: 'leading_user_synthesized';
      originalFirstRole: 'user' | 'assistant';
      leadingBlockTypes: string[];
    };

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

  /**
   * `false` only when the tool-pair normalizer detected a trailing
   * unmatched tool_use whose id is in `pendingToolCallIds` — i.e. the
   * caller (yielding stream) is mid-cycle and the request should not be
   * shipped yet. Callers that don't pass `pendingToolCallIds` will never
   * see `false` here.
   */
  ready?: boolean;
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
   * Get current nesting depths for each block type.
   * Used to compare against prefill baseline for false-positive detection.
   */
  getDepths(): { functionCalls: number; functionResults: number; thinking: number };

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
