import { TimeoutAbortError, errorFromProviderStatus, networkError } from '../types/errors.js';
import { imageForRequest, urlImageForRequest } from '../utils/image-media.js';

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
 * Throw when an SSE data frame, or a non-streaming response body, reports a
 * provider failure inside an HTTP 200: an `error` object at its top level or
 * on its first choice, whatever the finish reason, or a first choice that
 * ends with `finish_reason: "error"`.
 *
 * Providers deliver mid-stream failures (upstream 429s, capacity loss,
 * safety aborts) inside an HTTP-200 stream, usually as a data line with an
 * `error` object. A loop that only looks for `choices`/`candidates` drops that
 * frame, reaches EOF, and builds a well-formed success out of whatever arrived
 * first: partial content, the initialised default finish reason, zero usage.
 * Nothing distinguishes it from the model choosing to stop, so the truncated
 * turn is persisted as a real one.
 *
 * The house ruled this a bug twice before it was hoisted here — once in
 * openrouter.ts (tests/unit/openrouter-stream-error.test.ts) and once in
 * openai-responses-api.ts — and both times the fix stayed in the one adapter
 * that was being touched. Every adapter that parses SSE data frames itself
 * calls this one function; Anthropic's and Bedrock's read their own events.
 *
 * The frame is CLASSIFIED here rather than downstream. Throwing a bare
 * `Error(string)` left `code`/`type`/`status` as prose, and each adapter's
 * `handleError` then re-derived a category by substring-matching that prose —
 * so a mid-stream 429 arriving as `status: 429` (no literal "429" in the
 * message) normalized to `unknown, retryable: false` and suppressed the retry
 * the provider was explicitly asking for. Classified failures reach the caller
 * intact because every adapter's handleError preserves a MembraneError. The
 * same errorFromProviderStatus classifier serves HTTP failures and these
 * HTTP-200 error payloads. Only HTTP-shaped error statuses (400..599) count
 * as explicit statuses here; a transport 200 or provider-local numeric code
 * leaves symbolic-code classification available. Existing structured-token
 * aliases supply a fallback after the status and recognized provider code.
 * The provider message, raw frame, retry hint and request remain attached,
 * including for an unclassified payload. Explicit 400 frames are typed
 * invalid_request errors rather than bare Error objects.
 *
 * OpenRouter documents its mid-stream failure as an `error` object at the
 * top level beside `finish_reason: "error"`, and a non-streaming response
 * whose generation failed with the `error` object on its choice, beside that
 * finish reason and the partial content. An `error` object classifies the
 * failure by its own fields, wherever it sits and whatever the finish reason.
 * A first choice that ends with `finish_reason: "error"` and comes with no
 * `error` object either way is a shape OpenRouter doesn't document, and it
 * carries nothing of its own to classify. Read as a finish reason alone, it
 * would end the turn as end_turn over the partial content, since membrane's
 * mapper normalizes a token it doesn't know to end_turn. So it takes the
 * class of the failures partway that OpenRouter does document, a
 * `server_error` mid-stream and a 502 on the choice: a retryable server
 * error, with the httpStatus 500 the `server_error` frame gets from its code.
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
  // The first choice is the one every adapter reads.
  const choice = (parsed as { choices?: Array<{ finish_reason?: unknown; error?: unknown } | null> }).choices?.[0];
  const topLevelError = (parsed as { error?: unknown }).error;
  const streamError = topLevelError || choice?.error;
  if (!streamError && choice?.finish_reason !== 'error') return;

  const fields: StreamErrorFrameFields =
    streamError && typeof streamError === 'object' ? (streamError as StreamErrorFrameFields) : {};
  // A successful transport status or arbitrary provider-local number is not
  // an HTTP error status. Neither may suppress a usable symbolic error code.
  const httpStatus = [fields.status, fields.code].map(value => readNumericField(value))
    .find(value => value !== undefined && Number.isInteger(value) && value >= 400 && value <= 599);
  const tokens = readFrameClassificationTokens(fields);
  const providerMessage =
    !streamError ? 'the provider ended the response with finish_reason "error" and sent no error object saying why'
    : typeof fields.message === 'string' && fields.message !== '' ? fields.message
    : JSON.stringify(streamError);

  const description =
    `${providerLabel} ${errorNoun}` +
    `${httpStatus !== undefined ? ` (${httpStatus})` : ''}` +
    `${tokens.length > 0 ? ` [${tokens.join(' ')}]` : ''}: ${providerMessage}`;

  // Retain the adapters' established structured-token spellings as a fallback.
  // The shared classifier gives an explicit status or known provider code priority,
  // and owns terminal-quota versus transient-rate-limit retryability in either transport.
  // finish_reason "error" with no error object takes the server_error frame's
  // 500 (see above).
  const overloadedShaped = frameTokensMatch(tokens, OVERLOADED_FRAME_TOKENS);
  const fallbackStatus = !streamError ? 500
    : frameTokensMatch(tokens, RATE_LIMIT_FRAME_TOKENS) ? 429
    : frameTokensMatch(tokens, AUTH_FRAME_TOKENS) ? 401
    : overloadedShaped ? 529
    : frameTokensMatch(tokens, SERVER_FRAME_TOKENS) ? 500
    : undefined;
  throw errorFromProviderStatus({
    provider: providerLabel,
    status: httpStatus,
    fallbackStatus,
    // The classifier reads an error body's top-level `error`.
    body: !streamError ? undefined : topLevelError ? parsed : { error: streamError },
    message: description,
    retryAfterMs: readFrameRetryAfterMs(fields),
    rawError: parsed,
    rawRequest,
  });
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

/** A tool_use block's `input`, and its `unparseableInput` when it has one. */
export type ToolUseInput = { input: Record<string, unknown>; unparseableInput?: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function notAnObject(raw: string, value: unknown): ToolUseInput {
  const kind = value === null ? 'null' : Array.isArray(value) ? 'an array' : `a ${typeof value}`;
  console.warn(`[membrane] Tool arguments are ${kind}, not an object; input is {} and unparseableInput keeps them`);
  return { input: {}, unparseableInput: raw };
}

/**
 * A tool call's `input` from the argument text a provider sent (OpenAI-family
 * `function.arguments`, Anthropic and Bedrock `input_json_delta`
 * accumulations). `input` is always a plain object, as ToolUseContent types
 * it. Text that doesn't parse, or parses to anything but an object (null, a
 * number, a string, a boolean or an array), isn't the model's arguments as an
 * object: `input` is then `{}`, and `unparseableInput` keeps the text as it
 * came. No text (the field absent or null), or text that is empty or only
 * JSON whitespace, is a call with no arguments: `{}`, unmarked. An arguments
 * field that isn't text at all, outside its wire's spec, is read as
 * toolUseInputFromValue reads a value, so the marker is always text.
 */
export function toolUseInputFromText(text: unknown): ToolUseInput {
  if (text === undefined || text === null) return { input: {} };
  if (typeof text !== 'string') return toolUseInputFromValue(text);
  if (/^[ \t\n\r]*$/.test(text)) return { input: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not the SyntaxError: its message quotes the text.
    console.warn("[membrane] Tool arguments aren't valid JSON; input is {} and unparseableInput keeps them (not logged: tool arguments can carry secrets)");
    return { input: {}, unparseableInput: text };
  }
  return isPlainObject(parsed) ? { input: parsed } : notAnObject(text, parsed);
}

/**
 * As toolUseInputFromText, for arguments sent as a value: Gemini's
 * `functionCall.args`, Anthropic's and Bedrock's `input`, and the `input` an
 * adapter hands Membrane. No value is a call with no arguments. A value that
 * isn't an object, `null` included, is kept, as JSON, in `unparseableInput`;
 * a wire that means "unset" by null says so where it calls this (Gemini).
 */
export function toolUseInputFromValue(value: unknown): ToolUseInput {
  if (value === undefined) return { input: {} };
  return isPlainObject(value) ? { input: value } : notAnObject(JSON.stringify(value), value);
}

/**
 * Agent-facing stand-in for an image inside a tool result on a wire that
 * carries tool results as text only (Chat Completions `role: 'tool'`
 * messages, Gemini `functionResponse.response`). Constant text, so a history
 * that holds it serializes to the same bytes on every request.
 */
export const TEXT_ONLY_TOOL_RESULT_IMAGE_PLACEHOLDER =
  '[system: an image in this tool result was NOT shown to you — tool results ' +
  'reach this model as text only. You are not seeing this image.]';

/**
 * Serialize tool_result content for a text-only tool-result wire.
 *
 * Strings pass through. Anything else is JSON-stringified as before, except
 * that array blocks carrying INLINE image data (`image` with a base64 source or
 * an MCP-style `data` field, `generated_image`) are first replaced by
 * {@link TEXT_ONLY_TOOL_RESULT_IMAGE_PLACEHOLDER}: stringifying them puts the
 * whole base64 payload into the prompt as text (a 300KB screenshot becomes
 * ~400KB of input text on every request while it stays in history), which
 * the model cannot read as an image anyway. Everything else — URL-source
 * images, image-typed tool data without a payload, arrays without images,
 * non-array content — serializes byte-identically to plain `JSON.stringify`.
 */
function carriesInlineImageData(block: unknown): boolean {
  if (!block || typeof block !== 'object') return false;
  const b = block as { type?: unknown; data?: unknown; source?: unknown };
  if (b.type === 'generated_image') return typeof b.data === 'string';
  if (b.type !== 'image') return false;
  if (typeof b.data === 'string') return true; // MCP-shaped image content
  const source = b.source as { data?: unknown } | null | undefined;
  return !!source && typeof source === 'object' && typeof source.data === 'string';
}

/**
 * An image block as an OpenAI-style chat content part (OpenAI, OpenAI-compatible
 * and OpenRouter): an image_url for an image these APIs accept, base64 data
 * as a data: URL labelled by its header and a remote URL as it is, or
 * imageForRequest's placeholder as a text part. Undefined for a block with no
 * usable source.
 */
export function openAIImagePart(source: { type?: string; data?: unknown; media_type?: unknown; mediaType?: unknown; url?: unknown } | undefined):
  { type: 'image_url'; image_url: { url: string } } | { type: 'text'; text: string } | undefined {
  if (source?.type === 'base64') {
    const { mediaType, placeholder } = imageForRequest(source.data, source.media_type ?? source.mediaType);
    return placeholder
      ? { type: 'text', text: placeholder.text }
      : { type: 'image_url', image_url: { url: `data:${mediaType};base64,${source.data as string}` } };
  }
  if (source?.type === 'url') {
    const image = urlImageForRequest(source.url as string);
    return image.placeholder ? { type: 'text', text: image.placeholder.text } : { type: 'image_url', image_url: { url: image.url } };
  }
  return undefined;
}

export function textOnlyToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content);
  let replaced = false;
  const blocks = content.map((block) => {
    if (carriesInlineImageData(block)) {
      replaced = true;
      return { type: 'text', text: TEXT_ONLY_TOOL_RESULT_IMAGE_PLACEHOLDER };
    }
    return block;
  });
  return JSON.stringify(replaced ? blocks : content);
}

/**
 * Marks the abort reason raised by an adapter's own `timeoutMs` deadline, so
 * the error that comes back out of `fetch` can be told apart from a caller's
 * cancellation by PROVENANCE rather than by matching its message text.
 *
 * `fetch` rejects with the signal's own `reason` object — identity and extra
 * properties intact, on both the pre-headers and the body-read paths — so the
 * mark survives the round trip through the platform. When some layer does
 * replace the error, `isDeadlineAbort` simply reports false and the abort
 * classifies as it did before: a missing mark degrades to the old answer, it
 * never invents a timeout.
 */
const DEADLINE_ABORT = Symbol.for('membrane.deadlineAbort');

function deadlineAbortReason(message = 'Request timed out'): DOMException {
  const reason = new DOMException(message, 'AbortError');
  Object.defineProperty(reason, DEADLINE_ABORT, { value: true, enumerable: false });
  return reason;
}

/**
 * True when this error is the abort raised by an adapter's own deadline.
 *
 * A caller's cancellation never carries the mark (the combined controller is
 * aborted with the caller's own reason), and if both race, whichever fired
 * first is the reason the platform rejects with — so the mark answers "was
 * this OUR deadline?" without a separate tie-break.
 */
export function isDeadlineAbort(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as Record<symbol, unknown>)[DEADLINE_ABORT] === true
  );
}

/**
 * The typed error a deadline abort should become: a timeout by classification,
 * an abort by provenance. Adapters return this from `handleError` instead of a
 * bare `abortError()`, which used to erase the distinction before Membrane's
 * caller-signal > timeout > error ladder could read it.
 */
export function deadlineTimeoutError(error: unknown, rawRequest?: unknown): TimeoutAbortError {
  // The marked reason names its deadline (see createProgressDeadline).
  const message = isDeadlineAbort(error) ? (error as { message?: unknown }).message : undefined;
  return new TimeoutAbortError(
    typeof message === 'string' && message ? message : 'Request timed out',
    error,
    rawRequest,
  );
}

/**
 * The longest delay a platform timer holds. Node and browsers run a timer
 * whose delay is longer, Infinity included, after 1 ms.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * `setTimeout` for any delay: one past the platform's limit (about 24.8
 * days) is armed in steps no longer than it, so it fires on time, and
 * Infinity never fires. Returns its cancel.
 */
function setLongTimeout(fire: () => void, delayMs: number): () => void {
  let timer: ReturnType<typeof setTimeout>;
  const arm = (left: number): void => {
    timer = left > MAX_TIMER_DELAY_MS
      ? setTimeout(() => arm(left - MAX_TIMER_DELAY_MS), MAX_TIMER_DELAY_MS)
      : setTimeout(fire, left);
  };
  arm(delayMs);
  return () => clearTimeout(timer);
}

/**
 * Create a combined AbortSignal that fires on either the caller's signal
 * or a timeout (whichever comes first).
 *
 * The returned `cleanup` function MUST be called in a `finally` block to
 * clear the timeout and remove the event listener, preventing leaks.
 *
 * Timeout aborts with a marked `DOMException('Request timed out',
 * 'AbortError')`: abort-shaped like any cancellation, and identifiable as the
 * deadline's doing via `isDeadlineAbort`.
 */
export function createCombinedSignal(
  signal?: AbortSignal,
  timeoutMs?: number
): { signal?: AbortSignal; cleanup?: () => void } {
  if (!signal && !timeoutMs) return {};
  if (signal && !timeoutMs) return { signal };

  const controller = new AbortController();
  let cancelTimeout: (() => void) | undefined;

  if (timeoutMs) {
    cancelTimeout = setLongTimeout(() => controller.abort(deadlineAbortReason()), timeoutMs);
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
      cancelTimeout?.();
      if (signal) signal.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * A deadline that stream progress renews, for one provider call: it aborts
 * when `timeoutMs` passes with no call to `renew`, combined with the caller's
 * signal. Membrane core owns it (`progressTimeoutMs`); adapters renew it
 * through `ProviderRequestOptions.onProgress` once per parsed provider event.
 *
 * Expiry aborts with the same mark as `createCombinedSignal`'s deadline, so
 * every adapter's `isDeadlineAbort` → `deadlineTimeoutError` path turns it
 * into a TimeoutAbortError: a timeout by type, an abort by provenance. Its
 * message names this deadline and says when the call began, how many provider
 * events it had and when the last came, so a call log that keeps only an
 * error's message still tells a call that never produced an event from one
 * that stopped partway.
 *
 * Silence is measured on the monotonic clock (`performance.now()`), as the
 * timers run, so a step of the system clock moves no expiry; the message's
 * times are wall-clock. `renew` only records the time and counts the event,
 * so calling it per event costs nothing; the one timer re-arms itself for
 * whatever is left when it fires early. Without a positive `timeoutMs`
 * (unset, zero, negative or NaN) the caller's signal passes through and there
 * is no `renew`. `cleanup` MUST run in a `finally`.
 */
export function createProgressDeadline(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): { signal?: AbortSignal; renew?: () => void; cleanup: () => void } {
  if (!timeoutMs || timeoutMs <= 0) return { signal, cleanup: () => {} };

  const controller = new AbortController();
  const beganAt = Date.now();
  let lastAt = beganAt;
  let last = performance.now();
  let events = 0;
  let cancelTimer: (() => void) | undefined;
  const check = (): void => {
    const quiet = performance.now() - last;
    if (quiet >= timeoutMs) {
      cancelTimer = undefined;
      controller.abort(deadlineAbortReason(
        `No provider progress within ${timeoutMs}ms: the call began at ${new Date(beganAt).toISOString()}, ` +
        `provider events: ${events}${events > 0 ? `, the last at ${new Date(lastAt).toISOString()}` : ''}`,
      ));
    } else {
      cancelTimer = setLongTimeout(check, timeoutMs - quiet);
    }
  };
  cancelTimer = setLongTimeout(check, timeoutMs);

  const onAbort = (): void => {
    cancelTimer?.();
    cancelTimer = undefined;
    controller.abort(signal!.reason);
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  return {
    signal: controller.signal,
    renew: () => { last = performance.now(); lastAt = Date.now(); events++; },
    cleanup: () => {
      cancelTimer?.();
      cancelTimer = undefined;
      signal?.removeEventListener('abort', onAbort);
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
  private data: string[] = [];

  constructor(private readonly options: { multiline?: boolean } = {}) {}

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
      if (this.options.multiline) {
        this.processEventLine(line.replace(/\r$/, ''), results);
        continue;
      }
      const trimmed = line.trim();
      if (trimmed.startsWith('data: ')) {
        results.push(trimmed.slice(6));
      }
      // Skip empty lines, comments (`:...`), and other SSE fields (event:, id:, retry:)
    }

    return results;
  }

  private processEventLine(line: string, results: string[]): void {
    if (line === '') {
      if (this.data.length) results.push(this.data.join('\n'));
      this.data = [];
    } else if (line.startsWith('data:')) {
      this.data.push(line.slice(5).replace(/^ /, ''));
    }
  }

  /** Flush any remaining event/tail when the stream ends. */
  flush(): string[] {
    if (this.options.multiline) {
      const results: string[] = [];
      if (this.buffer) this.processEventLine(this.buffer.replace(/\r$/, ''), results);
      this.buffer = '';
      this.processEventLine('', results);
      return results;
    }
    if (!this.buffer.trim()) return [];
    const trimmed = this.buffer.trim();
    this.buffer = '';
    if (trimmed.startsWith('data: ')) {
      return [trimmed.slice(6)];
    }
    return [];
  }
}

/**
 * Whether a streamed content block is a tool call: a client tool's
 * (tool_use), or a server tool's (server_tool_use, mcp_tool_use). The API
 * streams only its arguments to it (isToolCallArgumentsDelta), so the stream
 * adapters take any other delta for it as out of the API's block order. Text
 * and thinking blocks have gained delta types (citations_delta,
 * signature_delta), so no such check is made of them.
 */
export function isToolCallBlock(block: unknown): boolean {
  if (block === null || typeof block !== 'object') return false;
  const type = (block as { type?: unknown }).type;
  return type === 'tool_use' || type === 'server_tool_use' || type === 'mcp_tool_use';
}

/**
 * Whether a delta is one a tool call can take: its arguments, as an
 * input_json_delta whose partial_json is a string. One of that type without
 * them carries none of the call's arguments where the stream adapters read
 * them, so they take it as out of the API's block order too.
 */
export function isToolCallArgumentsDelta(delta: unknown): boolean {
  return delta !== null && typeof delta === 'object' &&
    (delta as { type?: unknown }).type === 'input_json_delta' &&
    typeof (delta as { partial_json?: unknown }).partial_json === 'string';
}
