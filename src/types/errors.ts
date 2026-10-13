/**
 * Error types for membrane
 */

import { createHash } from 'node:crypto';

// ============================================================================
// Bounding provider-derived text
// ============================================================================

/**
 * Longest message a MembraneError carries, in UTF-16 code units.
 *
 * A provider's error body is arbitrary remote text, and some providers echo
 * the entire rejected request in it: one OpenAI-compatible 400 returned a
 * ~1.7 MB body. Whatever the boundary puts in `message` then travels
 * everywhere the error does: the stack trace, `onError` hooks, stderr, call
 * logs, and the failure notice a framework stores in an agent's own context.
 * The head keeps what every boundary writes first (provider, status, code,
 * the provider's own explanation); the tail keeps a provider's closing detail.
 */
export const MAX_ERROR_MESSAGE_CHARS = 2_000;

/**
 * Aggregate bound on a MembraneError's `rawError`, in UTF-8 bytes of its JSON
 * serialization: nested bodies, headers and any other enumerable properties
 * all count toward it. A value within the bound is kept exactly as it is.
 */
export const MAX_RAW_ERROR_JSON_BYTES = 16 * 1024;

/** Longest provider error code kept verbatim; real codes are short tokens. */
export const MAX_PROVIDER_ERROR_CODE_CHARS = 128;

/** Characters of serialized JSON kept as `head` when a rawError is summarized. */
const RAW_ERROR_SUMMARY_HEAD_CHARS = 2_048;

const isLowSurrogate = (text: string, index: number): boolean => {
  const code = text.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff;
};

/** End a head before a pair whose low half would start the cut: the head only shrinks. */
function headCut(text: string, index: number): number {
  return index > 0 && isLowSurrogate(text, index) ? index - 1 : index;
}

/** Start a tail after the low half of a pair the cut would split: the tail only shrinks. */
function tailCut(text: string, index: number): number {
  return index < text.length && isLowSurrogate(text, index) ? index + 1 : index;
}

/**
 * `text` when it fits within `max` characters; otherwise its head and tail
 * around a marker that states how much was omitted from how much, the whole
 * no longer than `max`. The marker makes the excerpt self-describing wherever
 * it ends up: a reader of a log line or a failure notice can see that the
 * provider said more than this. Bounding bounded text returns it unchanged.
 */
export function boundErrorText(text: string, max: number = MAX_ERROR_MESSAGE_CHARS): string {
  if (text.length <= max) return text;
  // The omitted count has at most as many digits as the total length.
  const markerLength = ` …[${text.length} of ${text.length} characters omitted]… `.length;
  const budget = Math.max(0, max - markerLength);
  const tailLength = Math.floor(budget / 4);
  // Each cut moves only toward omission, so the result stays within max and
  // never holds half of a surrogate pair.
  const headEnd = headCut(text, budget - tailLength);
  const tailStart = tailCut(text, text.length - tailLength);
  const omitted = tailStart - headEnd;
  return `${text.slice(0, headEnd)} …[${omitted} of ${text.length} characters omitted]… ${text.slice(tailStart)}`;
}

/** A provider error code, verbatim when it is token-sized; otherwise its head and length. */
function boundProviderErrorCode(code: string | undefined): string | undefined {
  if (code === undefined || code.length <= MAX_PROVIDER_ERROR_CODE_CHARS) return code;
  return `${code.slice(0, headCut(code, 64))}…[${code.length} characters]`;
}

/**
 * JSON.stringify that survives cycles and BigInt: a value already open on the
 * path to the current one is written as "[Circular]", and a BigInt as its
 * decimal string. Repeated non-cyclic references serialize normally.
 */
function stringifyAcyclic(value: unknown): string | undefined {
  const ancestors: unknown[] = [];
  return JSON.stringify(value, function (this: unknown, _key: string, current: unknown) {
    if (typeof current === 'bigint') return current.toString();
    if (typeof current !== 'object' || current === null) return current;
    while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
    if (ancestors.includes(current)) return '[Circular]';
    ancestors.push(current);
    return current;
  });
}

/**
 * Enforce `MAX_RAW_ERROR_JSON_BYTES` on a rawError, measured in UTF-8 bytes of
 * its JSON serialization. Within the bound, the value is returned unchanged.
 * Beyond it, a summary replaces it: the size and sha256 of what was received
 * (so identical bodies are recognizable without being kept) and its first
 * `RAW_ERROR_SUMMARY_HEAD_CHARS` characters. A string body (the usual raw
 * HTTP body) is summarized as received text, `bytes`; anything else as its
 * JSON, `jsonBytes`. A cyclic value is replaced by its acyclic JSON form
 * (bounded the same way), and a value that cannot be serialized at all by a
 * short description, so a pathological error object can never break the
 * error path.
 */
export function boundRawError(value: unknown): unknown {
  if (value === undefined || value === null) return value;
  let json: string | undefined;
  let rewritten = false;
  try {
    json = JSON.stringify(value);
  } catch {
    rewritten = true;
    try {
      json = stringifyAcyclic(value);
    } catch (error) {
      // Read guarded: a throwing name or message getter must not make the
      // bound throw in place of the failure it describes.
      let reason: string;
      try {
        reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      } catch {
        reason = 'unknown';
      }
      return { truncated: true, unserializable: boundErrorText(reason, 200), valueType: typeof value };
    }
  }
  // Functions, symbols and undefined have no JSON form and take no space in one.
  if (json === undefined) return value;
  // UTF-8 takes at most three bytes per UTF-16 code unit, so a JSON text no
  // longer than a third of the bound fits without counting; only a near miss
  // pays for the exact count.
  if (json.length <= MAX_RAW_ERROR_JSON_BYTES / 3 || Buffer.byteLength(json, 'utf8') <= MAX_RAW_ERROR_JSON_BYTES) {
    return rewritten ? JSON.parse(json) : value;
  }
  if (typeof value === 'string') {
    return {
      truncated: true,
      bytes: Buffer.byteLength(value, 'utf8'),
      sha256: createHash('sha256').update(value).digest('hex'),
      head: value.slice(0, headCut(value, RAW_ERROR_SUMMARY_HEAD_CHARS)),
    };
  }
  return {
    truncated: true,
    jsonBytes: Buffer.byteLength(json, 'utf8'),
    sha256: createHash('sha256').update(json).digest('hex'),
    head: json.slice(0, headCut(json, RAW_ERROR_SUMMARY_HEAD_CHARS)),
  };
}

/** One line describing why a value could not be read, bounded. */
function unreadable(error: unknown): string {
  let reason: string;
  try {
    reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  } catch {
    reason = 'unknown';
  }
  return `[unreadable: ${boundErrorText(reason, 200)}]`;
}

/**
 * A value a JavaScript caller passed where a string belongs, as text:
 * undefined as '' (what `new Error(undefined)` gives), anything else as its
 * String form, or as unreadable when converting it throws.
 */
function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  try {
    return String(value);
  } catch (error) {
    return unreadable(error);
  }
}

// ============================================================================
// Error Serialization Helper
// ============================================================================

/**
 * Serialize an error for a rawError field, a host's record or a hook's
 * ErrorInfo. Error objects don't JSON.stringify well (they become {}), so an
 * Error's name, message and stack are copied out with its own enumerable
 * fields, and an Error held in one of those fields is serialized the same
 * way, so its text is counted and cut like the rest instead of hiding behind
 * a JSON {}. The message and stack are bounded like a MembraneError's own
 * message, the stack is left out in production, and the whole result, for
 * any value passed, is held to MAX_RAW_ERROR_JSON_BYTES by boundRawError.
 * Every read is guarded: a field whose getter throws, or a value whose
 * prototype can't be asked for, is recorded as unreadable, rather than
 * letting the error being described replace the one the caller is
 * reporting.
 */
export function serializeError(error: unknown): unknown {
  return boundRawError(serializeErrorFields(error, new Set(), 0));
}

/** A read that may throw (a getter, a Proxy trap), recorded instead as unreadable. */
function readGuarded(get: () => unknown): unknown {
  try {
    return get();
  } catch (readError) {
    return unreadable(readError);
  }
}

/** `read()`, or `fallback` when it throws. */
function guardedOr<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

/** Whether `value` is an Error; false when asking throws (a Proxy's getPrototypeOf trap). */
function isErrorValue(value: unknown): value is Error {
  try {
    return value instanceof Error;
  } catch {
    return false;
  }
}

/**
 * The text of a thrown value: an Error's message, or anything else's String
 * form. Every read is guarded, so describing a hostile value (a throwing
 * getter or toString, a Proxy trap) yields `[unreadable: …]` rather than
 * throwing from the code that is reporting it.
 */
export function thrownText(value: unknown): string {
  const isError = isErrorValue(value);
  return asText(readGuarded(() => (isError ? (value as Error).message : String(value))));
}

/** An Error as a plain record, its Error-valued fields likewise; any other value as it is. */
/** How deep serializeErrorFields follows errors held by errors. */
const MAX_SERIALIZED_ERROR_DEPTH = 8;

function serializeErrorFields(error: unknown, open: Set<Error>, depth: number): unknown {
  let isError: boolean;
  try {
    isError = error instanceof Error;
  } catch (askError) {
    // A Proxy whose getPrototypeOf trap throws is described, not kept, so the
    // trap can't fire again wherever the record goes.
    return { truncated: true, unserializable: unreadable(askError) };
  }
  if (!isError) return error;
  const value = error as Error;
  // An error that holds itself, directly or through an error it holds.
  if (open.has(value)) return '[Circular]';
  // A chain of errors holding errors deeper than any real cause chain is cut,
  // so recursion can't exhaust the stack while a failure is being described.
  if (depth >= MAX_SERIALIZED_ERROR_DEPTH) return '[Depth]';
  open.add(value);
  const name = readGuarded(() => value.name);
  const message = readGuarded(() => value.message);
  const serialized: Record<string, unknown> = {
    name,
    message: typeof message === 'string' ? boundErrorText(message) : message,
  };

  // Include stack trace in non-production
  if (process.env.NODE_ENV !== 'production') {
    const stack = readGuarded(() => value.stack);
    if (stack) serialized.stack = typeof stack === 'string' ? boundErrorText(stack) : stack;
  }

  // Copy any additional enumerable properties (like status, code, etc.).
  // name, message and stack were read above. An Error can carry them as own
  // enumerable properties (assigned after a message-less super(), or by
  // Object.assign), and copying them again would replace the bounded
  // message and stack, and bring the stack back in production.
  const keys = readGuarded(() => Object.keys(value));
  for (const key of Array.isArray(keys) ? keys as string[] : []) {
    if (key === 'name' || key === 'message' || key === 'stack') continue;
    serialized[key] = serializeErrorFields(readGuarded(() => (value as unknown as Record<string, unknown>)[key]), open, depth + 1);
  }
  open.delete(value);
  return serialized;
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
    // Bounded here, the one place every adapter, stream-frame classifier, SDK
    // error and membrane rethrow passes through. The classification fields are
    // decided before construction and are never derived from the bounded text;
    // only isOverloadedError reads a status-less error's message afterwards.
    // A JavaScript caller can pass a message or code that isn't a string;
    // its text is bounded rather than the conversion failing the error.
    super(boundErrorText(asText(info.message)));
    this.name = 'MembraneError';
    this.type = info.type;
    this.retryable = info.retryable;
    this.retryAfterMs = info.retryAfterMs;
    this.httpStatus = info.httpStatus;
    this.providerErrorCode = boundProviderErrorCode(
      info.providerErrorCode == null ? undefined : asText(info.providerErrorCode),
    );
    // serializeError turns error objects into records (they'd be {} in JSON)
    // and holds the whole value to its bound. It may not replace the failure
    // being constructed.
    let rawError: unknown;
    try {
      rawError = serializeError(info.rawError);
    } catch (error) {
      rawError = { truncated: true, unserializable: unreadable(error) };
    }
    this.rawError = rawError;
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

/** The marker boundErrorText puts where it cut, counts and all. */
const OMISSION_MARKER = / …\[\d+ of \d+ characters omitted\]… /g;

/**
 * Structured evidence that a 400 is a credential failure, not a malformed
 * request: Google answers a bad key with HTTP 400 INVALID_ARGUMENT whose
 * `details[]` ErrorInfo reason is `API_KEY_INVALID`, and some gateways send
 * OpenAI-style `invalid_api_key` codes with a 400. The status stays as sent.
 */
const AUTH_REASONS = new Set(['api_key_invalid', 'api_key_expired', 'access_token_expired']);
const AUTH_CODES = new Set(['invalid_api_key', 'authentication_error', 'unauthenticated', 'permission_error', 'permission_denied']);

/**
 * 400s that refuse the account, not the request. Anthropic sends both as
 * `invalid_request_error` with no code of their own, so only the text tells
 * them apart: "Your credit balance is too low to access the Anthropic API"
 * and "You have reached your specified API usage limits. You will regain
 * access on <date>". Like a 402 they are `auth`: no retry and no change to
 * the request succeeds until the account changes. They are read inside a
 * router's wrapper too. There the account may be the router's own, which
 * another route might serve, but membrane can't tell, and the type is what
 * matters: as `invalid_request` the refusal reaches agent-framework's
 * poison-history breaker, which sheds history over it, and `auth` never does.
 * A router's quota is another matter: retryability is all that rides on it,
 * so it stays retryable (see quotaFailureIsTerminal). Like the context-length
 * forms, these are read only over the provider's own error message, never
 * over a body that might echo the request, with or without a status.
 */
const ACCOUNT_REFUSAL_PATTERN = /credit balance is too low|reached your specified API usage limits/i;

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

function firstString(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate;
  }
  return undefined;
}

/**
 * A provider's stated wait off response headers, in the order
 * `@anthropic-ai/sdk` reads them: `retry-after-ms` (milliseconds), then
 * `retry-after` (delta-seconds, or an HTTP-date per RFC 9110). Every adapter
 * reads it here, so a wait stated only in milliseconds is honored on all of
 * them. A wait of zero is a stated wait of zero, in either header, and a wait
 * below zero, or a date already past, is over: 0. A value is read as a body's
 * or frame's is, in decimal (statedNumber), or as an HTTP-date. A
 * `retry-after-ms` that states nothing leaves `retry-after` to be read, and a
 * `retry-after` that states nothing, a seconds value too large to state in
 * milliseconds included, leaves no wait.
 */
export function statedWaitFromHeaders(
  headers: { get(name: string): string | null } | undefined,
): number | undefined {
  const millis = headers?.get?.('retry-after-ms')?.trim();
  if (millis) {
    const ms = statedNumber(millis);
    if (ms !== undefined) return Math.max(0, Math.round(ms));
  }
  const header = headers?.get?.('retry-after')?.trim();
  if (!header) return undefined;
  const seconds = statedNumber(header);
  if (seconds !== undefined) return millisOfSeconds(seconds);
  const at = httpDate(header);
  if (at !== undefined) return Math.max(0, at - Date.now());
  return undefined;
}

const DAY = '(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)';
const LONG_DAY = '(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)';
const MONTH = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)';
const TIME = '\\d{2}:\\d{2}:\\d{2}';
/** RFC 9110's preferred form, `Sun, 06 Nov 1994 08:49:37 GMT`. */
const IMF_FIXDATE = new RegExp(`^${DAY}, \\d{2} ${MONTH} \\d{4} ${TIME} GMT$`);
/** Its obsolete forms, which a recipient still accepts: RFC 850's and asctime's. */
const RFC850_DATE = new RegExp(`^${LONG_DAY}, \\d{2}-${MONTH}-\\d{2} ${TIME} GMT$`);
const ASCTIME_DATE = new RegExp(`^${DAY} ${MONTH} [ \\d]\\d ${TIME} \\d{4}$`);

/**
 * An HTTP-date (RFC 9110 section 5.6.7) as epoch milliseconds, or undefined
 * for anything else. Date.parse alone takes far more ('.5', an ISO date), so
 * a value is parsed only in one of the three forms; asctime's carries no
 * zone and is GMT by definition.
 */
function httpDate(text: string): number | undefined {
  const form = IMF_FIXDATE.test(text) || RFC850_DATE.test(text) ? text
    : ASCTIME_DATE.test(text) ? `${text} GMT`
    : undefined;
  if (form === undefined) return undefined;
  const at = Date.parse(form);
  return Number.isNaN(at) ? undefined : at;
}

/** Seconds as milliseconds: below zero, 0; undefined when the product overflows. */
function millisOfSeconds(seconds: number): number | undefined {
  const millis = Math.round(seconds * 1000);
  return millis === Infinity ? undefined : Math.max(0, millis);
}

/** A finite number, or a string holding one in decimal ("1500", "-3", "2.5"). */
function statedNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(text)) return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * A stated wait in milliseconds from JSON fields (`retry_after_ms`,
 * `retryAfterMs`) of an error body or an SSE error frame: a number or a
 * numeric string, the first candidate that states one. A wait below zero is
 * over (0), as it is in a header: the in-call rule that ends a call over an
 * unusable wait should never see one from a reader. A value that is not a
 * finite number states nothing, and the next candidate is read.
 */
export function statedWaitMillis(...candidates: unknown[]): number | undefined {
  for (const candidate of candidates) {
    const millis = statedNumber(candidate);
    if (millis !== undefined) return Math.max(0, Math.round(millis));
  }
  return undefined;
}

/**
 * A stated wait in seconds from JSON fields (`retry_after`, Google's
 * `retryDelay: '21s'`), in milliseconds: a number, or a numeric string with
 * or without an `s`, the first candidate that states one. Below zero it is
 * over (0), and a value that is not a finite number, or whose milliseconds
 * overflow, states nothing. An HTTP-date is a header form (RFC 9110's
 * `retry-after`), so only statedWaitFromHeaders reads one.
 */
export function statedWaitSeconds(...candidates: unknown[]): number | undefined {
  for (const candidate of candidates) {
    const seconds = statedNumber(typeof candidate === 'string' ? candidate.trim().replace(/s$/, '') : candidate);
    const millis = seconds === undefined ? undefined : millisOfSeconds(seconds);
    if (millis !== undefined) return millis;
  }
  return undefined;
}

function retryAfterFromBody(root: Record<string, unknown>, errorNode: Record<string, unknown>): number | undefined {
  const details = errorNode.details ?? root.details;
  if (Array.isArray(details)) {
    for (const detail of details) {
      if (detail && typeof detail === 'object') {
        const delay = statedWaitSeconds((detail as Record<string, unknown>).retryDelay);
        if (delay !== undefined) return delay;
      }
    }
  }
  return statedWaitMillis(errorNode.retry_after_ms, root.retry_after_ms, errorNode.retryAfterMs, root.retryAfterMs)
    ?? statedWaitSeconds(errorNode.retry_after, root.retry_after, errorNode.retryAfter, root.retryAfter);
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
  // Prose is read only from the provider's own message: the body's, or the
  // caller's when there is no body. A rendered body, or a caller's message
  // built from one, can echo the request, and a wait the request mentions is
  // not one the provider stated.
  const proseSource = params.body === undefined || params.body === null ? params.message : fields.message;
  const retryAfterMs = params.retryAfterMs ?? fields.retryAfterMs
    ?? (classification.retryable && (classification.type === 'rate_limit' || classification.type === 'server')
      && proseSource !== undefined
      ? retryAfterFromProse(proseSource)
      : undefined);

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
    retryAfterMs: statedWaitFromHeaders(response.headers),
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
  // Read as the other readers read a value: an overflowing one states nothing.
  return seconds ? millisOfSeconds(parseFloat(seconds)) : undefined;
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
 *
 * A MembraneError's message is the bounded one, so a token that sat only in
 * its omitted middle is not seen, and that error takes the base schedule.
 * The omission marker's own counts are not the provider's words: an omitted
 * count of exactly 529 is no overload.
 */
export function isOverloadedError(info: ErrorInfo): boolean {
  if (!info.retryable) return false;
  if (info.httpStatus !== undefined) return info.httpStatus === 529;
  return typeof info.message === 'string' && OVERLOADED_PATTERN.test(info.message.replace(OMISSION_MARKER, ' '));
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
 * A transport failure named by its code, on the error or its `cause`: Node's
 * `fetch failed` hides `ECONNREFUSED` in `cause.code`, and Bun's "Unable to
 * connect. Is the computer able to access the url?" carries
 * `code: 'ConnectionRefused'` (the same text for a DNS failure). The message
 * names neither.
 */
function classifySocketCode(error: Error): { type: MembraneErrorType; retryable: boolean; httpStatus?: number } | undefined {
  const codes = [
    (error as { code?: unknown }).code,
    ((error as { cause?: unknown }).cause as { code?: unknown } | undefined)?.code,
  ];
  for (const code of codes) {
    if (typeof code !== 'string') continue;
    const key = code.toLowerCase();
    if (NETWORK_ERROR_CODES.has(key)) return { type: 'network', retryable: true };
    if (TIMEOUT_ERROR_CODES.has(key)) return { type: 'timeout', retryable: true };
  }
  return undefined;
}

export function classifyError(error: unknown): ErrorInfo {
  if (guardedOr(() => error instanceof MembraneError, false)) {
    return (error as MembraneError).toErrorInfo();
  }

  // Serialize the error once for use in all return paths
  const serializedError = serializeError(error);
  // Every read of the error is guarded, as serializeError's are: a getter or
  // Proxy trap that throws must not replace the failure being classified.
  const isError = isErrorValue(error);
  // The whole text decides the classification. What's returned is bounded,
  // as a MembraneError's message is, since stream() hands this to onError
  // before any MembraneError exists.
  const text = thrownText(error);
  const message = boundErrorText(text);

  if (isError) {
    // Abort is decided by type, never by prose: a tool or provider message
    // that merely contains "abort" is not a user cancellation.
    if (guardedOr(() => (error as Error).name === 'AbortError', false)) {
      return {
        type: 'abort',
        message,
        retryable: false,
        rawError: serializedError,
      };
    }

    const classification = guardedOr(() => classifySocketCode(error as Error), undefined) ?? classifyMessage(text);
    if (classification.type !== 'unknown') {
      return {
        type: classification.type,
        message,
        retryable: classification.retryable,
        httpStatus: classification.httpStatus,
        rawError: serializedError,
      };
    }
  }

  // Unknown
  return {
    type: 'unknown',
    message,
    retryable: false,
    rawError: serializedError,
  };
}
