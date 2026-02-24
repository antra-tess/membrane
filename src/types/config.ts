/**
 * Configuration types for membrane
 */

import type { ModelRegistry } from './provider.js';
import type { ErrorInfo } from './errors.js';
import type { NormalizedRequest } from './request.js';
import type { NormalizedResponse } from './response.js';
import type { PrefillFormatter } from '../formatters/types.js';

// ============================================================================
// Retry Config
// ============================================================================

export interface RetryConfig {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries: number;
  
  /** Initial retry delay in milliseconds (default: 1000) */
  retryDelayMs: number;
  
  /** Backoff multiplier (default: 2) */
  backoffMultiplier: number;
  
  /** Maximum retry delay (default: 30000) */
  maxRetryDelayMs: number;
}

// ============================================================================
// Media Processing Config
// ============================================================================

export interface MediaConfig {
  images: {
    /** Maximum input image size in bytes */
    maxSizeBytes: number;
    
    /** Maximum dimensions */
    maxDimensions?: { width: number; height: number };
    
    /** Auto-resize if exceeds limits */
    autoResize: boolean;
    
    /** JPEG quality for resizing (0-100) */
    resizeQuality?: number;
    
    /** Relocate images to user turns in prefill mode */
    relocateInPrefillMode: boolean;
  };
  
  documents?: {
    /** Maximum document size */
    maxSizeBytes: number;
  };
  
  audio?: {
    /** Maximum duration in seconds */
    maxDurationSec: number;
  };
  
  video?: {
    /** Maximum duration in seconds */
    maxDurationSec: number;
  };
}

// ============================================================================
// Hooks
// ============================================================================

export interface MembraneHooks {
  /**
   * Called before sending request to provider
   * Can modify the raw request
   */
  beforeRequest?: (
    request: NormalizedRequest,
    rawRequest: unknown
  ) => unknown | Promise<unknown>;
  
  /**
   * Called after receiving response from provider
   * Can modify the response
   */
  afterResponse?: (
    response: NormalizedResponse,
    rawResponse: unknown
  ) => NormalizedResponse | Promise<NormalizedResponse>;
  
  /**
   * Called on error, before retry decision
   * Return 'retry' to retry, 'abort' to stop
   */
  onError?: (
    error: ErrorInfo,
    attempt: number
  ) => 'retry' | 'abort' | Promise<'retry' | 'abort'>;
}

// ============================================================================
// Logger Interface
// ============================================================================

export interface MembraneLogger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

// ============================================================================
// Membrane Config
// ============================================================================

export interface MembraneConfig {
  /** Model registry for capability lookup */
  registry?: ModelRegistry;

  /** Default model to use */
  defaultModel?: string;

  /**
   * Participant name to recognize as assistant in prefill mode.
   * Messages with this participant will be formatted as assistant turns.
   * Default: 'Claude'
   */
  assistantParticipant?: string;

  /**
   * Maximum number of participants to include in auto-generated stop sequences.
   * In prefill mode, membrane generates stop sequences like "\nUsername:" to prevent
   * the model from speaking as other participants.
   *
   * Set to 0 to disable participant-based stop sequences (allows frags/quotes).
   * Default: 10
   */
  maxParticipantsForStop?: number;

  /**
   * Prefill formatter for message serialization and response parsing.
   * Controls how messages are formatted for the API and how responses are parsed.
   * Default: AnthropicXmlFormatter
   */
  formatter?: PrefillFormatter;

  /** Retry configuration */
  retry?: Partial<RetryConfig>;

  /** Media processing configuration */
  media?: Partial<MediaConfig>;

  /** Lifecycle hooks */
  hooks?: MembraneHooks;

  /** Logger instance */
  logger?: MembraneLogger;

  /** Enable debug logging */
  debug?: boolean;
}

// ============================================================================
// Default Config
// ============================================================================

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 0,
  retryDelayMs: 1000,
  backoffMultiplier: 2,
  maxRetryDelayMs: 30000,
};

export const DEFAULT_MEDIA_CONFIG: MediaConfig = {
  images: {
    maxSizeBytes: 5 * 1024 * 1024, // 5MB (Anthropic limit)
    autoResize: true,
    resizeQuality: 85,
    relocateInPrefillMode: true,
  },
};
