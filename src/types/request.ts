/**
 * Request types for membrane
 */

import type { NormalizedMessage } from './message.js';
import type { ToolDefinition } from './tools.js';

// ============================================================================
// Generation Config
// ============================================================================

export interface GenerationConfig {
  /** Model identifier */
  model: string;
  
  /** Maximum tokens to generate */
  maxTokens: number;
  
  /** Temperature (0-2) */
  temperature?: number;
  
  /** Top P nucleus sampling */
  topP?: number;
  
  /** Top K sampling (provider-specific) */
  topK?: number;
  
  /** Presence penalty (provider-specific) */
  presencePenalty?: number;
  
  /** Frequency penalty (provider-specific) */
  frequencyPenalty?: number;
  
  /** Enable thinking/reasoning mode */
  thinking?: {
    enabled: boolean;
    budgetTokens?: number;
  };
  
  /** Image generation config (Gemini) */
  imageGeneration?: {
    enabled: boolean;
    modalities: ('TEXT' | 'IMAGE')[];
    aspectRatio?: '1:1' | '16:9' | '9:16' | '4:3' | '3:4';
    imageSize?: 'SMALL' | 'MEDIUM' | 'LARGE';
  };
}

// ============================================================================
// Stop Sequence Config
// ============================================================================

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

// ============================================================================
// Request Options
// ============================================================================

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

// ============================================================================
// Tool Mode
// ============================================================================

export type ToolMode = 
  | 'xml'     // XML injection in prefill mode (chatperx style)
  | 'native'  // Native API tool support (Anthropic tool_use, OpenAI tool_calls)
  | 'auto';   // Automatically choose based on provider/mode

// ============================================================================
// Normalized Request
// ============================================================================

export interface NormalizedRequest {
  /** Conversation messages */
  messages: NormalizedMessage[];
  
  /** System prompt */
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
   * Enable prompt caching (Anthropic/Bedrock).
   * Defaults to true for backward compatibility.
   * Set to false to disable cache_control markers in requests.
   */
  promptCaching?: boolean;

  /**
   * Cache TTL for Anthropic prompt caching.
   * '5m' (default) = 5 minute TTL
   * '1h' = 1 hour TTL (extended caching)
   */
  cacheTtl?: '5m' | '1h';

  /**
   * Context prefix for simulacrum seeding.
   * Injected as first assistant message (before conversation history).
   * Cached when promptCaching is enabled.
   */
  contextPrefix?: string;

  /**
   * Custom content for the synthetic user message injected when the first
   * provider message is an assistant turn (required by Claude Messages API).
   * Defaults to '[Start]' if not specified.
   */
  prefillUserMessage?: string;

  /**
   * Participant name that maps to the 'assistant' role.
   * Messages with this participant are formatted as assistant turns.
   * Default: 'Claude'
   */
  assistantParticipant?: string;

  /** Provider-specific parameters (pass-through) */
  providerParams?: Record<string, unknown>;
}
