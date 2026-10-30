import type { NormalizedMessage } from './message.js';
import type { ToolDefinition } from './tools.js';

export interface GenerationConfig {
  /** Model identifier */
  model: string;
  
  /** Maximum tokens to generate */
  maxTokens: number;
  
  /** Temperature. Its range is the provider's (Anthropic's is 0-1, OpenAI's 0-2); membrane doesn't clamp it. */
  temperature?: number;
  
  /** Top P nucleus sampling */
  topP?: number;
  
  /** Top K sampling (provider-specific) */
  topK?: number;
  
  /** Presence penalty (provider-specific) */
  presencePenalty?: number;
  
  /** Frequency penalty (provider-specific) */
  frequencyPenalty?: number;

  /** Repetition penalty — multiplicative (vLLM/HuggingFace style, typically 1.0-1.2) */
  repetitionPenalty?: number;

  /** Enable thinking/reasoning mode */
  thinking?: {
    enabled: boolean;
    budgetTokens?: number;
    /** Thinking type for the API: 'enabled' (default, explicit budget) or 'adaptive' (model-managed) */
    type?: 'enabled' | 'adaptive';
    /**
     * Controls how thinking content is returned: 'summarized' (readable summary)
     * or 'omitted' (empty thinking field, signature only). Models like Fable 5 /
     * Opus 4.7+ default to 'omitted' — set 'summarized' to receive thinking text.
     *
     * 'updates' (Anthropic's `thinking-display-updates-2026-08-18` beta, which
     * the Anthropic and Bedrock adapters add when the body they send carries
     * it) hides reasoning as 'omitted' does, but returns the progress notes
     * the model writes between tool calls ("found X, checking Y next") as
     * text. On Fable 5 and 5.1 and Mythos 5.1 those notes come back as
     * `thinking` blocks, and on Opus 5.5 and Sonnet 5.5 those longer than a
     * sentence or two do, each signed and placed just before the `tool_use`
     * it introduces, where earlier models returned them as `text`. Under
     * 'omitted' their text is empty, so a long tool
     * loop looks silent. Under 'updates' every thinking block with non-empty
     * text is such a note; there may be none in a response. The text is a
     * summary of the note: `output_tokens` bills the full note, and the
     * model reads the full note when the block is sent back unchanged.
     * 'summarized' returns these notes too, mixed with the reasoning
     * summaries. A response cut off soon after a tool call can end in one
     * whose text is exactly
     * `This part of the response was interrupted before it finished.`
     *
     * Fable and Mythos models get no thinking config for 'summarized' or
     * 'omitted' alone (see `blockBinding`), but they get
     * `{ type: 'adaptive', display: 'updates' }` for 'updates'. Anthropic
     * documents the value for the models above, on every platform; what
     * other models do with it is untested.
     */
    display?: 'summarized' | 'omitted' | 'updates';
    /**
     * What the API does with a signed thinking block this request sends back
     * when the conversation before it differs from the one it was minted in
     * (Anthropic's block binding). 'error' fails the request with a 400;
     * 'drop_block' removes the failing blocks and the request proceeds,
     * without the reasoning they held. A response then reports the blocks
     * that failed a binding check: on yielding streams as
     * `RoundReport.thinking`, and elsewhere as the provider's own
     * `input_transformations` on the raw response.
     *
     * Setting it sends `thinking.block_binding`, with the
     * `thinking-binding-controls-2026-08-01` beta (the Anthropic and Bedrock
     * adapters), inside the thinking config membrane builds: thinking enabled
     * with a budget that fits under `maxTokens`, adaptive thinking, or a model
     * whose thinking is always on. Such a model's thinking config is otherwise
     * left out; with this set it gets `{ type: 'adaptive', block_binding }`,
     * plus `display` when that is set. Fable 5 and Fable 5.1 accept the
     * binding config, and with `display: 'summarized'` beside it return signed
     * thinking with its text. Mythos hasn't been tried, and the family has
     * refused thinking configs with a 400 before, so for a Mythos model setting
     * it may fail every request. Bedrock's acceptance of the beta hasn't been
     * tried either. The Bedrock adapter sends this beta whenever the body
     * carries the binding, and legacy 3.x models there refuse unknown beta
     * flags, so an older thinking-capable model on Bedrock may refuse the
     * request with a 400.
     *
     * A request that carries no thinking config carries no binding, and the
     * account's default applies there: thinking disabled, an enabled budget
     * that can't fit under `maxTokens` (membrane then leaves thinking out),
     * and a request the XML or completions formatter builds to end in an
     * assistant prefill, including an XML continuation, which never sends
     * thinking. Fable and Mythos are the exception to the first two: they
     * think whatever the config says, so they carry the binding whenever it's
     * asked for. Sending no thinking config doesn't mean a reply holds no
     * thinking that binds: Opus 5.5 and 5, Sonnet 5.5 and 5, and Haiku 5.5
     * each return a signed thinking block to a request with no thinking
     * config, and Opus 5.5, Sonnet 5.5 and Haiku 5.5 bind it. To carry the
     * binding to such a model in a request that doesn't end in an assistant
     * prefill, set this and ask for adaptive thinking (`enabled: true`,
     * `type: 'adaptive'`, and `display: 'omitted'`, so the block comes back
     * signature only, as it does with no config). Those three accept that
     * config with the binding in place of no config, and read the same cached
     * prefix. As with any thinking config other than `disabled`, the Anthropic
     * adapter then sends none of the caller's `temperature` or `topK`, and no
     * `topP` below 0.95; to these three it sends no `topP` at all, since it
     * strips sampling parameters for them whatever the config.
     * The Bedrock adapter sends `temperature` 1 and the caller's `topK` beside
     * it; whether Bedrock takes that hasn't been tried. A `thinking` object
     * passed through `providerParams` replaces the one membrane builds,
     * binding included, so give `block_binding` inside it; the beta follows
     * the body that is sent. Left unset, nothing is sent, and the account's
     * default applies, which isn't the same on every account.
     */
    blockBinding?: { prefixMismatchBehavior: 'error' | 'drop_block' };
  };
  
  /** Image generation config (Gemini) */
  imageGeneration?: {
    enabled: boolean;
    modalities: ('TEXT' | 'IMAGE')[];
    aspectRatio?: '1:1' | '16:9' | '9:16' | '4:3' | '3:4';
    imageSize?: 'SMALL' | 'MEDIUM' | 'LARGE';
  };
}

export type StopSequenceStrategy = 
  | 'none'              // Trust API stop sequences only
  | 'post-facto'        // Disable API sequences, check in code
  | 'resume-on-unclosed'; // Resume if stopped inside XML block

export interface StopSequenceConfig {
  /** Stop sequences to use */
  sequences: string[];
  
  /** Strategy for handling false positives */
  strategy?: StopSequenceStrategy;
  
  /** Max resumptions for 'resume-on-unclosed' strategy */
  maxResumptions?: number;
  
  /** Additional sequences only checked post-facto (not sent to API) */
  postFactoOnly?: string[];
}

export interface RequestOptions {
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  
  /** Request timeout in milliseconds */
  timeoutMs?: number;
  
  /** Request ID for correlation */
  requestId?: string;
  
  /** Tags for filtering/attribution */
  tags?: Record<string, string>;
}

export type ToolMode = 
  | 'xml'     // XML injection in prefill mode
  | 'native'  // Native API tool support (Anthropic tool_use, OpenAI tool_calls)
  | 'auto';   // Automatically choose based on provider/mode

export interface NormalizedRequest {
  /** Cache-layout receipt: the default basis is the post-format/post-hook,
   * post-clamp ProviderRequest, retaining semantic markers on APIs without
   * cache_control. Adapters declaring cacheReceiptBasis: 'wire-request' use
   * their first final onRequest observation instead (Anthropic and Bedrock).
   * Emitted once per complete attempt or logical streaming round, not again
   * for internal streaming refusal retries. Observability only; never sent
   * to providers. A wire-request adapter must report onRequest to emit it. */
  onCacheWireReceipt?: (receipt: import('../cache-wire-receipt.js').CacheWireReceipt) => void;
  /**
   * Explicitly own the loss of old inline images when the serialized request
   * exceeds the API byte cap: oldest images are replaced with loud
   * placeholders (error-logged). Without this flag an oversize request FAILS
   * LOUDLY before the API call.
   */
  shedOversizeImages?: boolean;
  /** Conversation messages */
  messages: NormalizedMessage[];
  
  /**
   * System prompt, as text. Under `cacheMarkers: 'cm-owned'`, a caller that
   * wants it marked for Anthropic's prompt cache marks the provider request's
   * `system` in a `beforeRequest` hook, as docs/formatters.md describes.
   */
  system?: string;
  
  /** Generation configuration */
  config: GenerationConfig;
  
  /** Tool definitions */
  tools?: ToolDefinition[];
  
  /** Tool execution mode (default: 'auto') */
  toolMode?: ToolMode;
  
  /** Stop sequence configuration */
  stopSequences?: StopSequenceConfig | string[];
  
  /**
   * Maximum participants to include in auto-generated stop sequences (prefill mode).
   * Set to 0 to disable participant-based stop sequences (allows frags/quotes).
   * If not specified, uses membrane config default (10).
   */
  maxParticipantsForStop?: number;
  
  /**
   * Enable prompt caching (Anthropic/Bedrock). Defaults to true.
   * Set to false to stop membrane adding cache_control markers; a
   * `cache_control` a content block carries is still sent.
   */
  promptCaching?: boolean;

  /** Marker ownership policy. `cm-owned` disables every formatter-generated
   * system/context-prefix marker, so a request carries only the markers its
   * caller placed, such as its message breakpoints and a marker a
   * `beforeRequest` hook adds, unless the caller sets `floatingCacheMarker:
   * true`: then the native tool loop's later requests add the floating
   * marker, after that hook. */
  cacheMarkers?: 'membrane-system' | 'cm-owned';

  /**
   * Cache TTL for Anthropic prompt caching.
   * '5m' (default) = 5 minute TTL
   * '1h' = 1 hour TTL (extended caching)
   */
  cacheTtl?: '5m' | '1h';

  /**
   * Float a trailing cache_control marker onto the newest message when the
   * native tool loop rebuilds the request between tool-execution rounds, so
   * the growing tool-round suffix caches incrementally: each round writes its
   * delta and cache-reads everything before it. Under the default
   * `cacheMarkers: 'membrane-system'` it is placed only from the request's
   * residual breakpoint budget: the marker is withheld when upstream markers
   * already occupy all 4 Anthropic cache_control slots, so upstream breakpoints
   * are never displaced or stripped. Under `cacheMarkers: 'cm-owned'` it is
   * placed only when this is true, and then after the `beforeRequest` hook,
   * once the caller's markers have passed the check a first request's markers
   * get, and when they occupy all 4 slots it takes the earliest message
   * marker's slot: within one
   * tool loop membrane changes nothing before the turn's opening, so that
   * marker's prefix lies inside the newest marker's. It never takes a system
   * or tools marker, which may serve a prefix other requests share, so a
   * request whose 4 markers all sit there gets no float. With two or more
   * slots free, the message before the round's calling turn is marked too;
   * with one, a round long enough to pass the provider's backward cache search
   * writes again what it could have read. Under either policy no float is
   * placed on a call whose normalization repair rewrote the prefix, or on a
   * tool result through an adapter that declares `sendsToolResultCacheMarkers:
   * false`; and the float goes at 1h only when `cacheTtl` is 1h and every
   * marker the request still carries is 1h, since a longer TTL may not follow
   * a shorter one (a marker with no `ttl` counts as 5m).
   * Defaults to true under `membrane-system` (when promptCaching is enabled),
   * and to false under `cm-owned`. Set false for context
   * strategies whose request prefix churns between rounds, where a trailing
   * marker would be pure cache-write cost.
   */
  floatingCacheMarker?: boolean;

  /**
   * Context prefix for simulacrum seeding.
   * Injected as first assistant message (before conversation history).
   * Cached when promptCaching is enabled and `cacheMarkers` isn't 'cm-owned'.
   */
  contextPrefix?: string;

  /**
   * Custom content for the synthetic user message injected when the first
   * provider message is an assistant turn (required by Claude Messages API).
   * Defaults to '[Start]' in prefill construction (or a CLI-simulation command
   * when no system prompt is set) and to '[continuing]' in native construction,
   * which also uses '[continuing]' in place of text that is only whitespace.
   */
  prefillUserMessage?: string;

  /**
   * Participant name that maps to the 'assistant' role.
   * Messages with this participant are formatted as assistant turns.
   * Default: 'Claude'
   */
  assistantParticipant?: string;

  /**
   * Control streaming behavior when calling membrane.stream().
   * - true or undefined: use streaming (default)
   * - false: force non-streaming — membrane.stream() will internally use
   *   complete() and synthesize streaming callbacks from the full response.
   */
  streaming?: boolean;

  /** Provider-specific parameters (pass-through) */
  providerParams?: Record<string, unknown>;
}
