import type { ContentBlock } from './content.js';
import type { ToolCall, ToolResult, ToolContext } from './tools.js';
import type { BasicUsage } from './response.js';
import type { PrefillFormatter } from '../formatters/types.js';
import type { ProgressBounds } from '../progress-bounds.js';

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

/** Callback called with the raw provider request before it's sent. */
export type OnRequestCallback = (rawRequest: unknown) => void;

/**
 * Callback called with the raw provider response after each API call.
 * Called for each API request during multi-turn tool execution.
 */
export type OnResponseCallback = (rawResponse: unknown) => void;

export interface StreamOptions {
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  
  /** Request timeout (per provider call, not per turn) */
  timeoutMs?: number;

  /**
   * Anthropic idle deadline after the first SDK event (default: 600000 ms).
   * Nonempty Web response-body bytes, including SSE keepalives, refresh it;
   * other SDK-supported bodies refresh it on SDK events. This does not bound
   * total duration or generation progress.
   */
  idleTimeoutMs?: number;

  /**
   * Progress deadline, per provider call (default: off, as for any value
   * that isn't a positive number of ms). Every parsed provider event renews
   * it (an SDK event, an SSE data frame that parses to an object);
   * keepalives, SSE comments and raw bytes don't, so a connection that stays
   * up while the model sends nothing
   * still ends. On expiry the call aborts as a `TimeoutAbortError` (type
   * `timeout`, aborted reason `'timeout'`). It bounds the wait for the first
   * event too. Time between provider calls, such as tool execution, never
   * counts. A stretch with no parsed event counts as no progress whatever the
   * model is doing: reasoning a provider doesn't stream, while it sends only
   * keepalives, can expire it, so set it above the longest such stretch you
   * expect (Anthropic thinking with `display: "omitted"` sends no deltas
   * while it thinks, which can last minutes). An adapter that streams no
   * events, such as `OpenAIResponsesAdapter` (the Images API), can't renew
   * it, so for it the deadline bounds the whole call.
   */
  progressTimeoutMs?: number;

  /**
   * Progress bounds per provider call (default: off, as for `false`). `true`
   * takes `PROGRESS_BOUNDS` from `@animalabs/membrane/progress-bounds`, and an
   * object takes them with any of its values in their place; a value that
   * isn't a finite number above 0 throws before anything is sent. They
   * apply to a streamed call on an adapter whose stream reports content and
   * thinking blocks' starts (`AnthropicAdapter`, `BedrockAdapter`), and change
   * nothing for any other call. They count from each attempt's send as the
   * adapter reports it (`onSend`), before any credential resolver runs, so a
   * resolver's time, and its one resend after an HTTP 401, count against
   * `beforeContentMs`. From that send:
   * - before content, the call ends `beforeContentMs` after the send, or, if
   *   a thinking block has started, at the later of that and the block's
   *   allowance from its start: the `max_tokens` the request sends at
   *   `thinkTokensPerSecond`, rounded up to a whole second;
   * - once content has begun, it ends `betweenEventsMs` after the last
   *   provider event, or, when that event was a thinking block's start,
   *   after the larger of that and the block's allowance.
   *
   * Content is a delta of any kind (text, thinking, tool input, a signature)
   * or a redacted thinking block. When the request asks for summarized
   * thinking (`display: 'summarized'`), a thinking block's start is only an
   * event and its summary is content. Keepalives never count. So a thinking
   * block that starts at the send, with an allowance shorter than
   * `beforeContentMs` (a `max_tokens` under 5,220 at the defaults), is
   * bounded by `beforeContentMs`. They run beside `progressTimeoutMs`, and beside
   * `AnthropicAdapter`'s first-event and idle deadlines: the first to run
   * out ends the call.
   *
   * On expiry the call ends as for `progressTimeoutMs`, as an aborted stream
   * with reason `'timeout'`, whose `message` names the bound that ran out.
   * An aborted stream isn't a finished answer, and membrane doesn't send the
   * call again: a caller with no retry layer of its own should send a call
   * that ended before any content or thinking block began once more.
   */
  progressBounds?: boolean | Partial<ProgressBounds>;

  /**
   * Whether membrane retries the call's failed provider calls itself. Default
   * true: a provider call that fails with a retryable error before it
   * delivered anything is sent again, in any round, on the `retry` config's
   * schedules. With `false`, membrane retries none of the call's failed
   * requests, whatever the error and whatever the config says: the failure is
   * thrown as it came, with the provider's advice on it (`retryable`, and a
   * stated wait on `retryAfterMs`), and `hooks.onError`, which is asked
   * before each retry, isn't asked. A deadline of the call's own ends it with
   * an `AbortedResponse` whose reason is `'timeout'`, with retries on or off.
   * One other send stays: the one resend with refreshed credentials that an
   * adapter with a credential resolver makes after an HTTP 401.
   */
  retry?: boolean;

  /** Request ID for correlation */
  requestId?: string;
  
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

  /** Called for structured block events (text, thinking, tool_call, tool_result) */
  onBlock?: OnBlockCallback;

  /**
   * Called with raw provider request before each attempt (for logging). A
   * request membrane retries after a failure calls it again, so it counts
   * attempts, not rounds. A credential resolver's resend after an HTTP 401 is
   * part of the attempt it follows, and doesn't call it again.
   */
  onRequest?: OnRequestCallback;

  /** Called with raw provider response after each API call (for logging) */
  onResponse?: OnResponseCallback;

  /** Maximum tool execution depth (default: 10) */
  maxToolDepth?: number;

  /**
   * Cap on AUTOMATIC false-positive stop-sequence resumptions per turn —
   * membrane's own re-streams, not the caller's work. Tool rounds are not
   * counted: maxToolDepth bounds them. Exceeding it ends the turn with
   * stopReason 'round_limit'. Default: 24.
   */
  maxResumptionRounds?: number;

  /** Timeout for each tool execution */
  toolTimeoutMs?: number;

  /**
   * Override the instance's formatter for this request. On an adapter that
   * needs native Responses input (`OpenAIResponsesAPIAdapter` outside
   * subscription mode), an instance formatter that is
   * `OpenAIResponsesFormatter` stays, and the override is ignored.
   */
  formatter?: PrefillFormatter;
}

export interface CompleteOptions {
  /** Abort signal for cancellation */
  signal?: AbortSignal;

  /**
   * Re-issue the request when it ends with `stop_reason: 'refusal'`, up to
   * this many times. Default 0 (off); a value that isn't a finite number of
   * at least 0 asks for none.
   */
  refusalRetries?: number;

  /**
   * Whether membrane retries the call's failed request itself. Default true:
   * a request that fails with a retryable error is sent again on the `retry`
   * config's schedules. With `false`, membrane retries none of the call's
   * failed requests, whatever the error and whatever the config says: the
   * failure is thrown as it came, with the provider's advice on it
   * (`retryable`, and a stated wait on `retryAfterMs`), and `hooks.onError`,
   * which is asked before each retry, isn't asked. Two sends stay: a refusal
   * re-issue, which the call asks for with `refusalRetries`, and the one
   * resend with refreshed credentials that an adapter with a credential
   * resolver makes after an HTTP 401.
   */
  retry?: boolean;

  /** Request timeout */
  timeoutMs?: number;

  /**
   * Progress deadline, per provider call (default: off); see
   * StreamOptions.progressTimeoutMs. A non-streaming call reports no progress
   * until its response arrives, so on most adapters it bounds the whole call.
   * `OpenAIResponsesAPIAdapter` in subscription mode answers `complete()` by
   * streaming, so there its events renew it. On expiry `complete()` throws a
   * `TimeoutAbortError`.
   */
  progressTimeoutMs?: number;

  /** Request ID for correlation */
  requestId?: string;

  /**
   * Called with raw provider request before each attempt (for logging). A
   * request membrane retries after a failure calls it again; a credential
   * resolver's resend after an HTTP 401 doesn't.
   */
  onRequest?: OnRequestCallback;

  /** Called with raw provider response after API call (for logging) */
  onResponse?: OnResponseCallback;

  /**
   * Override the instance's formatter for this request. On an adapter that
   * needs native Responses input (`OpenAIResponsesAPIAdapter` outside
   * subscription mode), an instance formatter that is
   * `OpenAIResponsesFormatter` stays, and the override is ignored.
   */
  formatter?: PrefillFormatter;
}
