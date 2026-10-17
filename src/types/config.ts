/**
 * Configuration types for membrane
 */

import type { ModelRegistry } from './provider.js';
import type { ErrorInfo } from './errors.js';
import type { NormalizedRequest } from './request.js';
import type { NormalizedResponse } from './response.js';
import type { NormalizeEvent, PrefillFormatter } from '../formatters/types.js';

// ============================================================================
// Retry Config
// ============================================================================

export interface RetryConfig {
  /**
   * Bound on TOTAL attempts for a retryable error that ends a provider call
   * before it delivered anything, the first included: 5 means one try and up
   * to four retries; 0 or 1 means no retries (default: 5). It covers a 5xx,
   * a provider's 408 and a connection failure, on every entry point and
   * adapter. A deadline that runs out on a request already sent is left to
   * the caller: AnthropicAdapter's idle and first-event watchdogs, undici's
   * headers and body timeouts, Bun's fetch timeout, and every timeout
   * AnthropicAdapter's SDK client reports, which include a connect timeout
   * (the SDK reports both the same way). On Node, the other adapters'
   * connect timeouts are sent again like any connection failure. Bun's fetch
   * timeout doesn't say which stage ran out, so on Bun a stalled connect is
   * left to the caller too. A retryable rate
   * limit (429) gets at least 5 attempts whatever this says (unless the call
   * sets `retryRateLimits: false`), and a provider capacity error (529) gets
   * the larger of this and `overloaded.maxRetries`, on the `overloaded`
   * schedule. Membrane is the only layer that retries a call's requests:
   * AnthropicAdapter turns its SDK client's own retries off for them, and
   * only the cache keepalive's background replays keep the SDK's. A host
   * whose own retry layer should be the only one sets 1 here, 0 for
   * `overloaded.maxRetries`, and `retryRateLimits: false` on each call, and
   * reads `MembraneError.attempts`.
   */
  maxRetries: number;

  /** Initial retry delay in milliseconds (default: 1000) */
  retryDelayMs: number;

  /** Backoff multiplier (default: 2) */
  backoffMultiplier: number;

  /** Maximum retry delay (default: 30000) */
  maxRetryDelayMs: number;

  /**
   * Separate, longer schedule for provider capacity errors (529
   * overloaded_error). Capacity storms last minutes, not seconds — the
   * standard schedule's 30s ceiling turns one into a dead turn. Overloaded
   * retries are always attempted (mirroring the forced 429 retries), with
   * jitter so a fleet backing off doesn't re-create the stampede in sync.
   *
   * maxRetries: 0 here disables this dedicated policy entirely: 529s then
   * follow the base retry config like any other retryable server error, on
   * every path (the base schedule, within the base maxRetries).
   */
  overloaded: OverloadedRetryConfig;
}

export interface OverloadedRetryConfig {
  /** Attempt bound for overloaded errors, applied even when the base
   *  maxRetries is 0. Like the base maxRetries (and the forced 429 path),
   *  this bounds TOTAL attempts, not retries-after-the-first (default: 7) */
  maxRetries: number;

  /** Initial overloaded retry delay in milliseconds (default: 10000) */
  retryDelayMs: number;

  /** Backoff multiplier (default: 2) */
  backoffMultiplier: number;

  /** Maximum overloaded retry delay (default: 300000 — 5 minutes) */
  maxRetryDelayMs: number;
}

/** Shape accepted by MembraneConfig.retry — every field optional, including
 *  inside the nested overloaded schedule. */
export type RetryConfigInput = Partial<Omit<RetryConfig, 'overloaded'>> & {
  overloaded?: Partial<OverloadedRetryConfig>;
};

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
   * Called before sending a provider request. Return a replacement raw request,
   * or modify it in place and return undefined.
   *
   * `request` is the original normalized turn input, including on tool and
   * automatic-continuation rounds. It does not accumulate generated content
   * or tool results. `rawRequest` describes the current provider round; use
   * that argument to inspect or modify the conversation actually being sent.
   *
   * Changing `request` in place reaches whatever is built or read from it
   * after the hook: the native tool loop builds each later round from it
   * (its messages are the same objects), XML continuations reuse its config
   * and provider params, and an adapter that serializes
   * `extra.normalizedMessages` at send time (the completions adapter, on a
   * turn's first request) sends this round with the change. On a yielding
   * stream, a round whose hook changed either argument, and every later
   * round after an in-place change, reports `fidelity: 'unknown'`
   * (`RoundReport`).
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

  /**
   * Called with each repair the formatter's tool-pair normalization makes
   * while building a request (see `NormalizeEvent`), including a stray or
   * duplicate tool result turned into text, whose `recoveredChars` says how
   * much of it the model now reads as text. It runs synchronously inside the
   * build, once per event of every build: each attempt and each tool-loop
   * round rebuilds, so a repair the history keeps needing is reported each
   * time. A hook that throws fails the build, before anything is sent. A
   * promise it returns isn't awaited, so its rejection is the caller's to
   * handle. Only NativeFormatter's builds normalize, AnthropicXmlFormatter's
   * native mode included; the XML, completions and Responses builds report
   * none.
   */
  onNormalize?: (event: NormalizeEvent) => void;
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
   * Default for request.promptCaching when the request doesn't set it.
   * Historical default is true (Anthropic API). Set false for transports
   * that reject cache_control (e.g. Bedrock legacy Claude models, which 400
   * with "your request did not allow prompt caching").
   */
  defaultPromptCaching?: boolean;

  /**
   * Default for request.floatingCacheMarker when the request doesn't set it.
   * Default: true. See NormalizedRequest.floatingCacheMarker.
   */
  defaultFloatingCacheMarker?: boolean;

  /**
   * Prefill formatter for message serialization and response parsing.
   * Controls how messages are formatted for the API and how responses are parsed.
   * Default: AnthropicXmlFormatter
   */
  formatter?: PrefillFormatter;

  /** Retry configuration */
  retry?: RetryConfigInput;

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
  // 5 attempts = 4 waits: 1s → 2s → 4s → 8s, about 15 seconds of patience
  // for a 5xx or a dropped connection before anything was delivered. That
  // replaces the retries AnthropicAdapter's SDK client used to make inside
  // each attempt, which are off now that membrane is the one retry layer.
  maxRetries: 5,
  retryDelayMs: 1000,
  backoffMultiplier: 2,
  maxRetryDelayMs: 30000,
  // 7 attempts = 6 waits: 10s → 20s → 40s → 80s → 160s → 300s, ~10 minutes
  // of patience in total — the scale capacity storms actually resolve on.
  overloaded: {
    maxRetries: 7,
    retryDelayMs: 10_000,
    backoffMultiplier: 2,
    maxRetryDelayMs: 300_000,
  },
};

export const DEFAULT_MEDIA_CONFIG: MediaConfig = {
  images: {
    maxSizeBytes: 5 * 1024 * 1024, // 5MB (Anthropic limit)
    autoResize: true,
    resizeQuality: 85,
    relocateInPrefillMode: true,
  },
};
