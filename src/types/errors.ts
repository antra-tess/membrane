/**
 * Error types for membrane
 */

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

  constructor(info: ErrorInfo) {
    super(info.message);
    this.name = 'MembraneError';
    this.type = info.type;
    this.retryable = info.retryable;
    this.retryAfterMs = info.retryAfterMs;
    this.httpStatus = info.httpStatus;
    this.providerErrorCode = info.providerErrorCode;
    this.rawError = info.rawError;
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
    };
  }
}

// ============================================================================
// Error Factory Functions
// ============================================================================

export function rateLimitError(message: string, retryAfterMs?: number, raw?: unknown): MembraneError {
  return new MembraneError({
    type: 'rate_limit',
    message,
    retryable: true,
    retryAfterMs,
    httpStatus: 429,
    rawError: raw,
  });
}

export function contextLengthError(message: string, raw?: unknown): MembraneError {
  return new MembraneError({
    type: 'context_length',
    message,
    retryable: false,
    httpStatus: 400,
    rawError: raw,
  });
}

export function invalidRequestError(message: string, raw?: unknown): MembraneError {
  return new MembraneError({
    type: 'invalid_request',
    message,
    retryable: false,
    httpStatus: 400,
    rawError: raw,
  });
}

export function authError(message: string, raw?: unknown): MembraneError {
  return new MembraneError({
    type: 'auth',
    message,
    retryable: false,
    httpStatus: 401,
    rawError: raw,
  });
}

export function serverError(message: string, httpStatus?: number, raw?: unknown): MembraneError {
  return new MembraneError({
    type: 'server',
    message,
    retryable: true,
    httpStatus: httpStatus ?? 500,
    rawError: raw,
  });
}

export function networkError(message: string, raw?: unknown): MembraneError {
  return new MembraneError({
    type: 'network',
    message,
    retryable: true,
    rawError: raw,
  });
}

export function timeoutError(message: string, raw?: unknown): MembraneError {
  return new MembraneError({
    type: 'timeout',
    message,
    retryable: true,
    rawError: raw,
  });
}

export function abortError(message: string = 'Request was aborted'): MembraneError {
  return new MembraneError({
    type: 'abort',
    message,
    retryable: false,
    rawError: undefined,
  });
}

export function safetyError(message: string, raw?: unknown): MembraneError {
  return new MembraneError({
    type: 'safety',
    message,
    retryable: false,
    rawError: raw,
  });
}

export function unsupportedError(message: string): MembraneError {
  return new MembraneError({
    type: 'unsupported',
    message,
    retryable: false,
    rawError: undefined,
  });
}

// ============================================================================
// Error Classification
// ============================================================================

export function classifyError(error: unknown): ErrorInfo {
  if (error instanceof MembraneError) {
    return error.toErrorInfo();
  }

  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    
    // Rate limit
    if (message.includes('rate') || message.includes('429') || message.includes('too many')) {
      return {
        type: 'rate_limit',
        message: error.message,
        retryable: true,
        httpStatus: 429,
        rawError: error,
      };
    }
    
    // Context length
    if (message.includes('context') || message.includes('too long') || message.includes('maximum')) {
      return {
        type: 'context_length',
        message: error.message,
        retryable: false,
        rawError: error,
      };
    }
    
    // Auth
    if (message.includes('auth') || message.includes('401') || message.includes('api key')) {
      return {
        type: 'auth',
        message: error.message,
        retryable: false,
        httpStatus: 401,
        rawError: error,
      };
    }
    
    // Network
    if (message.includes('network') || message.includes('econnreset') || message.includes('socket')) {
      return {
        type: 'network',
        message: error.message,
        retryable: true,
        rawError: error,
      };
    }
    
    // Timeout
    if (message.includes('timeout') || message.includes('timed out')) {
      return {
        type: 'timeout',
        message: error.message,
        retryable: true,
        rawError: error,
      };
    }
    
    // Abort
    if (message.includes('abort') || error.name === 'AbortError') {
      return {
        type: 'abort',
        message: error.message,
        retryable: false,
        rawError: error,
      };
    }
    
    // Server error
    if (message.includes('500') || message.includes('502') || message.includes('503') || message.includes('504')) {
      return {
        type: 'server',
        message: error.message,
        retryable: true,
        rawError: error,
      };
    }
  }

  // Unknown
  return {
    type: 'unknown',
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
    rawError: error,
  };
}
