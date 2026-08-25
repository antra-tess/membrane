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
// HTTP Boundary Classification
// ============================================================================

/**
 * The part of a `Response` this module needs. Structural so a stubbed
 * response in a test is as good as a real one.
 */
export interface HttpErrorResponseLike {
  status: number;
  headers?: { get(name: string): string | null } | undefined;
}

interface ProviderErrorFields {
  message?: string;
  code?: string;
  param?: string;
  retryAfterMs?: number;
}

/**
 * Provider error codes/types that carry an implied HTTP status. Used only
 * when no status is in hand — an in-band error object inside a 200, or an
 * SDK error whose status is undefined (Anthropic rethrows mid-stream SSE
 * `error` events exactly that way).
 */
const PROVIDER_ERROR_CODE_STATUS: Record<string, number> = {
  invalid_request_error: 400,
  invalid_argument: 400,
  failed_precondition: 400,
  context_length_exceeded: 400,
  authentication_error: 401,
  invalid_api_key: 401,
  unauthenticated: 401,
  permission_error: 403,
  permission_denied: 403,
  not_found_error: 404,
  not_found: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  rate_limit_exceeded: 429,
  insufficient_quota: 429,
  resource_exhausted: 429,
  api_error: 500,
  server_error: 500,
  internal: 500,
  unavailable: 503,
  overloaded_error: 529,
};

/**
 * 429s that will never succeed on retry: the account, not the request rate,
 * is the problem. Distinguishable only because the boundary now carries the
 * provider's own error code.
 */
const NON_RETRYABLE_RATE_LIMIT_CODES = new Set([
  'insufficient_quota',
  'billing_hard_limit_reached',
  'billing_not_active',
  'account_deactivated',
  'quota_exceeded',
  'insufficient_credits',
]);

const CONTEXT_LENGTH_PATTERN =
  /context[ _-]?length|context window|maximum context|too many tokens|token limit|prompt is too long|too long/i;

const RATE_LIMIT_PATTERN = /\b429\b|rate[ _-]?limit|too many requests/i;

const SERVER_STATUS_PATTERN = /\b(500|502|503|504|529)\b/;

const OVERLOADED_PATTERN = /\b529\b|overloaded_error/i;

function firstString(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate;
  }
  return undefined;
}

/** `retry-after` is either delta-seconds or an HTTP-date (RFC 9110). */
function parseRetryAfterHeader(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(parseFloat(trimmed) * 1000);
  const parsedDate = Date.parse(trimmed);
  if (!Number.isNaN(parsedDate)) return Math.max(0, parsedDate - Date.now());
  return undefined;
}

/** Body-carried retry hints: google's `retryDelay: '21s'`, or bare seconds. */
function parseRetryDelayValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value * 1000);
  if (typeof value !== 'string') return undefined;
  const seconds = value.trim().match(/^(\d+(?:\.\d+)?)s?$/);
  return seconds?.[1] ? Math.round(parseFloat(seconds[1]) * 1000) : undefined;
}

function retryAfterFromBody(root: Record<string, unknown>, errorNode: Record<string, unknown>): number | undefined {
  const details = errorNode.details ?? root.details;
  if (Array.isArray(details)) {
    for (const detail of details) {
      if (detail && typeof detail === 'object') {
        const delay = parseRetryDelayValue((detail as Record<string, unknown>).retryDelay);
        if (delay !== undefined) return delay;
      }
    }
  }
  const millis = errorNode.retry_after_ms ?? root.retry_after_ms;
  if (typeof millis === 'number' && Number.isFinite(millis)) return Math.round(millis);
  return parseRetryDelayValue(errorNode.retry_after ?? root.retry_after ?? errorNode.retryAfter ?? root.retryAfter);
}

/**
 * Pull the fields providers actually put on an error body. Accepts either a
 * parsed body or the raw text as received — a non-JSON body still yields its
 * text as the message rather than being discarded.
 */
export function extractProviderErrorFields(body: unknown): ProviderErrorFields {
  if (body === undefined || body === null) return {};

  if (typeof body === 'string') {
    const text = body.trim();
    if (text === '') return {};
    if (!text.startsWith('{') && !text.startsWith('[')) return { message: body };
    try {
      return extractProviderErrorFields(JSON.parse(text));
    } catch {
      return { message: body };
    }
  }

  if (typeof body !== 'object') return { message: String(body) };

  const root = body as Record<string, unknown>;
  const nested = root.error;
  const errorNode =
    nested !== null && typeof nested === 'object' ? (nested as Record<string, unknown>) : root;

  return {
    message: firstString(errorNode.message, errorNode.Message, root.message, root.Message, errorNode.detail),
    code: firstString(errorNode.code, errorNode.status, errorNode.type, root.__type, root.code),
    param: firstString(errorNode.param),
    retryAfterMs: retryAfterFromBody(root, errorNode),
  };
}

function classifyByStatus(
  status: number,
  code: string | undefined,
  message: string,
): { type: MembraneErrorType; retryable: boolean } {
  const normalizedCode = code?.toLowerCase() ?? '';

  if (status === 429) {
    return { type: 'rate_limit', retryable: !NON_RETRYABLE_RATE_LIMIT_CODES.has(normalizedCode) };
  }
  if (status === 408) return { type: 'timeout', retryable: true };
  if (status === 401 || status === 402 || status === 403) return { type: 'auth', retryable: false };
  if (status === 413) return { type: 'context_length', retryable: false };
  if (status === 404) return { type: 'invalid_request', retryable: false };
  // Context-length is a request-shape problem and only ever arrives as a 4xx.
  // Checking the message BEFORE the status would let a transient 5xx whose
  // body happens to say "context" or "too long" become a non-retryable
  // context_length, silently suppressing retries.
  if (status === 400 || status === 422) {
    const looksLikeContextOverflow =
      normalizedCode === 'context_length_exceeded' || CONTEXT_LENGTH_PATTERN.test(message);
    return {
      type: looksLikeContextOverflow ? 'context_length' : 'invalid_request',
      retryable: false,
    };
  }
  if (status >= 500) return { type: 'server', retryable: true };
  if (status >= 400) return { type: 'invalid_request', retryable: false };
  return { type: 'unknown', retryable: false };
}

/**
 * Build a MembraneError from a provider failure whose status may have to be
 * recovered from the error code (in-band error object, or an SDK error that
 * carries no status).
 */
export function errorFromProviderStatus(params: {
  provider: string;
  status?: number | undefined;
  body?: unknown;
  message?: string;
  retryAfterMs?: number | undefined;
  rawError?: unknown;
  rawRequest?: unknown;
}): MembraneError {
  const fields = extractProviderErrorFields(params.body);
  const code = fields.code;
  const status = params.status ?? PROVIDER_ERROR_CODE_STATUS[code?.toLowerCase() ?? ''];
  const detail = firstString(params.message, fields.message) ?? renderBody(params.body);
  const message =
    params.message ??
    `${params.provider} API error ${status ?? code ?? 'failure'}: ${detail}${
      fields.param ? ` (param: ${fields.param})` : ''
    }`;
  const retryAfterMs = params.retryAfterMs ?? fields.retryAfterMs;

  const classification =
    status !== undefined
      ? { ...classifyByStatus(status, code, detail), httpStatus: status }
      : classifyMessage(message);

  return new MembraneError({
    type: classification.type,
    message,
    retryable: classification.retryable,
    retryAfterMs,
    httpStatus: classification.httpStatus,
    providerErrorCode: code,
    rawError: params.rawError ?? params.body,
    rawRequest: params.rawRequest,
  });
}

/**
 * The fetch boundary: the one place where status, headers and body are all
 * still live. Everything downstream reads the classification off the error
 * instead of re-deriving one by substring over a rendered string.
 */
export function errorFromHttpResponse(
  provider: string,
  response: HttpErrorResponseLike,
  parsedBody: unknown,
  rawRequest?: unknown
): MembraneError {
  return errorFromProviderStatus({
    provider,
    status: response.status,
    body: parsedBody,
    retryAfterMs: parseRetryAfterHeader(response.headers?.get('retry-after')),
    rawRequest,
  });
}

/**
 * Attach the raw request to an error that was already classified at the
 * boundary, without re-deriving anything.
 */
export function withRawRequest(error: MembraneError, rawRequest: unknown): MembraneError {
  if (rawRequest === undefined || error.rawRequest !== undefined) return error;
  return new MembraneError({ ...error.toErrorInfo(), rawRequest });
}

/**
 * A cancellation is a TYPE, never a phrase. Matching 'abort' anywhere in a
 * message turned any error whose text merely contained it — a host tool
 * throwing "zz-tool policy aborted the run" — into a well-formed
 * "the user cancelled" response, destroying the real error.
 */
export function isTypedAbortError(error: unknown): boolean {
  if (error instanceof MembraneError) return error.type === 'abort';
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return error.name === 'AbortError';
  }
  if (error instanceof Error) {
    // APIUserAbortError: the Anthropic SDK's own typed abort.
    return error.name === 'AbortError' || error.name === 'APIUserAbortError';
  }
  return false;
}

function renderBody(body: unknown): string {
  if (body === undefined || body === null) return '';
  if (typeof body === 'string') return body;
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
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
 * ~10-minute schedule. The 529 arm is word-boundary anchored because an
 * unanchored one promoted ordinary retryable errors whose text merely
 * contained the digits ("timeout after 5290 ms", "req-98529abc"). The
 * provider handlers' own bare-'overloaded' safety nets attach httpStatus
 * 529, so those still land here via the status check.
 */
export function isOverloadedError(info: ErrorInfo): boolean {
  if (!info.retryable) return false;
  if (info.httpStatus === 529) return true;
  return OVERLOADED_PATTERN.test(info.message);
}

/**
 * Last-resort classification for throwables that never carried an HTTP
 * response: SDK errors, socket failures, internal bugs. HTTP failures are
 * classified at the boundary (`errorFromHttpResponse`) where the status is
 * still in hand, so this table no longer has to guess at one.
 *
 * The patterns are deliberately narrow. Bare `rate` promoted anything
 * containing "generated"/"moderate"/"accurate" to a retryable 429, and bare
 * `maximum` turned an internal TypeError ("...reading 'maximum'") into a
 * provider context_length. Status digits are word-boundary anchored, and the
 * server-status arm is tested BEFORE context-length so a transient 5xx whose
 * body mentions "context" stays retryable.
 */
function classifyMessage(rawMessage: string): {
  type: MembraneErrorType;
  retryable: boolean;
  httpStatus?: number;
} {
  const message = rawMessage.toLowerCase();

  if (RATE_LIMIT_PATTERN.test(message)) {
    return { type: 'rate_limit', retryable: true, httpStatus: 429 };
  }

  if (/\b401\b|\bapi key\b|unauthorized|authentication|authorization/.test(message)) {
    return { type: 'auth', retryable: false, httpStatus: 401 };
  }

  if (/network|econnreset|econnrefused|socket/.test(message)) {
    return { type: 'network', retryable: true };
  }

  if (/timeout|timed out/.test(message)) {
    return { type: 'timeout', retryable: true };
  }

  if (SERVER_STATUS_PATTERN.test(message) || /overloaded_error/.test(message)) {
    return { type: 'server', retryable: true };
  }

  if (CONTEXT_LENGTH_PATTERN.test(message)) {
    return { type: 'context_length', retryable: false };
  }

  return { type: 'unknown', retryable: false };
}

export function classifyError(error: unknown): ErrorInfo {
  if (error instanceof MembraneError) {
    return error.toErrorInfo();
  }

  // Serialize the error once for use in all return paths
  const serializedError = serializeError(error);

  if (error instanceof Error) {
    // Abort is decided by type, never by prose: a tool or provider message
    // that merely contains "abort" is not a user cancellation.
    if (error.name === 'AbortError') {
      return {
        type: 'abort',
        message: error.message,
        retryable: false,
        rawError: serializedError,
      };
    }

    const classification = classifyMessage(error.message);
    if (classification.type !== 'unknown') {
      return {
        type: classification.type,
        message: error.message,
        retryable: classification.retryable,
        httpStatus: classification.httpStatus,
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
