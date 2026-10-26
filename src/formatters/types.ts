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

export type { BlockEvent, ChunkMeta, MembraneBlockType, StreamEmission };

/** Block type alias for formatter contexts */
export type BlockType = MembraneBlockType;

export interface FormatterConfig {
  /** What to do with a document block (and, in AnthropicXmlFormatter, an audio
   * block), which the formatter can't send: 'error' throws, 'strip' leaves it
   * out; CompletionsFormatter always strips. An image in a format the API
   * doesn't take becomes a text placeholder either way. Default: 'error' */
  unsupportedMedia?: 'error' | 'strip';

  /** Warn when stripping content. Default: true */
  warnOnStrip?: boolean;
}

export interface BuildOptions {
  /** The caller owns a later complete-request cache-budget check/clamp.
   * Standalone builds check by default. CM-owned markers are always checked
   * here. */
  deferCacheBudgetCheck?: boolean;

  /** How to handle multiple participants */
  participantMode: 'simple' | 'multiuser';

  /**
   * Where to record alterations: indices into `messages` whose non-empty
   * content the build did not carry verbatim (utils/fidelity.ts).
   */
  fidelity?: import('../utils/fidelity.js').FidelityNotes;

  /** Name of the assistant participant */
  assistantParticipant: string;

  /** Name of the human participant (for simple mode) */
  humanParticipant?: string;

  /** Tool definitions to include */
  tools?: ToolDefinition[];

  /**
   * The tool mode Membrane resolved for this request. A formatter that supports
   * both shapes must build for this mode; its constructor-time mode is only the
   * fallback for direct `buildMessages` callers that pass none.
   */
  toolMode?: 'xml' | 'native';

  /** Whether thinking is enabled */
  thinking?: { enabled: boolean; budgetTokens?: number };

  /** System prompt content */
  systemPrompt?: string | ContentBlock[];

  /** Enable prompt caching (Anthropic-specific) */
  promptCaching?: boolean;

  /** See NormalizedRequest.cacheMarkers. */
  cacheMarkers?: 'membrane-system' | 'cm-owned';

  /** Cache TTL for Anthropic prompt caching - '5m' (default) or '1h' for extended */
  cacheTtl?: '5m' | '1h';

  /** Additional stop sequences to include */
  additionalStopSequences?: string[];

  /** Maximum participants to include in stop sequences */
  maxParticipantsForStop?: number;

  /** Context prefix for simulacrum seeding, injected as the first assistant
   * message and marked for caching when promptCaching is on and membrane places
   * the markers (`cacheMarkers: 'membrane-system'`). */
  contextPrefix?: string;

  /**
   * Whether an assistant turn's Anthropic server-tool blocks (web search and
   * the like, kept on zero-width carriers) go back as the blocks themselves.
   * Off, they are left out before cache markers are placed and messages merged.
   * Off by default: a direct caller building for the Anthropic API, such as a
   * token count, passes true to build what membrane sends it, and one building
   * for another wire gets none.
   */
  anthropicServerBlocks?: boolean;

  /** Custom content for the synthetic user message when first message is assistant role.
   *  In prefill formatters: defaults to '<cmd>cat untitled.txt</cmd>' with a CLI simulation
   *  system prompt when no system prompt is configured, or '[Start]' when a system prompt is set.
   *  In native construction: the leading user turn the tool-pair normalizer synthesizes,
   *  '[continuing]' by default and in place of text that is only whitespace. */
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
   * waiting on the result). If an unmatched tool_use's id is in this set,
   * wherever it sits, the normalizer leaves it unmatched and signals
   * `ready: false` instead of injecting a synthetic `[pending]` result.
   * Default: empty (always synthesize). Membrane's own requests pass none.
   */
  pendingToolCallIds?: ReadonlySet<string>;

  /** Telemetry callback for the tool-pair normalizer's events (`NormalizeEvent`). */
  onNormalize?: (event: NormalizeEvent) => void;
}

/**
 * Events emitted by the tool-pair normalizer, through
 * `BuildOptions.onNormalize`: one per block it moves, synthesizes or
 * rewrites, except a result's `toolUseId` renamed `tool_use_id`, which
 * emits none, and `pending_in_flight` for a pending call it leaves
 * unmatched.
 */
export type NormalizeEvent =
  | { kind: 'block_re_roled'; blockType: string; from: 'user' | 'assistant'; to: 'user' | 'assistant' }
  /**
   * A tool_result was moved so it sits in the user envelope immediately
   * following its own tool_use. `fromEnvelope > toEnvelope`: it lived after
   * its cycle and was pulled back into it. `fromEnvelope < toEnvelope`: it had
   * been appended ahead of its own cycle and was pushed down into it.
   */
  | { kind: 'tool_result_hoisted'; toolUseId: string; fromEnvelope: number; toEnvelope: number }
  | { kind: 'interloper_deferred'; blockType: string; fromEnvelope: number }
  | { kind: 'synthetic_pending_result'; toolUseId: string; reason: 'trailing' | 'mid_stream' }
  /**
   * A tool_result whose tool_use id appears nowhere in the message list was
   * rewritten as a text block. `recoveredChars` is the length of the payload
   * carried across — array-form content is flattened, so a zero here means
   * the result genuinely had no recoverable text, never that structure was
   * dropped on the floor.
   */
  | { kind: 'orphan_tool_result_textified'; toolUseId: string; recoveredChars: number }
  /**
   * A tool_result whose tool_use exists but whose own cycle is already
   * satisfied (a duplicate re-append after a cancellation or stream restart)
   * was rewritten as a text block. It could not be relocated without
   * displacing the real result, and dropping it would lose content.
   *
   * `reason` names which duplicate shape the producer emitted, since the two
   * point at different producer bugs:
   *   - `'cycle_closed'`      → the copy is outside its paired envelope and
   *                             its own cycle already holds a result, so it
   *                             had nowhere to be relocated to.
   *   - `'duplicate_in_cycle'`→ the copy arrived inside its own cycle's user
   *                             envelope, behind a result that already
   *                             answered that call. Pairing is one-to-one, so
   *                             the first result consumes the id and every
   *                             later copy of it is textified here.
   */
  | {
      kind: 'stray_tool_result_textified';
      toolUseId: string;
      fromEnvelope: number;
      recoveredChars: number;
      reason: 'cycle_closed' | 'duplicate_in_cycle';
    }
  | { kind: 'pending_in_flight'; toolUseId: string }
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
       * `leadingBlockTypes` is the block-type list of the now-second
       * envelope (i.e. what came right after the synthesized user turn),
       * useful for classifying re-roling causes (e.g. `['thinking']`
       * vs. `['text', 'tool_use']`).
       */
      kind: 'leading_user_synthesized';
      originalFirstRole: 'user' | 'assistant';
      leadingBlockTypes: string[];
    };

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
   * Offset into the turn's accumulated assistant text at which the CURRENT
   * last message of `messages` begins. Zero (or absent) for an ordinary
   * build: the whole accumulated document is the trailing assistant prefill.
   *
   * A split-turn image injection persists its three messages here and moves
   * this watermark to the image seam, so later continuations replace only
   * the trailing assistant message and never re-flatten the pre-image text
   * over the user turn that carries the image.
   */
  accumulatedBaseOffset?: number;

  /**
   * `false` only when the tool-pair normalizer left an unmatched tool_use
   * because its id is in `pendingToolCallIds`, wherever it sits — i.e. the
   * caller is mid-cycle and the request should not be shipped yet. Callers
   * that don't pass `pendingToolCallIds` will never see `false` from the
   * built-in formatters. Membrane refuses a build reporting `false` with
   * `MembraneNotReadyError`.
   */
  ready?: boolean;
}

export interface ProviderMessage {
  /** 'system' only for a mid-conversation system message (SystemChangeContent), which a formatter that `rendersSystemChanges` builds. */
  role: 'user' | 'assistant' | 'system';
  content: unknown;
}

/** A user or assistant turn: what the tool-pair normalizer and the role merge take and give. */
export type ProviderTurnMessage = ProviderMessage & { role: 'user' | 'assistant' };

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
   */
  isInsideBlock(): boolean;

  /**
   * Get current nesting depths for each block type.
   */
  getDepths(): { functionCalls: number; functionResults: number; thinking: number };

  /**
   * Reset streaming state for a new API iteration.
   * Keeps accumulated text and block depth state, but resets
   * per-stream tracking so processChunk works correctly.
   */
  resetForNewIteration(): void;
}

/** Source context when parsing visible text between native thinking blocks. */
export interface ContentParseContext {
  /** Complete visible response text, excluding provider thinking blocks. */
  readonly visibleText: string;
  /** Start of the current content span in visibleText, in String.slice units. */
  readonly offset: number;
}

export interface PrefillFormatter {
  /** Formatter name for identification */
  readonly name: string;

  /**
   * Whether this formatter builds prefill transcripts (vs native pass-through):
   * a fact about the formatter, not about one build. AnthropicXmlFormatter
   * says true and still builds a native conversation in native mode; whether
   * a given build ends in a prefill is its `BuildResult.assistantPrefill`.
   * Membrane doesn't read this flag.
   */
  readonly usesPrefill: boolean;

  /**
   * Whether this formatter can carry provider-native tool definitions —
   * i.e. whether `buildMessages` can populate `BuildResult.nativeTools`.
   * Membrane builds native tools by default wherever this holds, and XML only
   * for a formatter that can't or when the caller asks for it.
   */
  readonly supportsNativeTools: boolean;

  /** Whether this formatter can encode tool definitions/results in an XML protocol. */
  readonly supportsXmlTools: boolean;

  /** Participant prefix template for native tool requests. Uses {name}; defaults to '{name}: '. */
  readonly nameFormat?: string;

  /**
   * True when `buildMessages` records, in `BuildOptions.fidelity`, every
   * consumer message whose non-empty content it did not carry verbatim (see
   * utils/fidelity.ts). A formatter that doesn't declare this leaves a
   * round's fidelity unknown.
   */
  readonly reportsAlterations?: boolean;

  /**
   * True when `buildMessages` sends a message holding `system_change` blocks
   * (SystemChangeContent) as a mid-conversation `role: 'system'` message.
   * Membrane refuses, before sending, a request carrying one unless both this
   * and the adapter's `sendsSystemChanges` hold.
   */
  readonly rendersSystemChanges?: boolean;

  /**
   * The tool mode this formatter instance was explicitly constructed with, if
   * any. Membrane falls back to it when the request names no `toolMode`, so a
   * formatter that can build either shape carries its caller's choice here.
   * Left undefined by formatters that build exactly one shape.
   */
  readonly configuredToolMode?: 'xml' | 'native';

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

  /**
   * Create a stream parser for this format.
   * Parser tracks state across chunks (e.g., XML depth, token boundaries).
   */
  createStreamParser(): StreamParser;

  /**
   * Parse tool calls from accumulated content.
   * Returns empty array if no tool calls detected.
   *
   * `tools` carries the round's declared schemas. XML-style formatters use them
   * to parse parameter values by declared type (a `string` parameter keeps its
   * text, less one layout newline directly after its opening tag and one
   * directly before its closing tag) instead of guessing; formatters whose
   * provider returns typed arguments ignore it.
   */
  parseToolCalls(content: string, tools?: ToolDefinition[]): ToolCall[];

  /**
   * Check if content indicates tool use.
   */
  hasToolUse(content: string): boolean;

  /**
   * Parse content blocks from accumulated response.
   * Extracts text, thinking, tool_use blocks, etc.
   *
   * `tools` is used exactly as in {@link PrefillFormatter.parseToolCalls}.
   * When context is supplied, content is a span of the complete visible text.
   * Preserve whole-response operations (such as prefix trimming) using that
   * context. Custom parsers and decorators must honor/forward it rather than
   * treating an internal span as a fresh response. Calls without context keep
   * whole-response semantics.
   */
  parseContentBlocks(content: string, tools?: ToolDefinition[], context?: ContentParseContext): ContentBlock[];
}
