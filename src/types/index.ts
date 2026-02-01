/**
 * Type exports for membrane
 */

// Content blocks
export type {
  CacheControl,
  MediaSource,
  Base64Source,
  UrlSource,
  ContentBlock,
  TextContent,
  ImageContent,
  DocumentContent,
  AudioContent,
  VideoContent,
  GeneratedImageContent,
  ToolUseContent,
  ToolResultContent,
  ThinkingContent,
  RedactedThinkingContent,
} from './content.js';

export {
  isTextContent,
  isImageContent,
  isDocumentContent,
  isAudioContent,
  isVideoContent,
  isGeneratedImageContent,
  isToolUseContent,
  isToolResultContent,
  isThinkingContent,
  isRedactedThinkingContent,
  isMediaContent,
} from './content.js';

// Messages
export type {
  MessageMetadata,
  NormalizedMessage,
} from './message.js';

export {
  textMessage,
  extractText,
  hasMedia,
  hasToolUse,
} from './message.js';

// Tools
export type {
  ToolParameter,
  ToolDefinition,
  ToolCall,
  ToolResult,
  ToolResultContentBlock,
  ToolContext,
  ParsedToolCalls,
} from './tools.js';

// Request
export type {
  GenerationConfig,
  StopSequenceStrategy,
  StopSequenceConfig,
  RequestOptions,
  NormalizedRequest,
  ToolMode,
} from './request.js';

// Response
export type {
  StopReason,
  BasicUsage,
  DetailedUsage,
  CostBreakdown,
  StopInfo,
  ModelInfo,
  TimingInfo,
  CacheInfo,
  ResponseDetails,
  RawAccess,
  NormalizedResponse,
  AbortedResponse,
} from './response.js';

export { isAbortedResponse } from './response.js';

// Provider
export type {
  ProviderQuirks,
  MediaCapabilities,
  ProviderCapabilities,
  ModelPricing,
  ModelDefinition,
  ModelRegistry,
  ModelFilter,
  ProviderAdapter,
  ProviderRequest,
  ProviderRequestOptions,
  ProviderResponse,
  StreamCallbacks,
} from './provider.js';

// Streaming
export type {
  StreamState,
  StreamOptions,
  CompleteOptions,
  OnChunkCallback,
  OnContentBlockCallback,
  OnToolCallsCallback,
  OnPreToolContentCallback,
  OnUsageCallback,
  OnBlockCallback,
  OnRequestCallback,
  OnResponseCallback,
  BlockEvent,
  BlockDelta,
} from './streaming.js';

// Errors
export type {
  MembraneErrorType,
  ErrorInfo,
} from './errors.js';

export {
  MembraneError,
  serializeError,
  rateLimitError,
  contextLengthError,
  invalidRequestError,
  authError,
  serverError,
  networkError,
  timeoutError,
  abortError,
  safetyError,
  unsupportedError,
  classifyError,
} from './errors.js';

// Config
export type {
  RetryConfig,
  MediaConfig,
  MembraneHooks,
  MembraneLogger,
  MembraneConfig,
} from './config.js';

export {
  DEFAULT_RETRY_CONFIG,
  DEFAULT_MEDIA_CONFIG,
} from './config.js';
