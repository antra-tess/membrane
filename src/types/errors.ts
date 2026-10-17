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

  /**
   * How many times membrane sent the request for this failure: 1 when it
   * didn't retry it, more when it sent the request again after earlier sends
   * failed before anything arrived. A send that delivered anything before it
   * failed can't be retried, so its error says 1, and a refusal re-issue
   * (refusalRetries) starts the count again. Set on the error a failed
   * provider call ends with, from complete() and from each provider call of
   * stream() and streamYielding(); in a tool loop it counts the round that
   * failed. A complete() cancelled after a send carries it too, and so does
   * a `backoff` event's error: the sends so far. A caller with its own retry
   * policy reads it to tell whether membrane has already retried this
   * failure.
   */
  attempts?: number;
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
  /** See ErrorInfo.attempts. */
  readonly attempts?: number;

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
    if (info.attempts !== undefined) this.attempts = info.attempts;
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
      ...(this.attempts !== undefined ? { attempts: this.attempts } : {}),
    };
  }
}

/**
 * A build reported `ready: false` — the caller declared one of the request's
 * `tool_use` ids still in flight (`BuildOptions.pendingToolCallIds`), so the
 * tool-pair normalizer left it unmatched rather than papering over it with a
 * synthetic `[pending]` result. Shipping that request would produce exactly
 * the 400 the normalizer exists to prevent.
 *
 * Not retryable as-is: the request is deterministic, and the fix is to wait
 * for the in-flight result to land, append it, and rebuild.
 */
export class MembraneNotReadyError extends MembraneError {
  readonly formatterName: string;

  constructor(formatterName: string) {
    super({
      type: 'invalid_request',
      message:
        `Request is not ready to send: formatter '${formatterName}' returned ready=false, ` +
        `meaning a tool_use in this request has no result yet and its id was declared ` +
        `in-flight via pendingToolCallIds. Wait for the in-flight tool result, append it to ` +
        `the conversation, and rebuild — sending now would ship an unmatched tool_use.`,
      retryable: false,
      rawError: undefined,
    });
    this.name = 'MembraneNotReadyError';
    this.formatterName = formatterName;
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
  /** google.rpc.ErrorInfo `reason` from `details[]`, e.g. `API_KEY_INVALID`. */
  reason?: string;
  /** A google.rpc.QuotaFailure in `details[]` names a quota no retry within a call or a backoff can outlast. */
  terminalQuota?: boolean;
  /**
   * The upstream provider's own message, when a router wraps it: OpenRouter
   * puts the provider's raw error body in `error.metadata.raw` beside a
   * generic "Provider returned error". Read for classification only, and
   * only as that body's own message: a body with none, rendered, could echo
   * the request.
   */
  upstreamMessage?: string;
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

/**
 * The forms providers use for a request that exceeds the model's context.
 * Anthropic: "input length and `max_tokens` exceed context limit: N + M >
 * L" and "prompt is too long: N tokens > M maximum"; Gemini: "The input
 * token count (N) exceeds the maximum number of input tokens allowed (M)";
 * OpenAI: `context_length_exceeded` / "maximum context length". Read only
 * under a 400/422 (or with no status at all, after the 5xx arm), and with a
 * status only over the provider's own error message (see
 * errorFromProviderStatus). A bare "too long" is not among them: a provider
 * says that of a field, such as a string past its maximum length, which no
 * shorter history fixes. The prompt or input said to be too long, with or
 * without "is" (Bedrock's "Input is too long for requested model."), is.
 * The status-less path reads the same forms (classifyMessage).
 */
const CONTEXT_LENGTH_PATTERN =
  /context[ _-]?(?:length|limit|window)|maximum context|too many tokens|token limit|(?:prompt|input)(?: is)? too long|exceeds? the maximum number of (?:input )?tokens|input token count/i;

// "rate limit" only where no letter precedes it, so "moderate limit" and
// "generate limit" aren't rate limits, while "user_rate_limit" still is.
const RATE_LIMIT_PATTERN = /\b429\b|(?<![a-z])rate[ _-]?limit|too many requests/i;

const SERVER_STATUS_PATTERN = /\b(500|502|503|504|529)\b/;

const OVERLOADED_PATTERN = /\b529\b|overloaded_error/i;

/**
 * Structured evidence that a 400 is a credential failure, not a malformed
 * request: Google answers a bad key with HTTP 400 INVALID_ARGUMENT whose
 * `details[]` ErrorInfo reason is `API_KEY_INVALID`, and some gateways send
 * OpenAI-style `invalid_api_key` codes with a 400. The status stays as sent.
 */
const AUTH_REASONS = new Set(['api_key_invalid', 'api_key_expired', 'access_token_expired']);
const AUTH_CODES = new Set(['invalid_api_key', 'authentication_error', 'unauthenticated', 'permission_error', 'permission_denied']);

/**
 * Refusals of the account or its credential, not the request, as a 400 or
 * 422 or with no status: "Your credit balance is too low to access the
 * Anthropic API", "You have reached your specified API usage limits. You
 * will regain access on <date>", "This organization has been disabled.", and
 * "This credential is only authorized for use with Claude Code and cannot be
 * used for other API requests." (a Claude subscription's OAuth token sent to
 * the API). Anthropic sends the first, second and fourth as
 * `invalid_request_error` with no code of their own, so only the text tells
 * them apart; the disabled organization's type isn't attested. The text is
 * matched from any provider. Like a 402 they are `auth`: no retry and no
 * change to the request succeeds until the account or the credential
 * changes. They are read inside a router's wrapper too. There the account
 * may be the router's own, which another route might serve, but membrane
 * can't tell, and the type is what matters: as `invalid_request` the refusal
 * reaches agent-framework's poison-history breaker, which sheds history over
 * it, and `auth` never does. A router's quota is another matter:
 * retryability is all that rides on it, so it stays retryable (see
 * quotaFailureIsTerminal). Like the context-length forms, these are read only
 * over the provider's own error message, never over a body that might echo
 * the request, with or without a status.
 */
const ACCOUNT_REFUSAL_PATTERN =
  /credit balance is too low|reached your specified API usage limits|organization has been disabled|only authorized for use with Claude Code/i;

/**
 * A retry hint stated only in prose: Azure OpenAI's "Please retry after 60
 * seconds." The unit is required and a sentence boundary must follow, so
 * minutes, hours, a timestamp or "retry after 3 attempts" never read as a
 * wait in seconds.
 */
const RETRY_AFTER_PROSE = /\bretry after (\d+(?:\.\d+)?) ?(?:s|secs?|seconds?)(?=\s*(?:[.!;,)]|$))/i;

/** Socket-level failure codes on an error or its `cause` (Node, undici, Bun). */
const NETWORK_ERROR_CODES = new Set([
  'econnreset', 'econnrefused', 'enotfound', 'eai_again', 'epipe', 'ehostunreach', 'enetunreach', 'econnaborted',
  'und_err_socket', 'connectionrefused', 'connectionclosed', 'connectionreset',
]);
const TIMEOUT_ERROR_CODES = new Set(['etimedout', 'und_err_connect_timeout', 'und_err_headers_timeout', 'und_err_body_timeout']);
/**
 * Undici's own deadlines on a request it already sent: no response headers
 * within headersTimeout, or no body data within bodyTimeout (300 s each by
 * default). Each is a call's budget spent, so errorFromThrown marks it
 * deadlineExpired. Its connect timeout and the system's ETIMEDOUT aren't
 * here: they're sent again like any connection failure.
 */
const SENT_REQUEST_DEADLINE_CODES = new Set(['und_err_headers_timeout', 'und_err_body_timeout']);

/**
 * Whether a failure is a runtime's own deadline on a request it sent: one of
 * undici's above, or Bun's fetch timeout, a DOMException named TimeoutError
 * (Bun 1.4.3 threw it after 360 s at a server that never answered). It
 * doesn't say which stage ran out, so a stalled connect is marked too. Its
 * code, 23, is a number, which the code check doesn't read, so the name decides,
 * anywhere down the cause chain: the Anthropic SDK's MessageStream wraps a
 * failed read once more. A caller's AbortSignal.timeout() rejects the same
 * way, but membrane reads the caller's signal before the error, so that one
 * stays a cancellation.
 */
function isSentRequestDeadline(error: unknown): boolean {
  if (socketCodes(error).some((code) => SENT_REQUEST_DEADLINE_CODES.has(code))) return true;
  return causeChain(error).some((link) => (link as { name?: unknown }).name === 'TimeoutError');
}

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
  // A digit string, as the SSE frame reader also accepts for this field.
  if (typeof millis === 'string' && /^\d+$/.test(millis.trim())) return Number(millis.trim());
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

  // A body wrapped in an array, as `[{"error": {...}}]`: its first entry is
  // the error.
  if (Array.isArray(body)) {
    const first = body.find((entry) => entry !== null && typeof entry === 'object');
    return first === undefined ? {} : extractProviderErrorFields(first);
  }

  const root = body as Record<string, unknown>;
  const nested = root.error;
  const errorNode =
    nested !== null && typeof nested === 'object' ? (nested as Record<string, unknown>) : root;
  // The provider's own message in the other shapes it comes in: a string
  // `error` (`{"error": "..."}`), or the first of a top-level `errors` list.
  // (Google's older format also lists `errors` inside its error object, but
  // always beside that object's own `message`, which is read first.)
  const firstListed = Array.isArray(root.errors)
    ? root.errors.find((entry) => entry !== null && typeof entry === 'object') as Record<string, unknown> | undefined
    : undefined;

  const metadata = errorNode.metadata;
  const upstreamRaw =
    metadata !== null && typeof metadata === 'object' ? (metadata as Record<string, unknown>).raw : undefined;
  const upstream = upstreamRaw !== undefined && upstreamRaw !== null && upstreamRaw !== body
    ? extractProviderErrorFields(upstreamRaw)
    : undefined;

  return {
    message: firstString(errorNode.message, errorNode.Message, root.message, root.Message, errorNode.detail,
      typeof nested === 'string' ? nested : undefined, firstListed?.message),
    // A numeric code can be an HTTP-shaped status or a provider-local number.
    // Prefer a symbolic classification token; the original scalar stays in rawError.
    // A router's wrapper gives its own code, not the upstream provider's: the
    // upstream's stays in rawError, inside the raw body it came in.
    code: firstString(...[errorNode.code, errorNode.status, errorNode.type, root.__type, root.code]
      .filter(value => typeof value === 'string' && !/^\d+$/.test(value.trim())))
      ?? firstString(errorNode.code, errorNode.status, errorNode.type, root.__type, root.code),
    param: firstString(errorNode.param),
    retryAfterMs: retryAfterFromBody(root, errorNode),
    reason: errorInfoReason(errorNode.details ?? root.details),
    // The body's own details only, never a router's upstream body: through
    // OpenRouter a Google quota may be the router's shared one, which another
    // route can still serve.
    terminalQuota: quotaFailureIsTerminal(errorNode.details ?? root.details),
    upstreamMessage: upstream?.message,
  };
}

/**
 * Whether a google.rpc.QuotaFailure in `details[]` names a quota that no
 * retry within the call, and no caller's backoff, can outlast: one with no
 * allocation at all (`quotaValue` 0; proto3 JSON renders the int64 as the
 * string "0", and a parser takes the number too), or a daily window (a
 * `quotaId` naming PerDay or Daily, which is how gemini-cli's own classifier
 * reads it), which resets only once the day is out. Such a 429 isn't
 * retryable; the body's RetryInfo delay is still reported, for a caller that
 * schedules work that late. Any one such violation decides. A per-minute
 * quota with an allocation stays retryable. Only details entries that are a
 * QuotaFailure by their `@type`, or carry none, are read.
 */
function quotaFailureIsTerminal(details: unknown): boolean {
  if (!Array.isArray(details)) return false;
  return details.some((detail) => {
    if (!detail || typeof detail !== 'object') return false;
    const { '@type': type, violations } = detail as Record<string, unknown>;
    if (typeof type === 'string' && !type.endsWith('google.rpc.QuotaFailure')) return false;
    return Array.isArray(violations) && violations.some((violation) => {
      if (!violation || typeof violation !== 'object') return false;
      const { quotaValue, quotaId } = violation as Record<string, unknown>;
      return quotaValue === '0' || quotaValue === 0 || (typeof quotaId === 'string' && /PerDay|Daily/.test(quotaId));
    });
  });
}

/** The `reason` of a google.rpc.ErrorInfo entry in `details[]`, if any. */
function errorInfoReason(details: unknown): string | undefined {
  if (!Array.isArray(details)) return undefined;
  for (const detail of details) {
    if (detail && typeof detail === 'object') {
      const reason = (detail as Record<string, unknown>).reason;
      if (typeof reason === 'string' && reason.trim() !== '') return reason;
    }
  }
  return undefined;
}

function classifyByStatus(
  status: number,
  code: string | undefined,
  message: string,
  reason?: string,
  terminalQuota = false,
): { type: MembraneErrorType; retryable: boolean } {
  const normalizedCode = code?.toLowerCase() ?? '';

  if ((status === 400 || status === 422)
    && (AUTH_REASONS.has(reason?.toLowerCase() ?? '') || AUTH_CODES.has(normalizedCode)
      || ACCOUNT_REFUSAL_PATTERN.test(message))) {
    return { type: 'auth', retryable: false };
  }
  if (status === 429) {
    return { type: 'rate_limit', retryable: !NON_RETRYABLE_RATE_LIMIT_CODES.has(normalizedCode) && !terminalQuota };
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
 * The HTTP status a provider's own error code implies, when the shared table
 * knows the code. Adapters with a provider-specific precedence rule use it to
 * read the same status errorFromProviderStatus would classify by.
 */
export function statusForProviderCode(code: string | undefined): number | undefined {
  const key = code?.toLowerCase();
  // Own keys only: a provider code such as "constructor" is not a table entry.
  return key !== undefined && Object.prototype.hasOwnProperty.call(PROVIDER_ERROR_CODE_STATUS, key)
    ? PROVIDER_ERROR_CODE_STATUS[key]
    : undefined;
}

/**
 * Build a MembraneError from a provider failure whose status may have to be
 * recovered from the error code (in-band error object, or an SDK error that
 * carries no status).
 */
export function errorFromProviderStatus(params: {
  provider: string;
  status?: number | undefined;
  /** Provider-specific structured-token inference, after explicit status or a known code. */
  fallbackStatus?: number | undefined;
  body?: unknown;
  message?: string;
  retryAfterMs?: number | undefined;
  /** A provider code carried outside the body (Bedrock's `x-amzn-ErrorType` header), used when the body names none. */
  code?: string | undefined;
  rawError?: unknown;
  rawRequest?: unknown;
}): MembraneError {
  const fields = extractProviderErrorFields(params.body);
  const code = fields.code ?? params.code;
  const status = params.status ?? statusForProviderCode(code) ?? params.fallbackStatus;
  const detail = firstString(params.message, fields.message) ?? renderBody(params.body);
  const message =
    params.message ??
    `${params.provider} API error ${status ?? code ?? 'failure'}: ${detail}${
      fields.param ? ` (param: ${fields.param})` : ''
    }`;
  // With a status, the patterns read the provider's own error message, and a
  // router's upstream message beside it (its generic "Provider returned
  // error" classifies by the upstream provider's own text). The caller's
  // message is read only when there is no body: with one, the caller's is a
  // rendering of it (the Anthropic SDK's "400 {...}", the stream path's
  // description). Never a rendered body: a body with no message field can
  // echo the request, and a prompt that says "context window" or "credit
  // balance is too low" must not type the error.
  const ownText = fields.message ?? (params.body === undefined ? params.message : undefined);
  const evidence = [ownText, fields.upstreamMessage].filter((text): text is string => !!text).join('\n');

  // Without a status the transport patterns read the whole message, but the
  // echo-sensitive ones (an account refusal, a context overflow) read the
  // same evidence as with one, so the same body types the same way.
  const classification =
    status !== undefined
      ? { ...classifyByStatus(status, code, evidence, fields.reason, fields.terminalQuota), httpStatus: status }
      : classifyMessage(fields.upstreamMessage ? `${message}\n${fields.upstreamMessage}` : message, evidence);
  // A wait read from prose is believed only for an error that asks to be
  // retried: a stated wait is a hold for anyone who honours it, and a 400
  // whose text happens to say "retry after", or a 429 no retry can outlast,
  // asks for none. A body's own RetryInfo or header is reported either way.
  const retryAfterMs = params.retryAfterMs ?? fields.retryAfterMs
    ?? (classification.retryable && (classification.type === 'rate_limit' || classification.type === 'server')
      ? retryAfterFromProse(detail) : undefined);

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
    code: amznErrorType(response.headers?.get('x-amzn-errortype')),
    rawRequest,
  });
}

/** Bedrock names its exception in a header: `ThrottlingException:http://internal.amazon.com/...`. */
function amznErrorType(value: string | null | undefined): string | undefined {
  const name = value?.split(':')[0]?.trim();
  return name ? name : undefined;
}

/** A retry hint stated only in the message, when neither header nor body carries one. */
function retryAfterFromProse(message: string): number | undefined {
  const seconds = message.match(RETRY_AFTER_PROSE)?.[1];
  return seconds ? Math.round(parseFloat(seconds) * 1000) : undefined;
}

/**
 * Attach the raw request to an error that was already classified at the
 * boundary, without re-deriving anything.
 */
export function withRawRequest(error: MembraneError, rawRequest: unknown): MembraneError {
  if (rawRequest === undefined || error.rawRequest !== undefined) return error;
  // Preserve object identity, subclass fields and private-field brands. Credential
  // resolvers and deadline handling use the original classified error as evidence.
  // An immutable caller-owned error remains authoritative even without this hint.
  try {
    Object.defineProperty(error, 'rawRequest', { value: rawRequest, enumerable: true, configurable: true });
  } catch { /* A frozen error still propagates unchanged. */ }
  return error;
}

// Symbol.for, like the adapters' deadline-abort mark, so a second loaded copy
// of membrane reads the same mark.
const DEADLINE_EXPIRY = Symbol.for('membrane.deadlineExpiry');

/**
 * Mark an error as a deadline running out on a call that was under way:
 * AnthropicAdapter's idle and first-event watchdogs, every timeout its SDK
 * client reports, and a runtime's own fetch deadlines (errorFromThrown). It
 * stays the retryable timeout a caller sees, but membrane doesn't send the
 * call again: the deadline was the call's budget, and another full one is the
 * caller's to give. (An adapter's `timeoutMs` deadline is a TimeoutAbortError,
 * which isn't retryable at all.) Keeps the error's identity.
 */
export function deadlineExpired<E extends MembraneError>(error: E): E {
  try {
    Object.defineProperty(error, DEADLINE_EXPIRY, { value: true });
  } catch { /* A frozen error is retried like any other timeout. */ }
  return error;
}

/** Whether an error was marked with deadlineExpired. */
export function isDeadlineExpiry(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as Record<symbol, unknown>)[DEADLINE_EXPIRY] === true;
}

/**
 * Record on a failed provider call's error how many times membrane sent the
 * request (ErrorInfo.attempts). Keeps the error's identity, as withRawRequest
 * does; anything other than a MembraneError passes through unchanged.
 */
export function withAttempts<E>(error: E, attempts: number): E {
  if (!(error instanceof MembraneError)) return error;
  try {
    Object.defineProperty(error, 'attempts', { value: attempts, enumerable: true, configurable: true });
  } catch { /* A frozen error still propagates unchanged. */ }
  return error;
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
  // The Anthropic SDK's APIUserAbortError is named 'Error' (measured on
  // @anthropic-ai/sdk 0.52), so no name arm can match it: the Anthropic
  // adapter recognises it by class.
  if (error instanceof Error) return error.name === 'AbortError';
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
 * path it arrived by. Used only to CHOOSE the retry schedule among
 * already-retryable errors, never to decide retryability.
 *
 * A status in hand decides: only 529 is an overload. Every structured overload
 * path already carries it — an HTTP 529, an `overloaded_error` code resolved
 * through the shared code table, an SSE frame's overloaded tokens when the
 * frame states no other error status, and the provider handlers'
 * bare-'overloaded' safety nets. Reading prose past a known
 * status let an explicit 429 take the overload schedule, and gave a 5xx whose
 * body merely mentioned an upstream 529 the overload retry allowance even with
 * `maxRetries: 0`.
 *
 * Only a status-less error falls back to the message, with the same narrow
 * tokens as classifyError (`529` word-boundary anchored, exact
 * `overloaded_error`): a bare 'overloaded' in prose ("worker pool overloaded")
 * or digits inside another number ("timeout after 5290 ms", "req-98529abc")
 * must not put an unrelated error onto the ~10-minute schedule.
 */
export function isOverloadedError(info: ErrorInfo): boolean {
  if (!info.retryable) return false;
  if (info.httpStatus !== undefined) return info.httpStatus === 529;
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
 *
 * `ownText` is the provider's own message, for the patterns a request's echo
 * could otherwise trip (an account refusal, a context overflow), as with a
 * status; it is the message itself when the caller has nothing more precise.
 */
function classifyMessage(rawMessage: string, ownText: string = rawMessage): {
  type: MembraneErrorType;
  retryable: boolean;
  httpStatus?: number;
} {
  const message = rawMessage.toLowerCase();

  if (RATE_LIMIT_PATTERN.test(message)) {
    return { type: 'rate_limit', retryable: true, httpStatus: 429 };
  }

  if (ACCOUNT_REFUSAL_PATTERN.test(ownText)) {
    return { type: 'auth', retryable: false };
  }

  if (/\b401\b|\bapi key\b|unauthorized|authentication|authorization/.test(message)) {
    return { type: 'auth', retryable: false, httpStatus: 401 };
  }

  if (/network|econnreset|econnrefused|socket|\bfetch failed\b|\bfailed to fetch\b/.test(message)) {
    return { type: 'network', retryable: true };
  }

  if (/timeout|timed out/.test(message)) {
    return { type: 'timeout', retryable: true };
  }

  if (SERVER_STATUS_PATTERN.test(message) || /overloaded_error/.test(message)) {
    return { type: 'server', retryable: true };
  }

  if (CONTEXT_LENGTH_PATTERN.test(ownText)) {
    return { type: 'context_length', retryable: false };
  }

  return { type: 'unknown', retryable: false };
}

/**
 * A transport failure named by its code, on the error or down its causes:
 * Node's `fetch failed` hides `ECONNREFUSED` in `cause.code`, and Bun's "Unable to
 * connect. Is the computer able to access the url?" carries
 * `code: 'ConnectionRefused'` (the same text for a DNS failure). The message
 * names neither.
 */
function classifySocketCode(error: Error): { type: MembraneErrorType; retryable: boolean; httpStatus?: number } | undefined {
  for (const key of socketCodes(error)) {
    if (NETWORK_ERROR_CODES.has(key)) return { type: 'network', retryable: true };
    if (TIMEOUT_ERROR_CODES.has(key)) return { type: 'timeout', retryable: true };
  }
  return undefined;
}

/**
 * The lowercased string codes on an error and down its chain of causes,
 * outermost first. Node's fetch hides undici's error in `cause`, and the
 * Anthropic SDK's MessageStream wraps a failed read once more (an
 * AnthropicError whose cause is the `terminated` TypeError), so the code can
 * sit two causes down.
 */
function socketCodes(error: unknown): string[] {
  return causeChain(error)
    .map((link) => (link as { code?: unknown }).code)
    .filter((code): code is string => typeof code === 'string')
    .map((code) => code.toLowerCase());
}

/** An error and its causes, outermost first, at most four deep. */
function causeChain(error: unknown): object[] {
  const chain: object[] = [];
  let current = error;
  while (typeof current === 'object' && current !== null && !chain.includes(current) && chain.length < 4) {
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

/**
 * The MembraneError for a failure an adapter caught that isn't one yet, such
 * as what `fetch` throws: typed by classifyError, with the request attached.
 * A runtime's deadline on a request it already sent (undici's headers and
 * body timeouts, Bun's fetch timeout) is marked deadlineExpired, as an
 * adapter's own watchdog is, so membrane leaves it to the caller.
 */
export function errorFromThrown(error: unknown, rawRequest?: unknown): MembraneError {
  // Already typed: keep it, and its marks, as it is.
  if (error instanceof MembraneError) return withRawRequest(error, rawRequest);
  const info = classifyError(error);
  info.rawRequest = rawRequest;
  const typed = new MembraneError(info);
  // A mark the error already carries, as a second loaded copy of membrane
  // sets one on its own MembraneError, stays on the new one.
  return isSentRequestDeadline(error) || isDeadlineExpiry(error) ? deadlineExpired(typed) : typed;
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
    // A runtime's own timeout (Bun's fetch deadline) is named, whatever its
    // message says. A caller's AbortSignal.timeout() rejects the same way, and
    // membrane still ends that call as a cancellation, from the caller's signal.
    if (causeChain(error).some((link) => (link as { name?: unknown }).name === 'TimeoutError')) {
      return { type: 'timeout', message: error.message, retryable: true, rawError: serializedError };
    }

    const classification = classifySocketCode(error) ?? classifyMessage(error.message);
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
