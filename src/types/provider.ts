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
  
  /** Stop sequences */
  stopSequences?: string[];
  
  /** Tools in provider format */
  tools?: unknown[];
  
  /** Additional provider-specific params */
  extra?: Record<string, unknown>;
}

export interface ProviderRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Called with the raw API request body right before fetch */
  onRequest?: (rawRequest: unknown) => void;
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
