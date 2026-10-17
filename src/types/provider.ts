/**
 * Provider capability and registry types
 */

// ============================================================================
// Provider Quirks
// ============================================================================

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

// ============================================================================
// Media Capabilities
// ============================================================================

export interface MediaCapabilities {
  // Input support
  imageInput: boolean;
  pdfInput: boolean;
  audioInput: boolean;
  videoInput: boolean;
  
  // Output support
  imageGeneration: boolean;
  
  // Limits
  maxImageSizeBytes?: number;
  maxImageDimensions?: { width: number; height: number };
  maxPdfPages?: number;
  maxAudioDurationSec?: number;
  maxVideoDurationSec?: number;
  
  // Supported formats
  imageFormats?: string[];  // ['image/jpeg', 'image/png', ...]
  audioFormats?: string[];  // ['audio/mpeg', 'audio/wav', ...]
  videoFormats?: string[];  // ['video/mp4', 'video/webm', ...]
}

// ============================================================================
// Provider Capabilities
// ============================================================================

export interface ProviderCapabilities {
  // Mode support
  supportsPrefill: boolean;
  supportsChat: boolean;
  supportsCaching: boolean;
  supportsThinking: boolean;
  supportsStreaming: boolean;
  
  // Media
  media: MediaCapabilities;
  
  // Limits
  maxContextTokens: number;
  maxOutputTokens: number;
  maxStopSequences: number;
  maxCacheBreakpoints?: number;
  
  // Quirks
  quirks: ProviderQuirks;
}

// ============================================================================
// Model Pricing
// ============================================================================

/**
 * Whether a provider's prompt-token count INCLUDES the span served from cache.
 *
 * Measured live 2026-08-25 — Anthropic (`cache-excluded`): a 4,650-token cached
 * system prompt returned `input_tokens: 8` with `cache_read_input_tokens: 4650`.
 * OpenAI (`cache-inclusive`): `prompt_tokens` stayed at 1732 across a cache hit
 * that reported `cached_tokens: 1664`, so cached is a SUBSET of the prompt.
 *
 * `unknown` is a real epistemic state, not a default to lean on: it means no
 * one has established this adapter's convention, and membrane will pass the
 * counts through unchanged and warn the first time a cache read makes the
 * ambiguity bite.
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
   * pricing source that cannot vouch for a date leaves it unset — better an
   * absent freshness signal than a fabricated one.
   */
  asOf?: string;
}

// ============================================================================
// Model Information
// ============================================================================

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

// ============================================================================
// Model Registry Interface
// ============================================================================

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

// ============================================================================
// Provider Adapter Interface
// ============================================================================

export interface ProviderAdapter {
  /** Provider name */
  readonly name: string;
  
  /**
   * Which convention this adapter's `usage.inputTokens` carries. Membrane
   * normalizes every response onto `cache-excluded` before any ratio or cost is
   * computed, and it can only do that if the adapter says what it is reporting.
   *
   * OPTIONAL, defaulting to `'unknown'`: an adapter that declares nothing is in
   * exactly the state `'unknown'` names, and treating it that way — pass the
   * counts through untouched, warn once when a cache read makes the ambiguity
   * bite — is the honest reading of silence. Requiring it would also stop every
   * external custom adapter compiling for a fact membrane can already say it
   * does not know. Declare it: `'unknown'` is a real epistemic state, not a
   * resting place.
   */
  usageCacheConvention?: UsageCacheConvention;

  /** Whether this transport requires the configured Responses formatter.
   * False permits generic per-request formatter overrides (e.g. named
   * maintenance messages). Wrappers must forward this capability. */
  readonly requiresNativeResponsesInput?: boolean;

  /**
   * True when this adapter carries the content of every message in the
   * ProviderRequest it receives into its API call (format conversion
   * aside), or calls `ProviderRequestOptions.onContentAltered` for any
   * request where it substitutes, drops or rewrites some, through every step
   * up to the final body, passthrough parameters and cleanup included.
   *
   * Declaring it also commits the adapter to leaving the supplied
   * ProviderRequest unchanged: it derives its wire body as a separate object
   * and never mutates the request, its messages or their blocks. Membrane
   * reuses one request across refusal-retry attempts and attributes reports
   * by the identity of the blocks it built, so an adapter that edited the
   * request in place would change what later attempts carry without any
   * report saying so. The built-in declaring adapters build their bodies
   * this way.
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

// Internal types used by adapters
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
   * `'disabled'` enables thinking, which strips custom sampling parameters.
   */
  thinking?: { type?: string; [key: string]: unknown };

  /** Additional provider-specific params */
  extra?: Record<string, unknown>;
}

export interface ProviderRequestContext {
  formatterName: string;
  toolMode: 'native' | 'xml';
  toolsDeclared: boolean;
  /** An XML streaming runner may manufacture prefill on a later continuation. */
  requiresAssistantPrefill: boolean;
}

export interface ProviderRequestOptions {
  /** Build/protocol facts for validation against the adapter's final model/body.
   * Not provider JSON. Decorators forward this context with the other options. */
  requestContext?: ProviderRequestContext;
  /** Current normalized participant messages for prompt serialization. Native
   * loops pass them outside ProviderRequest so opaque message metadata is not
   * serialized by semantic receipts. Explicit extra.prompt/normalizedMessages
   * retain precedence in OpenAICompletionsAdapter. */
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
   * provider event: each SDK event, each SSE data frame that parses, each
   * decoded event-stream message. Never for keepalives (Anthropic's and
   * Bedrock's `ping`), SSE comments or raw body bytes: those prove the
   * connection is up, not that the model is making progress. Decorators must
   * forward it with the other options; one that drops it turns the progress
   * deadline into a total one.
   */
  onProgress?: () => void;
  /** Report the final API request body immediately before sending it.
   * Required for adapters declaring cacheReceiptBasis: 'wire-request'.
   * Decorators forward it; raw logging observes each attempt, even when
   * a refusal retry shares its logical cache receipt with an earlier attempt. */
  onRequest?: (rawRequest: unknown) => void;
  /**
   * Wrap native thinking deltas in <thinking>...</thinking> tags on the
   * onChunk stream. Used by the XML formatter path so its tag-based parser
   * tracks thinking blocks; without this, native thinking content streams
   * indistinguishably from visible text.
   */
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
   * resolve it (as `ProviderRequestOptions.onContentAltered` takes one), so
   * membrane can say which message it came from.
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
   * Membrane does not infer it from stopReason or parse adapter-specific raw data.
   */
  providerStopReason?: string;
  
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

  /** Raw request that was actually sent to the API */
  rawRequest: unknown;

  /** Raw response for debugging */
  raw: unknown;
}

export interface StreamCallbacks {
  onChunk: (chunk: string) => void;
  /**
   * A provider content block, by its position in the response. Built-in
   * adapters follow one of two conventions, and Membrane's native loops rely
   * on them to tell a finished block from one still arriving:
   * - paired (Anthropic, Bedrock): once when the block starts, with its start
   *   payload, and again when it is finished, with the final payload. A start
   *   payload is not the block's content: a tool call's `input` there is an
   *   empty placeholder until its arguments have arrived.
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
