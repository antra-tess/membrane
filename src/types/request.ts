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
     */
    display?: 'summarized' | 'omitted';
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
  /**
   * Explicitly own the loss of old inline images when the serialized request
   * exceeds the API byte cap: oldest images are replaced with loud
   * placeholders (error-logged). Without this flag an oversize request FAILS
   * LOUDLY before the API call (2026-07-12 — no silent transport-layer
   * mutation). Intended for summarizer/compression callers.
   */
  shedOversizeImages?: boolean;
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

  /** Marker ownership policy. `cm-owned` disables every formatter-generated
   * system/context-prefix marker; only normalized message breakpoints survive. */
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
   * the growing tool-round suffix caches incrementally (each round writes
   * only its delta and cache-reads everything before it). Placed only from
   * the request's *residual* breakpoint budget — the marker is withheld when
   * upstream markers already occupy all 4 Anthropic cache_control slots —
   * so upstream breakpoints are never displaced or stripped.
   * Defaults to true (when promptCaching is enabled). Set false for context
   * strategies whose request prefix churns between rounds, where a trailing
   * marker would be pure cache-write cost.
   */
  floatingCacheMarker?: boolean;

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

  /**
   * Control streaming behavior when calling membrane.stream().
   * - true or undefined: use streaming (default)
   * - false: force non-streaming — membrane.stream() will internally use
   *   complete() and synthesize streaming callbacks from the full response.
   *   Useful for working around provider streaming bugs.
   */
  streaming?: boolean;

  /** Provider-specific parameters (pass-through) */
  providerParams?: Record<string, unknown>;
}
