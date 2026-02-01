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
    
    // Server error
    if (message.includes('500') || message.includes('502') || message.includes('503') || message.includes('504')) {
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
