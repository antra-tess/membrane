export interface ProviderQuirks {
  /** Anthropic: must trim trailing whitespace from assistant messages */
  trimAssistantTrailingWhitespace?: boolean;
  
  /** Most providers: require alternating user/assistant roles */
  requiresAlternatingRoles?: boolean;
  
  /** Prefill mode: images must be in user turns */
  imagesMustBeInUserTurn?: boolean;
  
  /** Whether stop sequence is consumed (not in output) or present */
  stopSequenceConsumed?: boolean;
  
  /** Parameters to strip from request (provider rejects them) */
  rejectParams?: string[];
  
  /** Provider-specific notes */
  notes?: string;
}

export interface MediaCapabilities {
  imageInput: boolean;
  pdfInput: boolean;
  audioInput: boolean;
  videoInput: boolean;
  
  imageGeneration: boolean;
  
  maxImageSizeBytes?: number;
  maxImageDimensions?: { width: number; height: number };
  maxPdfPages?: number;
  maxAudioDurationSec?: number;
  maxVideoDurationSec?: number;
  
  imageFormats?: string[];
  audioFormats?: string[];
  videoFormats?: string[];
}

export interface ProviderCapabilities {
  supportsPrefill: boolean;
  supportsChat: boolean;
  supportsCaching: boolean;
  supportsThinking: boolean;
  supportsStreaming: boolean;
  
  media: MediaCapabilities;
  
  maxContextTokens: number;
  maxOutputTokens: number;
  maxStopSequences: number;
  maxCacheBreakpoints?: number;
  
  quirks: ProviderQuirks;
}

/**
 * Whether a provider's prompt-token count INCLUDES the span served from cache.
 *
 * Measured live 2026-08-25 — Anthropic (`cache-excluded`): a 4,650-token cached
 * system prompt returned `input_tokens: 8` with `cache_read_input_tokens: 4650`.
 * OpenAI (`cache-inclusive`): `prompt_tokens` stayed at 1732 across a cache hit
 * that reported `cached_tokens: 1664`, so cached is a SUBSET of the prompt.
 *
 * `cache-inclusive` describes the input count as a whole: every cached token,
 * read or written, is inside it. `cache-excluded` counts are disjoint already:
 * fresh input, cache writes and cache reads are three parts of the prompt.
 *
 * `unknown` means no one has established this adapter's convention: membrane
 * passes the counts through unchanged and warns the first time a cache read or
 * write makes the ambiguity bite.
 */
export type UsageCacheConvention = 'cache-excluded' | 'cache-inclusive' | 'unknown';

export interface ModelPricing {
  /** Cost per million input tokens */
  inputPerMillion: number;
  
  /** Cost per million output tokens */
  outputPerMillion: number;
  
  /** Cost per million cache write tokens */
  cacheWritePerMillion?: number;
  
  /** Cost per million cache read tokens */
  cacheReadPerMillion?: number;
  
  /** Currency code */
  currency: string;

  /**
   * ISO date these rates were last checked against the provider's published
   * price page, surfaced to callers as {@link CostBreakdown.pricingAsOf}. A
   * pricing source that cannot vouch for a date leaves it unset.
   */
  asOf?: string;
}

export interface ModelDefinition {
  /** Unique model identifier */
  id: string;
  
  /** Provider (anthropic, openrouter, google, etc.) */
  provider: string;
  
  /** Display name for UI */
  displayName: string;
  
  /** Capabilities */
  capabilities: ProviderCapabilities;
  
  /** Pricing (optional) */
  pricing?: ModelPricing;
  
  /** Aliases that resolve to this model */
  aliases?: string[];
  
  /** Whether model is deprecated */
  deprecated?: boolean;
  
  /** Successor model if deprecated */
  successorId?: string;
}

export interface ModelRegistry {
  /** Get capabilities for a model */
  getCapabilities(modelId: string): ProviderCapabilities | undefined;
  
  /** Get pricing for a model */
  getPricing(modelId: string): ModelPricing | undefined;
  
  /** Get quirks for a model */
  getQuirks(modelId: string): ProviderQuirks | undefined;
  
  /** Get full model definition */
  getModel(modelId: string): ModelDefinition | undefined;
  
  /** Resolve alias to canonical model ID */
  resolveModel(idOrAlias: string): string;
  
  /** List all models (optionally filtered) */
  listModels(filter?: ModelFilter): ModelDefinition[];
}

export interface ModelFilter {
  provider?: string;
  supportsPrefill?: boolean;
  supportsThinking?: boolean;
  supportsImageGeneration?: boolean;
  includeDeprecated?: boolean;
}

export interface ProviderAdapter {
  /** Provider name */
  readonly name: string;
  
  /**
   * Which convention this adapter's `usage.inputTokens` carries. Membrane
   * normalizes every response onto `cache-excluded` before any ratio or cost is
   * computed, and it can only do that if the adapter says what it is reporting.
   *
   * Optional, defaulting to `'unknown'`: membrane passes the counts through
   * untouched and warns once when a cache read makes the ambiguity bite.
   */
  usageCacheConvention?: UsageCacheConvention;

  /** Whether this transport requires the configured Responses formatter.
   * False permits generic per-request formatter overrides (e.g. named
   * maintenance messages). Wrappers must forward this capability. */
  readonly requiresNativeResponsesInput?: boolean;

  /** Whether Membrane sends an assistant turn's Anthropic server-tool blocks
   * (web search and the like) back through this adapter. Only AnthropicAdapter
   * declares it: a live check had the Anthropic API accept web search's two
   * (server_tool_use, web_search_tool_result), and whether another provider
   * accepts them is unknown. For any other adapter
   * Membrane leaves them out before cache markers are placed
   * (BuildOptions.anthropicServerBlocks). Decorators must forward this
   * capability. */
  readonly replaysAnthropicServerBlocks?: boolean;

  /** Whether this adapter sends a mid-conversation `role: 'system'` message,
   * which a formatter that `rendersSystemChanges` builds from a message's
   * `system_change` blocks (SystemChangeContent), with what the API needs for
   * it. Only AnthropicAdapter declares it: live checks had the Anthropic API
   * accept such messages, and whether another provider accepts them is
   * unknown. For any other adapter Membrane refuses a request carrying one
   * before sending. A decorator must forward this capability, or a request
   * through it is refused. */
  readonly sendsSystemChanges?: boolean;

  /**
   * True when this adapter carries the content of every message in the
   * ProviderRequest it receives into its API call (format conversion
   * aside), or calls `ProviderRequestOptions.onContentAltered` for any
   * request where it substitutes, drops or rewrites some, through every step
   * up to the final body, passthrough parameters and cleanup included.
   *
   * Declaring it also commits the adapter to leaving the supplied
   * ProviderRequest unchanged: it never mutates the request, its messages or
   * their blocks.
   *
   * Round reports (UsageEvent.round) rely on it: an adapter that doesn't
   * declare it leaves a round's fidelity 'unknown'. Decorators must forward
   * this capability and the callback, and keep the same obligation.
   */
  readonly reportsContentAlterations?: boolean;

  /** Representation used for cache-layout receipts. The default provider-request
   * basis preserves post-hook semantic breakpoints even when this adapter's API
   * does not transmit cache_control. wire-request opts into the final body
   * reported through onRequest. Decorators must forward this capability. */
  readonly cacheReceiptBasis?: 'provider-request' | 'wire-request';

  /** Check if this adapter handles a model */
  supportsModel(modelId: string): boolean;
  
  /** Make a completion request (non-streaming) */
  complete(
    request: ProviderRequest,
    options?: ProviderRequestOptions
  ): Promise<ProviderResponse>;
  
  /** Make a streaming request */
  stream(
    request: ProviderRequest,
    callbacks: StreamCallbacks,
    options?: ProviderRequestOptions
  ): Promise<ProviderResponse>;
}

export interface ProviderRequest {
  /** Raw messages in provider format */
  messages: unknown[];
  
  /** System prompt - can be string or content blocks with cache_control */
  system?: string | unknown[];
  
  /** Model ID */
  model: string;
  
  /** Max tokens */
  maxTokens: number;
  
  /** Temperature */
  temperature?: number;

  /** Top P nucleus sampling */
  topP?: number;

  /** Top K sampling */
  topK?: number;

  /** Presence penalty */
  presencePenalty?: number;

  /** Frequency penalty */
  frequencyPenalty?: number;

  /** Repetition penalty (multiplicative, vLLM/HuggingFace style) */
  repetitionPenalty?: number;

  /** Stop sequences */
  stopSequences?: string[];
  
  /** Tools in provider format */
  tools?: unknown[];

  /**
   * Extended-thinking config (Anthropic). Presence with a `type` other than
   * `'disabled'` enables thinking, which strips custom temperature and top_k,
   * and a top_p below 0.95.
   */
  thinking?: { type?: string; [key: string]: unknown };

  /** Additional provider-specific params */
  extra?: Record<string, unknown>;
}

export interface ProviderRequestContext {
  formatterName: string;
  toolMode: 'native' | 'xml';
  /** Whether the request's `tools` holds any. */
  toolsDeclared: boolean;
  /** An XML streaming runner may manufacture prefill on a later continuation. */
  requiresAssistantPrefill: boolean;
}

/**
 * What a parsed provider event is, as an adapter that reports content says
 * through `ProviderRequestOptions.onProgress`. `'content'`: a content delta of
 * any kind (text, thinking, tool input, a signature), or a `redacted_thinking`
 * block's start, since that block arrives whole once its think is done. Any
 * other block's start is only an event: a text or tool block's content
 * follows as deltas, and a server tool's result block, which arrives whole
 * too, follows its call's input deltas, so content has begun by then.
 */
export type ProgressSeen = 'content';

/**
 * What an adapter reports about one attempt as it sends it, through
 * `ProviderRequestOptions.onSend`.
 */
export interface SendReport {
  /**
   * The output-token limit the body asks for (its `max_tokens` or
   * equivalent), after any default and passthrough parameter the adapter
   * applied.
   */
  maxTokens?: number;
  /**
   * Whether this attempt reports content through `onProgress('content')`, so
   * a stream whose content never began can be told from one whose content
   * isn't reported.
   */
  reportsContent?: boolean;
}

export interface ProviderRequestOptions {
  /** Build/protocol facts for validation against the adapter's final model/body.
   * Not provider JSON. Decorators forward this context with the other options. */
  requestContext?: ProviderRequestContext;
  /** Current normalized participant messages for prompt serialization.
   * Explicit extra.prompt/normalizedMessages retain precedence in
   * OpenAICompletionsAdapter. */
  promptMessages?: import('./message.js').NormalizedMessage[];
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Anthropic idle deadline after the first SDK event (default: 600000 ms).
   * Nonempty Web response-body bytes, including SSE keepalives, refresh it;
   * other SDK-supported bodies refresh it on SDK events. This does not bound
   * total duration or generation progress. */
  idleTimeoutMs?: number;
  /**
   * Deadline for the FIRST stream event (TTFT). Large contexts on a cache
   * miss legitimately take minutes before message_start while the SDK
   * swallows ping keepalives (default: max(idleTimeoutMs, 600000)).
   */
  firstEventTimeoutMs?: number;
  /**
   * Stream progress, for the progress deadline Membrane core keeps per
   * provider call (`progressTimeoutMs`). An adapter calls it once per parsed
   * provider event: each SDK event, each SSE data frame that parses to a JSON
   * object, each event-stream message that decodes to one. Never for a frame
   * that parses to anything else (`null`, a number, a string, an array),
   * which carries no event, nor for keepalives (Anthropic's and
   * Bedrock's `ping`), SSE comments or raw body bytes: those prove the
   * connection is up, not that the model is making progress. An adapter that
   * reports content (SendReport.reportsContent) passes `'content'` for an
   * event that is content (see ProgressSeen), and nothing for any other.
   * Decorators must forward it beside the other options: one that drops it
   * turns the progress deadline into a total one, and one that drops its
   * argument while forwarding `onSend` reports content that never arrives.
   * TypeScript doesn't catch the second, since a function of no arguments
   * fits this type.
   */
  onProgress?: (seen?: ProgressSeen) => void;
  /**
   * What this attempt sends (see SendReport), reported once per attempt
   * beside `onRequest`, before the request goes out. Decorators forward it
   * with the other options.
   */
  onSend?: (send: SendReport) => void;
  /** Report the final API request body immediately before sending it.
   * Required for adapters declaring cacheReceiptBasis: 'wire-request'.
   * Decorators forward it; raw logging observes each attempt, even when
   * a refusal retry shares its logical cache receipt with an earlier attempt. */
  onRequest?: (rawRequest: unknown) => void;
  /** Wrap native thinking deltas in <thinking>...</thinking> tags on the onChunk stream. */
  wrapThinkingTags?: boolean;
  /**
   * Called when the adapter did not carry some message content of this
   * request verbatim: it substituted, dropped or rewrote a block, including
   * whitespace-only text its cleanup removed and message content a
   * passthrough parameter replaced. Pass the request's own block object when
   * the alteration is to one block (membrane attributes it to the message
   * that block came from); call it with no argument otherwise. Adapters
   * declaring `reportsContentAlterations` call it; decorators forward it.
   */
  onContentAltered?: (block?: unknown) => void;
}

/** One entry of a provider's report on what it did with a request's input (ProviderResponse.inputTransformations). */
export interface ProviderInputTransformation {
  /** The provider's entry type, such as 'thinking_dropped' or 'thinking_mismatch_allowed'. */
  type: string;
  /** Why, as the provider names it. */
  reason?: string;
  /** Where the block is in the request the provider received, as it names it: `messages.{i}.content.{j}`. */
  path?: string;
  /**
   * The request's own block object at that path, when the adapter could
   * resolve it (as `ProviderRequestOptions.onContentAltered` takes one).
   */
  block?: unknown;
}

export interface ProviderResponse {
  /** Raw response content */
  content: unknown;
  
  /** Adapter-level stop reason, which may already be normalized. */
  stopReason: string;

  /**
   * Verbatim terminal reason reported by the provider, before normalization.
   * Omit when no reason was reported. Custom adapters opt in by supplying it;
   * Membrane does not parse adapter-specific raw data for it. Without it,
   * details.stop.providerReason carries stopReason when that's a non-empty
   * string membrane doesn't map (it becomes end_turn), and is left unset
   * otherwise. A value that isn't a non-empty string counts as none.
   */
  providerStopReason?: string;

  /**
   * The provider's category for a refusal: Anthropic's
   * `stop_details.category`, such as 'cyber'. Set only when the provider
   * stopped with `refusal` and named a category as a non-empty string; absent
   * otherwise. AnthropicAdapter and BedrockAdapter set it on stream() and
   * complete(). AWS documents Bedrock's `stop_details` on a non-streamed body;
   * its page doesn't show them in a stream's events, so on Bedrock's stream
   * they may never come, and the field is read only if a message_delta
   * carries them. No other built-in adapter sets it. Membrane announces it, and nothing read from
   * the raw response, on a refusal re-issue's `RetryingEvent.category`.
   * Custom adapters opt in by supplying it, and a decorator that rebuilds the
   * response must carry it. As with providerStopReason, membrane reads a value
   * that isn't a non-empty string as none.
   */
  refusalCategory?: string;
  
  /** Which stop sequence triggered */
  stopSequence?: string;
  
  /** Usage in provider format */
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;

    /**
     * Thinking/reasoning tokens reported separately from the visible-output
     * count and already folded INTO `outputTokens`.
     * See {@link DetailedUsage.thinkingTokens}.
     */
    thinkingTokens?: number;

    /**
     * Overrides {@link ProviderAdapter.usageCacheConvention} for THIS response.
     * Needed where one adapter fronts several upstream conventions: OpenRouter
     * reads `cache_read_input_tokens` (Anthropic, cache-excluded) OR
     * `prompt_tokens_details.cached_tokens` (OpenAI, cache-inclusive) depending
     * on which provider it routed to, so the convention is a per-response fact
     * there rather than a per-adapter one. Gemini sets it too, for a response
     * whose cached count exceeds its prompt count: the inclusive reading it
     * declares can't hold there, so that response is read as cache-excluded.
     */
    cacheConvention?: UsageCacheConvention;
  };

  /**
   * Required usage counts the provider did not report. Their value in
   * `usage` is a 0 default kept for accounting, not an observation; round
   * reports (UsageEvent.round) leave them out. Absent when both were reported.
   */
  unreportedUsage?: Array<'inputTokens' | 'outputTokens'>;

  /**
   * What the provider reported doing with blocks of this request's messages
   * before the model saw them, one entry per block, in request order:
   * Anthropic's `input_transformations`, which come back when the request
   * asks for thinking-binding controls (`thinking.block_binding`). Empty
   * when the provider reported nothing to report; absent when the response
   * carried no report.
   */
  inputTransformations?: ProviderInputTransformation[];
  
  /** Model that actually ran */
  model: string;

  /**
   * The provider's own id for this response (Anthropic: the message id from
   * `message_start`). Diagnostics only: it names the response in a report to
   * the provider. Absent when the provider sent none.
   */
  responseId?: string;

  /**
   * The provider's id for the HTTP request (Anthropic: the `request-id`
   * response header), the id provider support asks for. Absent when the
   * transport exposed none.
   */
  requestId?: string;

  /** Raw request that was actually sent to the API */
  rawRequest: unknown;

  /** Raw response for debugging */
  raw: unknown;
}

export interface StreamCallbacks {
  onChunk: (chunk: string) => void;
  /**
   * A provider content block, by its position in the response. Built-in
   * adapters follow one of two conventions:
   * - paired (Anthropic, Bedrock): once when the block starts, with its start
   *   payload, and again when it is finished, with the final payload. A start
   *   payload is not the block's content: a tool call's `input` there is an
   *   empty placeholder until its arguments have arrived, and Bedrock's adapter
   *   goes on changing the start payload's object as the block streams.
   * - single-final (OpenAI Responses): once per block, already finished,
   *   after the terminal response has been parsed successfully.
   * Images (OpenRouter) are reported once, when received.
   */
  onContentBlock?: (index: number, block: unknown) => void;
  /**
   * A thinking block's signature as received so far: the whole accumulated
   * string, after each signature delta (Anthropic, Bedrock). It neither starts
   * nor completes a block, and the block's finished payload, when it arrives,
   * is authoritative. It lets a stream that ends before the block finishes
   * keep the signature it received. That preserves what arrived; a signature
   * cut off part-way is not thereby valid for replay.
   */
  onThinkingSignature?: (index: number, signature: string) => void;
}
