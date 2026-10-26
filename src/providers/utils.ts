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
 * Providers deliver mid-stream failures (upstream 429s, capacity loss,
 * safety aborts) inside an HTTP-200 stream, usually as a data line with an
 * `error` object, and a non-streaming 200 body can carry the same object.
 * OpenRouter documents its mid-stream failure as an `error` object at the
 * top level beside `finish_reason: "error"`, and a non-streaming generation
 * failure with the `error` object on its choice, beside that finish reason
 * and the partial content.
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
 * A graceful upstream close with no terminal frame (a proxy or load
 * balancer's idle timeout, an early FIN, a gateway truncating the body) ends
 * the body's read as cleanly as a finished response does; only an abrupt
 * reset makes the read itself reject.
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

/** The largest array index, 2^32 - 2. */
const MAX_ARRAY_INDEX = 2 ** 32 - 2;

/**
 * `Number()` would read several non-indexes as a slot: `false`, `""`, `" "`,
 * `[]` and `"00"` as 0, `true`, `"0x1"` and `"01"` as 1, `"1e1"` as 10.
 */
export function streamIndex(value: unknown, absent = 0): number | undefined {
  if (value === undefined || value === null) return absent;
  const index = typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value) ? Number(value) : value;
  return typeof index === 'number' && Number.isInteger(index) && index >= 0 && index <= MAX_ARRAY_INDEX ? index : undefined;
}

/** A tool call as the Chat Completions family streams it, put together from its pieces. */
export interface StreamedToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/**
 * OpenAI's API spec requires an index on each streamed tool call, but some
 * compatible servers are reported to leave it out (antra-tess/membrane#159).
 */
export function streamedToolCalls(): { add(entry: unknown): void; calls(): StreamedToolCall[] } {
  // Each slot holds the calls that joined it, in order. A piece continues
  // the latest of them with its id, or else the last.
  const indexed: StreamedToolCall[][] = [];
  const unindexed: StreamedToolCall[] = [];
  const byId = new Map<unknown, StreamedToolCall>();
  let current: StreamedToolCall | undefined;
  const open = (): StreamedToolCall => ({ id: '', type: 'function', function: { name: '', arguments: '' } });
  return {
    add(entry) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
      const tc = entry as { index?: unknown; id?: unknown; function?: { name?: unknown; arguments?: unknown } };
      const name = tc.function?.name;
      // An entry that carries nothing adds nothing, and opens no call.
      if (!tc.id && !name && !tc.function?.arguments) return;
      // A piece that names a tool other than a call's own never joins that call.
      const another = (c: StreamedToolCall): boolean => !!name && !!c.function.name && name !== c.function.name;
      let call: StreamedToolCall | undefined;
      let slot: StreamedToolCall[] | undefined;
      if (tc.index !== undefined && tc.index !== null) {
        const index = streamIndex(tc.index);
        if (index === undefined) return;
        slot = indexed[index] ??= [];
        // The latest of the slot's calls with the piece's id, as byId keeps
        // the latest call to take an id.
        const own = tc.id ? slot.filter((c) => c.id === tc.id).at(-1) : undefined;
        call = own ?? slot[slot.length - 1];
        // A call that began without an index and comes back with its id
        // and an index moves into that slot, rather than leaving two calls,
        // unless a call in the slot already has the id.
        const known = !own && tc.id ? byId.get(tc.id) : undefined;
        const at = known && !another(known) ? unindexed.indexOf(known) : -1;
        if (known && at !== -1) {
          unindexed.splice(at, 1);
          slot.push((call = known));
        }
      } else {
        call = tc.id ? byId.get(tc.id) : undefined;
        if (!call && !(name && tc.id && current?.id)) call = current;
      }
      if (!call || another(call)) {
        call = open();
        (slot ?? unindexed).push(call);
      }
      if (tc.id && !call.id) {
        call.id = tc.id as string;
        byId.set(tc.id, call);
      }
      if (name) call.function.name = name as string;
      if (tc.function?.arguments) call.function.arguments += tc.function.arguments;
      current = call;
    },
    calls() {
      // A tool result names its call by id alone, so every call comes back under an id of its own.
      const all = [...Object.values(indexed).flat(), ...unindexed];
      const taken = new Set(all.map((c) => c.id));
      const seen = new Set<string>();
      const minted: string[] = [];
      for (const c of all) {
        if (!c.id || seen.has(c.id)) {
          const stem = c.id || 'call';
          let n = c.id ? 2 : 1;
          while (taken.has(`${stem}_${n}`)) n++;
          minted.push(`${JSON.stringify(c.id)} as ${stem}_${n}`);
          c.id = `${stem}_${n}`;
          taken.add(c.id);
        }
        seen.add(c.id);
      }
      if (minted.length) console.warn(`[membrane] The server repeated or left out a streamed tool call's id; new ids: ${minted.join(', ')}`);
      return all;
    },
  };
}

/**
 * The API streams only a tool call's arguments to its block, while text and
 * thinking blocks have gained delta types (citations_delta, signature_delta).
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

/**
 * Whether a parsed SSE frame, or a decoded Bedrock event, is an event: a JSON
 * object. `null`, a number, a string, a boolean or an array carries none, so
 * the adapters drop its frame before they report progress.
 */
export function isEventObject(value: unknown): boolean {
  return isPlainObject(value);
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

/** Constant text, so a history that holds it serializes to the same bytes on every request (the prompt cache reads bytes). */
export const TEXT_ONLY_TOOL_RESULT_IMAGE_PLACEHOLDER =
  '[system: an image in this tool result was NOT shown to you — tool results ' +
  'reach this model as text only. You are not seeing this image.]';

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

/**
 * Stringifying a tool result's inline image data puts the whole base64
 * payload into the prompt as text, which the model can't read as an image.
 */
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
 * `fetch` rejects with the signal's own `reason` object, identity and extra
 * properties intact, on both the pre-headers and the body-read paths.
 */
const DEADLINE_ABORT = Symbol.for('membrane.deadlineAbort');

function deadlineAbortReason(message = 'Request timed out'): DOMException {
  const reason = new DOMException(message, 'AbortError');
  Object.defineProperty(reason, DEADLINE_ABORT, { value: true, enumerable: false });
  return reason;
}

/** If a caller's cancellation and the deadline race, the platform rejects with whichever reason came first. */
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
export function setLongTimeout(fire: () => void, delayMs: number): () => void {
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

/** A `redacted_thinking` block arrives whole once its think is done. */
export function contentOfAnthropicEvent(
  event: { type?: unknown; content_block?: { type?: unknown } | null },
): 'content' | undefined {
  if (event.type === 'content_block_delta') return 'content';
  return event.type === 'content_block_start' && event.content_block?.type === 'redacted_thinking'
    ? 'content'
    : undefined;
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

/** An SSE line can span two network chunks, so lines are buffered until they are complete. */
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
