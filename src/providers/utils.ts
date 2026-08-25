import { authError, networkError, rateLimitError, serverError } from '../types/errors.js';

interface StreamErrorFrameFields {
  code?: unknown;
  status?: unknown;
  type?: unknown;
  message?: unknown;
  retry_after?: unknown;
  retryAfter?: unknown;
  retry_after_ms?: unknown;
  retryAfterMs?: unknown;
  retryDelay?: unknown;
  retry_delay?: unknown;
}

const RATE_LIMIT_FRAME_TOKENS = ['rate_limit', 'rate-limit', 'ratelimit', 'too_many_requests', 'resource_exhausted'];
const OVERLOADED_FRAME_TOKENS = ['overloaded'];
const SERVER_FRAME_TOKENS = ['server_error', 'internal', 'unavailable'];
const AUTH_FRAME_TOKENS = [
  'invalid_api_key',
  'api_key_invalid',
  'authentication_error',
  'unauthenticated',
  'permission_denied',
  'permission_error',
];

function readNumericField(...candidates: unknown[]): number | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
    if (typeof candidate === 'string' && /^\d+$/.test(candidate.trim())) return Number(candidate.trim());
  }
  return undefined;
}

function readDurationSeconds(...candidates: unknown[]): number | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
    if (typeof candidate === 'string') {
      const duration = candidate.trim().match(/^(\d+(?:\.\d+)?)s?$/);
      if (duration?.[1]) return Number(duration[1]);
    }
  }
  return undefined;
}

function readFrameRetryAfterMs(fields: StreamErrorFrameFields): number | undefined {
  const explicitMilliseconds = readNumericField(fields.retry_after_ms, fields.retryAfterMs);
  if (explicitMilliseconds !== undefined) return explicitMilliseconds;

  const seconds = readDurationSeconds(fields.retry_after, fields.retryAfter, fields.retryDelay, fields.retry_delay);
  return seconds === undefined ? undefined : Math.round(seconds * 1000);
}

/**
 * The frame's own non-numeric `type`/`status` values — the provider's
 * structured classification tokens (`rate_limit_error`, `RESOURCE_EXHAUSTED`,
 * `overloaded_error`), never free prose. Matching a substring against these is
 * safe in a way that matching the same substring against a human-readable
 * message is not.
 */
function readFrameClassificationTokens(fields: StreamErrorFrameFields): string[] {
  return [fields.type, fields.status, fields.code]
    .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    .map((value) => value.trim())
    .filter((token) => !/^\d+$/.test(token));
}

function frameTokensMatch(tokens: string[], needles: string[]): boolean {
  return tokens.some((token) => needles.some((needle) => token.toLowerCase().includes(needle)));
}

/**
 * Throw when an SSE data frame carries a provider `error` payload.
 *
 * Every provider delivers mid-stream failures (upstream 429s, capacity loss,
 * safety aborts) as a data line with an `error` object inside an HTTP-200
 * stream. A loop that only looks for `choices`/`candidates` drops that frame,
 * reaches EOF, and builds a well-formed success out of whatever arrived first:
 * partial content, the initialised default finish reason, zero usage. Nothing
 * distinguishes it from the model choosing to stop, so the truncated turn is
 * persisted as a real one.
 *
 * The house ruled this a bug twice before it was hoisted here — once in
 * openrouter.ts (tests/unit/openrouter-stream-error.test.ts) and once in
 * openai-responses-api.ts — and both times the fix stayed in the one adapter
 * that was being touched. This is the single site every SSE adapter calls.
 *
 * The frame is CLASSIFIED here rather than downstream. Throwing a bare
 * `Error(string)` left `code`/`type`/`status` as prose, and each adapter's
 * `handleError` then re-derived a category by substring-matching that prose —
 * so a mid-stream 429 arriving as `status: 429` (no literal "429" in the
 * message) normalized to `unknown, retryable: false` and suppressed the retry
 * the provider was explicitly asking for. Classified failures reach the caller
 * intact because every adapter's `handleError` returns a MembraneError
 * unchanged. Mapping, using the structured fields only:
 *   - 429, or a rate-limit-shaped token  -> rate_limit (retryable), carrying
 *     the frame's retry hint when it has one
 *   - 5xx, or an overloaded/server-shaped token -> server (retryable);
 *     overloaded-without-a-status takes 529 so it lands on the capacity
 *     backoff schedule, matching how anthropic.ts recovers the same shape
 *   - 401/403, or an auth-shaped token   -> auth (non-retryable)
 *   - anything else -> the previous bare Error, so the adapter's own
 *     provider-specific fallbacks still get their swing at it
 * The provider's message text is never dropped, and the raw frame plus the
 * request ride along on the classified error.
 *
 * `errorNoun` names what carried the payload. It defaults to the SSE case, and
 * exists because the same `{ error: { code, message } }` object also arrives on
 * a non-streaming 200 body, where calling the failure a stream error would be
 * false. Classification reads the payload's own fields either way — the
 * transport was never part of the rule.
 */
export function throwOnStreamErrorFrame(
  parsed: unknown,
  providerLabel: string,
  rawRequest?: unknown,
  errorNoun: string = 'stream error'
): void {
  if (typeof parsed !== 'object' || parsed === null) return;
  const streamError = (parsed as { error?: unknown }).error;
  if (!streamError) return;

  const fields: StreamErrorFrameFields =
    typeof streamError === 'object' ? (streamError as StreamErrorFrameFields) : {};
  const httpStatus = readNumericField(fields.code, fields.status);
  const tokens = readFrameClassificationTokens(fields);
  const providerMessage =
    typeof fields.message === 'string' && fields.message !== ''
      ? fields.message
      : JSON.stringify(streamError);

  const description =
    `${providerLabel} ${errorNoun}` +
    `${httpStatus !== undefined ? ` (${httpStatus})` : ''}` +
    `${tokens.length > 0 ? ` [${tokens.join(' ')}]` : ''}: ${providerMessage}`;

  if (httpStatus === 429 || frameTokensMatch(tokens, RATE_LIMIT_FRAME_TOKENS)) {
    throw rateLimitError(description, readFrameRetryAfterMs(fields), parsed, rawRequest);
  }

  if (httpStatus === 401 || httpStatus === 403 || frameTokensMatch(tokens, AUTH_FRAME_TOKENS)) {
    throw authError(description, parsed, rawRequest);
  }

  const overloadedShaped = frameTokensMatch(tokens, OVERLOADED_FRAME_TOKENS);
  if ((httpStatus !== undefined && httpStatus >= 500) || overloadedShaped || frameTokensMatch(tokens, SERVER_FRAME_TOKENS)) {
    throw serverError(description, httpStatus ?? (overloadedShaped ? 529 : undefined), parsed, rawRequest);
  }

  throw new Error(description);
}

/**
 * Throw when a stream reached EOF without ever observing a terminal event.
 *
 * The terminal signal (`finish_reason`, `[DONE]`, Anthropic's `message_delta`,
 * Gemini's `finishReason`) must be an OBSERVATION, not a default. A graceful
 * upstream close with no terminal frame — proxy/LB idle timeout, early FIN,
 * a gateway truncating the body — otherwise yields a clean-looking
 * `end_turn` over partial content plus a fabricated `finish_reason` that never
 * came off the wire. Abrupt resets already reject the read; graceful ones did
 * not. Retryable by construction: the request was never answered in full.
 */
export function assertTerminalEventObserved(
  sawTerminalEvent: boolean,
  providerLabel: string,
  rawRequest?: unknown
): void {
  if (sawTerminalEvent) return;
  throw networkError(
    `${providerLabel} stream ended before a terminal event (connection dropped mid-stream)`,
    undefined,
    rawRequest
  );
}

/**
 * Safely parse a JSON string, returning an empty object on failure.
 * Used for tool call arguments which may be malformed from streaming.
 */
export function safeParseJson(str: string | undefined): Record<string, unknown> {
  try {
    return JSON.parse(str || '{}');
  } catch (e) {
    console.warn('[membrane] Failed to parse tool arguments JSON:', e);
    return {};
  }
}

/**
 * Create a combined AbortSignal that fires on either the caller's signal
 * or a timeout (whichever comes first).
 *
 * The returned `cleanup` function MUST be called in a `finally` block to
 * clear the timeout and remove the event listener, preventing leaks.
 *
 * Timeout aborts with `DOMException('Request timed out', 'AbortError')`
 * so it classifies identically to user-initiated aborts.
 */
export function createCombinedSignal(
  signal?: AbortSignal,
  timeoutMs?: number
): { signal?: AbortSignal; cleanup?: () => void } {
  if (!signal && !timeoutMs) return {};
  if (signal && !timeoutMs) return { signal };

  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  if (timeoutMs) {
    timeoutId = setTimeout(
      () => controller.abort(new DOMException('Request timed out', 'AbortError')),
      timeoutMs
    );
  }

  const onAbort = () => controller.abort(signal!.reason);
  if (signal) {
    if (signal.aborted) {
      controller.abort(signal.reason);
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (signal) signal.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * SSE (Server-Sent Events) line parser that correctly handles events
 * split across multiple TCP chunks.
 *
 * The naive approach of `chunk.split('\n').filter(l => l.startsWith('data: '))`
 * silently drops events when an SSE line spans two chunks:
 *   Chunk 1: `data: {"choices":[{"delta":{"content":"don'`  (no newline — incomplete)
 *   Chunk 2: `t do that"}}]}\n`                              (doesn't start with `data: `)
 * Result: the entire event is lost, causing "skipped words" in output.
 *
 * This parser buffers partial lines and only yields complete `data: ...` lines.
 */
export class SSELineParser {
  private buffer: string = '';

  /**
   * Feed a raw chunk from the stream reader and get back complete SSE data lines.
   * Each returned string is the content after `data: ` (e.g. the JSON payload or `[DONE]`).
   */
  feed(chunk: string): string[] {
    this.buffer += chunk;
    const results: string[] = [];

    // Split on newlines, keeping the last (potentially incomplete) segment in the buffer
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('data: ')) {
        results.push(trimmed.slice(6));
      }
      // Skip empty lines, comments (`:...`), and other SSE fields (event:, id:, retry:)
    }

    return results;
  }

  /**
   * Flush any remaining buffered content (call when stream ends).
   */
  flush(): string[] {
    if (!this.buffer.trim()) return [];
    const trimmed = this.buffer.trim();
    this.buffer = '';
    if (trimmed.startsWith('data: ')) {
      return [trimmed.slice(6)];
    }
    return [];
  }
}
