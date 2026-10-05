/**
 * Error types for membrane
 */

// ============================================================================
// Error Serialization Helper
// ============================================================================

/**
 * Serialize an error for storage in rawError field.
 * Error objects don't JSON.stringify well (become {}), so we extract key properties.
 */
export function serializeError(error: unknown): unknown {
  if (error === undefined || error === null) {
    return error;
  }

  if (error instanceof Error) {
    const serialized: Record<string, unknown> = {
      name: error.name,
      message: error.message,
    };

    // Include stack trace in non-production
    if (process.env.NODE_ENV !== 'production' && error.stack) {
      serialized.stack = error.stack;
    }

    // Copy any additional enumerable properties (like status, code, etc.)
    for (const key of Object.keys(error)) {
      serialized[key] = (error as unknown as Record<string, unknown>)[key];
    }

    return serialized;
  }

  // For non-Error objects, return as-is (they should serialize fine)
  return error;
}

// ============================================================================
// Error Types
// ============================================================================

export type MembraneErrorType =
  | 'rate_limit'
  | 'context_length'
  | 'invalid_request'
  | 'auth'
  | 'server'
  | 'network'
  | 'timeout'
  | 'abort'
  | 'safety'
  | 'unsupported'
  | 'unknown';

// ============================================================================
// Error Info (for hooks and logging)
// ============================================================================

export interface ErrorInfo {
  /** Normalized error type */
  type: MembraneErrorType;

  /** Human-readable message */
  message: string;

  /** Whether this error is retryable */
  retryable: boolean;

  /** Retry after (milliseconds) - for rate limits */
  retryAfterMs?: number;

  /** HTTP status code if available */
  httpStatus?: number;

  /** Provider-specific error code */
  providerErrorCode?: string;

  /** Raw error object */
  rawError: unknown;

  /** Raw request that caused the error (for logging) */
  rawRequest?: unknown;
}

// ============================================================================
// Membrane Error Class
// ============================================================================

export class MembraneError extends Error {
  readonly type: MembraneErrorType;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly httpStatus?: number;
  readonly providerErrorCode?: string;
  readonly rawError?: unknown;
  readonly rawRequest?: unknown;

  constructor(info: ErrorInfo) {
    super(info.message);
    this.name = 'MembraneError';
    this.type = info.type;
    this.retryable = info.retryable;
    this.retryAfterMs = info.retryAfterMs;
    this.httpStatus = info.httpStatus;
    this.providerErrorCode = info.providerErrorCode;
    // Serialize error objects so they don't become {} when JSON.stringify'd
    this.rawError = serializeError(info.rawError);
    this.rawRequest = info.rawRequest;
  }

  toErrorInfo(): ErrorInfo {
    return {
      type: this.type,
      message: this.message,
      retryable: this.retryable,
      retryAfterMs: this.retryAfterMs,
      httpStatus: this.httpStatus,
      providerErrorCode: this.providerErrorCode,
      rawError: this.rawError,
      rawRequest: this.rawRequest,
    };
  }
}

// ============================================================================
// Error Factory Functions
// ============================================================================

export function rateLimitError(message: string, retryAfterMs?: number, raw?: unknown, rawRequest?: unknown): MembraneError {
  return new MembraneError({
    type: 'rate_limit',
    message,
    retryable: true,
    retryAfterMs,
    httpStatus: 429,
    rawError: raw,
    rawRequest,
  });
}

export function contextLengthError(message: string, raw?: unknown, rawRequest?: unknown): MembraneError {
  return new MembraneError({
    type: 'context_length',
    message,
    retryable: false,
    httpStatus: 400,
    rawError: raw,
    rawRequest,
  });
}

export function invalidRequestError(message: string, raw?: unknown, rawRequest?: unknown): MembraneError {
  return new MembraneError({
    type: 'invalid_request',
    message,
    retryable: false,
    httpStatus: 400,
    rawError: raw,
    rawRequest,
  });
}

export function authError(message: string, raw?: unknown, rawRequest?: unknown): MembraneError {
  return new MembraneError({
    type: 'auth',
    message,
    retryable: false,
    httpStatus: 401,
    rawError: raw,
    rawRequest,
  });
}

export function serverError(message: string, httpStatus?: number, raw?: unknown, rawRequest?: unknown): MembraneError {
  return new MembraneError({
    type: 'server',
    message,
    retryable: true,
    httpStatus: httpStatus ?? 500,
    rawError: raw,
    rawRequest,
  });
}

export function networkError(message: string, raw?: unknown, rawRequest?: unknown): MembraneError {
  return new MembraneError({
    type: 'network',
    message,
    retryable: true,
    rawError: raw,
    rawRequest,
  });
}

export function timeoutError(message: string, raw?: unknown, rawRequest?: unknown): MembraneError {
  return new MembraneError({
    type: 'timeout',
    message,
    retryable: true,
    rawError: raw,
    rawRequest,
  });
}

export function abortError(message: string = 'Request was aborted', rawRequest?: unknown): MembraneError {
  return new MembraneError({
    type: 'abort',
    message,
    retryable: false,
    rawError: undefined,
    rawRequest,
  });
}

/**
 * A request cancelled by the adapter's OWN deadline (`timeoutMs`), as opposed
 * to a caller's signal or a stray abort.
 *
 * It is both facts at once, and callers need both: a timeout by `type` (so
 * `classifyError` and the abort-reason ladder report `'timeout'`), and an
 * abort by provenance (so the streaming paths still hand back an
 * `AbortedResponse` with whatever partial content arrived, rather than
 * throwing). Non-retryable: the deadline that fired belongs to this call, and
 * retrying inside it would only spend the caller's budget again.
 */
export class TimeoutAbortError extends MembraneError {
  constructor(message: string = 'Request timed out', raw?: unknown, rawRequest?: unknown) {
    super({
      type: 'timeout',
      message,
      retryable: false,
      rawError: raw,
      rawRequest,
    });
    this.name = 'TimeoutAbortError';
  }
}

export function isTimeoutAbortError(error: unknown): error is TimeoutAbortError {
  return error instanceof TimeoutAbortError;
}

export function safetyError(message: string, raw?: unknown, rawRequest?: unknown): MembraneError {
  return new MembraneError({
    type: 'safety',
    message,
    retryable: false,
    rawError: raw,
    rawRequest,
  });
}

export function unsupportedError(message: string, rawRequest?: unknown): MembraneError {
  return new MembraneError({
    type: 'unsupported',
    message,
    retryable: false,
    rawError: undefined,
    rawRequest,
  });
}

// ============================================================================
// Error Classification
// ============================================================================

/**
 * Provider capacity exhaustion — Anthropic 529 overloaded_error, whichever
 * path it arrived by (structured status from the provider handler, or the
 * message-matched fallbacks in classifyError). Used only to CHOOSE the retry
 * schedule among already-retryable errors, never to decide retryability.
 * Matches the same deliberately narrow tokens as classifyError's fallback
 * (status/`529`/exact `overloaded_error`) — a bare 'overloaded' in prose
 * (e.g. "worker pool overloaded") must not put an unrelated error onto the
 * ~10-minute schedule. The provider handlers' own bare-'overloaded' safety
 * nets attach httpStatus 529, so those still land here via the status check.
 */
export function isOverloadedError(info: ErrorInfo): boolean {
  if (!info.retryable) return false;
  if (info.httpStatus === 529) return true;
  const m = info.message.toLowerCase();
  return m.includes('529') || m.includes('overloaded_error');
}

export function classifyError(error: unknown): ErrorInfo {
  if (error instanceof MembraneError) {
    return error.toErrorInfo();
  }

  // Serialize the error once for use in all return paths
  const serializedError = serializeError(error);

  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    
    // Rate limit
    if (message.includes('rate') || message.includes('429') || message.includes('too many')) {
      return {
        type: 'rate_limit',
        message: error.message,
        retryable: true,
        httpStatus: 429,
        rawError: serializedError,
      };
    }
    
    // Context length
    if (message.includes('context') || message.includes('too long') || message.includes('maximum')) {
      return {
        type: 'context_length',
        message: error.message,
        retryable: false,
        rawError: serializedError,
      };
    }
    
    // Auth
    if (message.includes('auth') || message.includes('401') || message.includes('api key')) {
      return {
        type: 'auth',
        message: error.message,
        retryable: false,
        httpStatus: 401,
        rawError: serializedError,
      };
    }
    
    // Network
    if (message.includes('network') || message.includes('econnreset') || message.includes('socket')) {
      return {
        type: 'network',
        message: error.message,
        retryable: true,
        rawError: serializedError,
      };
    }
    
    // Timeout
    if (message.includes('timeout') || message.includes('timed out')) {
      return {
        type: 'timeout',
        message: error.message,
        retryable: true,
        rawError: serializedError,
      };
    }
    
    // Abort
    if (message.includes('abort') || error.name === 'AbortError') {
      return {
        type: 'abort',
        message: error.message,
        retryable: false,
        rawError: serializedError,
      };
    }
    
    // Server error (529/overloaded_error: Anthropic capacity errors —
    // transient, always worth retrying). This is the provider-agnostic
    // fallback path (handled Anthropic errors short-circuit above as
    // MembraneError), so match the exact `overloaded_error` type token
    // rather than a bare 'overloaded' that would also promote unrelated
    // messages like "worker pool overloaded" to retryable.
    if (message.includes('500') || message.includes('502') || message.includes('503') || message.includes('504') || message.includes('529') || message.includes('overloaded_error')) {
      return {
        type: 'server',
        message: error.message,
        retryable: true,
        rawError: serializedError,
      };
    }
  }

  // Unknown
  return {
    type: 'unknown',
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
    rawError: serializedError,
  };
}
