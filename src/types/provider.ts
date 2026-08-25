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

export interface ProviderRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Abort if no SSE event arrives within this many ms (default: 120000) */
  idleTimeoutMs?: number;
  /**
   * Deadline for the FIRST stream event (TTFT). Large contexts on a cache
   * miss legitimately take minutes before message_start while the SDK
   * swallows ping keepalives (default: max(idleTimeoutMs, 600000)).
   */
  firstEventTimeoutMs?: number;
  /** Called with the raw API request body right before fetch */
  onRequest?: (rawRequest: unknown) => void;
  /**
   * Wrap native thinking deltas in <thinking>...</thinking> tags on the
   * onChunk stream. Used by the XML formatter path so its tag-based parser
   * tracks thinking blocks; without this, native thinking content streams
   * indistinguishably from visible text.
   */
  wrapThinkingTags?: boolean;
}

export interface ProviderResponse {
  /** Raw response content */
  content: unknown;
  
  /** Stop reason in provider format */
  stopReason: string;
  
  /** Which stop sequence triggered */
  stopSequence?: string;
  
  /** Usage in provider format */
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;

    /**
     * Reasoning tokens reported separately from the visible-output count and
     * already folded INTO `outputTokens`. See {@link DetailedUsage.reasoningTokens}.
     */
    reasoningTokens?: number;

    /**
     * Overrides {@link ProviderAdapter.usageCacheConvention} for THIS response.
     * Needed where one adapter fronts several upstream conventions: OpenRouter
     * reads `cache_read_input_tokens` (Anthropic, cache-excluded) OR
     * `prompt_tokens_details.cached_tokens` (OpenAI, cache-inclusive) depending
     * on which provider it routed to, so the convention is a per-response fact
     * there rather than a per-adapter one.
     */
    cacheConvention?: UsageCacheConvention;
  };
  
  /** Model that actually ran */
  model: string;

  /** Raw request that was actually sent to the API */
  rawRequest: unknown;

  /** Raw response for debugging */
  raw: unknown;
}

export interface StreamCallbacks {
  onChunk: (chunk: string) => void;
  onContentBlock?: (index: number, block: unknown) => void;
}
