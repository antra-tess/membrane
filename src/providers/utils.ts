import { TimeoutAbortError, errorFromProviderStatus, networkError } from '../types/errors.js';
import { imageForRequest, urlImageForRequest } from '../utils/image-media.js';
import type { ProgressSeen, SendReport } from '../types/provider.js';

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

/** The largest array index, 2^32 - 2. */
const MAX_ARRAY_INDEX = 2 ** 32 - 2;

/**
 * The slot a streamed piece names: a tool call's `index` on the OpenAI-family
 * wires, a content block's on Bedrock. A number or a string that is an array
 * index names its slot, as a plain array keyed by it takes one: an integer
 * from 0 to 2^32 - 2, or its decimal string with no leading zero. Absent or
 * `null` names `absent`: Bedrock's block index reads it so, while a tool
 * call with no index is placed by `streamedToolCalls` instead.
 * Anything else names none, and the caller drops the piece: a negative,
 * fractional or larger number, a boolean, any other string (`"01"`
 * included), an array or an object. `Number()` would read several of these
 * as a slot: `false`, `""`, `" "`, `[]` and `"00"` as 0, `true`, `"0x1"` and
 * `"01"` as 1, `"1e1"` as 10.
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
 * Puts a Chat Completions stream's tool calls together from its `tool_calls`
 * entries, one `add` per entry, and gives them back with `calls()`. An entry
 * that isn't an object, or that carries no id, name or arguments, is dropped.
 * Each piece's arguments are appended to its call's. A call's id is set by
 * the first piece that carries one, and no later piece replaces it. A piece
 * that names a tool other than its call's starts a call of its own, so a
 * call's name, once set, never changes.
 *
 * An entry with an `index` goes to that slot, as `streamIndex` reads it, and
 * one whose index names no slot is dropped. It continues the latest of the
 * slot's calls that has its id; failing that, the call that began without an
 * index under its id, which moves into the slot; or else the call that joined
 * the slot last; in each case unless the entry names another tool. OpenAI's
 * API spec requires an index on each streamed tool call, but some compatible
 * servers are reported to leave it out, and every entry without one went to
 * slot 0, so two calls became one (antra-tess/membrane#159). An entry whose
 * `index` is absent or `null` never takes a slot. It goes to the call that
 * already has its id, if one does, or else to the current call, the one the
 * last entry went to, unless it brings a name and a new id while that call
 * has an id. The rule assumes a call's first piece carries its name, so a
 * later piece that carries only an id, even a new one, or only arguments
 * stays with its call.
 *
 * `calls()` gives the calls that have an index in index order, those in one
 * slot in the order they joined it, then the others in the order they
 * started. Each comes back under an id of its own: a call with no id, or
 * whose id an earlier one in the list holds, comes back under a new one, and
 * a `[membrane]` warning names each.
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
      // Every call comes back under an id of its own, since a result names its call by id
      // alone, and an empty one can't be answered (the adapters send a result's
      // `tool_use_id || toolUseId`, which drops it or sends ""). A call with no id takes
      // `call_<n>`, from n = 1, and one whose id an earlier call in the list holds takes
      // `<id>_<n>`, from n = 2, each with the first n that no call has.
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
  // The marked reason names its deadline (see createCallDeadline).
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

/**
 * The bound before a call's first content (TTFT), from the send: a little
 * over three times the longest wait before a think began among successful
 * Anthropic calls on a production router (128 s, so 384 s, rounded up). It
 * covers the wait for the first event too, which a large cache miss can
 * stretch: 600,000-token contexts have sent only pings for over 120 s before
 * their message_start.
 */
export const BEFORE_CONTENT_MS = 400_000;

/**
 * The bound between provider events once content has begun: Claude Code's
 * stream idle bound (90 s, by our reading of its source), doubled for the
 * long silences while a large tool call is written.
 */
export const BETWEEN_EVENTS_MS = 180_000;

/**
 * The slowest rate a silent think, or an answer that arrives whole, is
 * allowed: half the slowest successful think of 10,000 tokens or more on the
 * same router (71.6 tokens a second, claude-opus-5-5). A think's allowance is
 * its request's whole output budget at this rate.
 */
export const THINK_TOKENS_PER_SECOND = 35;

/** The output budget assumed for a call whose adapter reports none and whose request names none: the default of every built-in adapter that sends an output limit. */
export const DEFAULT_BUDGET_TOKENS = 4096;

/**
 * What an Anthropic-format stream event says about its call's phase, for
 * Membrane core's deadlines, on the adapters that parse those events
 * (Anthropic's, and Bedrock's, which carries them). A content delta is
 * content, and so is a redacted_thinking block, which arrives whole, its
 * think done. Any other block's start is only an event: a text or tool
 * block's content follows as deltas (a tool call's input can take a while
 * to come), and a server tool's result, which arrives whole too, follows its
 * call's input deltas. A thinking block's start is a silent think unless the
 * body asks for summarized thinking, which streams deltas.
 */
export function progressOfAnthropicEvent(
  event: { type?: unknown; content_block?: { type?: unknown } },
  summarized: boolean,
): ProgressSeen | undefined {
  if (event.type === 'content_block_delta') return 'content';
  if (event.type !== 'content_block_start') return undefined;
  const block = event.content_block?.type;
  if (block === 'redacted_thinking') return 'content';
  return block === 'thinking' && !summarized ? 'think' : undefined;
}

/** A positive number of ms (Infinity included), or undefined. */
const positiveMs = (value: unknown): number | undefined =>
  typeof value === 'number' && value > 0 ? value : undefined;

/**
 * The progress deadline for one provider call, combined with the caller's
 * signal. (A caller's per-request `timeoutMs` stays the
 * adapter's own.) Membrane core owns them, and the adapter says what it saw:
 * as it sends the request, what it sent (`ProviderRequestOptions.onSend`,
 * `reportSend`), and then each event and sign of its transport
 * (`ProviderRequestOptions.onProgress`, `report`).
 *
 * "The send" is when Membrane hands the call to its adapter, as it creates
 * this, so building and signing the request and resolving credentials count
 * against the first bound too.
 *
 * The progress deadline, by `progressTimeoutMs` (anything that isn't a
 * number, `null` included, counts as unset):
 * - Unset, in a call whose adapter reported at the send, before any event,
 *   that its stream reports phases: bounds per phase. Before the first
 *   content, BEFORE_CONTENT_MS from the send. A
 *   silent think started before content is allowed its whole output budget
 *   at THINK_TOKENS_PER_SECOND from its start, and the call ends only once
 *   both have run out. After content, BETWEEN_EVENTS_MS between events, or
 *   the larger of that and the allowance after a silent think's start.
 * - Unset, in any other call (a non-streaming call, or a stream whose
 *   adapter reports no phases): BEFORE_CONTENT_MS plus the output budget at
 *   THINK_TOKENS_PER_SECOND, from the send and again from each event, since
 *   such a call can be silent until its whole answer arrives.
 * - A positive number, Infinity included: that many ms from the send and
 *   from each event, whatever the phase, as one flat bound.
 * - Anything else (0, a negative number, NaN): off.
 *
 * A connection that sends nothing at all is left to the runtime's own body
 * timeout (undici's, Bun's), counted from its last byte. A phase bound can
 * outlast it before content, on a call without phases and in a silent
 * think's allowance; after content, 180 s between events is shorter.
 *
 * The output budget is the one the adapter reports sending, or else
 * `maxTokens` when it's a positive number, or else DEFAULT_BUDGET_TOKENS. A
 * reported budget that isn't a positive finite number is ignored.
 *
 * Expiry aborts with the deadline mark, so every adapter's `isDeadlineAbort`
 * → `deadlineTimeoutError` path turns it into a TimeoutAbortError: a timeout
 * by type, an abort by provenance. Its message names the bound that ran out
 * and says when the call began, how many provider events it had and when the
 * last came. Silence is measured on the monotonic clock
 * (`performance.now()`), so a step of the system clock moves no expiry; the
 * message's times are wall-clock. A report only records what it saw, so
 * reporting each event costs nothing: the one timer re-arms when it fires
 * early, and is moved only when a report brings the expiry closer.
 * `cleanup` MUST run in a `finally`.
 */
export function createCallDeadline(
  signal: AbortSignal | undefined,
  options: { progressTimeoutMs?: number; maxTokens?: number },
): {
  signal?: AbortSignal;
  report: (seen?: ProgressSeen) => void;
  reportSend: (send: SendReport) => void;
  cleanup: () => void;
} {
  const flatMs = positiveMs(options.progressTimeoutMs);
  // Unset, the call starts on the bound for an answer that arrives whole,
  // and takes the phases when its adapter reports them at the send.
  let mode: 'phases' | 'whole' | 'flat' | 'off' = typeof options.progressTimeoutMs !== 'number'
    ? 'whole'
    : flatMs !== undefined ? 'flat' : 'off';
  if (mode === 'off') return { signal, report: () => {}, reportSend: () => {}, cleanup: () => {} };

  const controller = new AbortController();
  const beganAt = Date.now();
  const sentAt = performance.now();
  let lastWall = beganAt;
  let lastAt = sentAt;
  let events = 0;
  let budget = typeof options.maxTokens === 'number' && options.maxTokens > 0 && Number.isFinite(options.maxTokens)
    ? options.maxTokens
    : DEFAULT_BUDGET_TOKENS;
  let contentSeen = false;
  // Before content: when the latest silent think's allowance runs out.
  let thinkEnds: number | undefined;
  // After content: whether the last event was a silent think's start.
  let thinking = false;
  let cancelTimer: (() => void) | undefined;
  let armedAt = Infinity;
  // Settled by expiry, the caller's abort or cleanup: a late report (an
  // event read after the call ended) arms nothing.
  let over = false;

  const allowanceMs = (): number => Math.ceil(budget / THINK_TOKENS_PER_SECOND) * 1000;
  const budgetText = (): string => `max_tokens ${budget} at ${THINK_TOKENS_PER_SECOND} tokens a second`;
  const s = (ms: number): string => `${ms / 1000}s`;
  // When the call ends as things stand, and what to say if it does.
  const due = (): { at: number; why: () => string } => {
    let next: { at: number; why: () => string } = { at: Infinity, why: () => '' };
    if (mode === 'flat') {
      next = { at: lastAt + flatMs!, why: () => `No provider progress within ${flatMs}ms` };
    } else if (mode === 'whole') {
      const bound = BEFORE_CONTENT_MS + allowanceMs();
      next = {
        at: lastAt + bound,
        why: () => `${events === 0 ? 'No answer' : 'No provider event'} within ${s(bound)} (${s(BEFORE_CONTENT_MS)} plus ${budgetText()})`,
      };
    } else if (mode === 'phases' && !contentSeen) {
      next = thinkEnds !== undefined && thinkEnds > sentAt + BEFORE_CONTENT_MS
        ? { at: thinkEnds, why: () => `No content within ${s(allowanceMs())} of a silent think's start (${budgetText()})` }
        : { at: sentAt + BEFORE_CONTENT_MS, why: () => `No content within ${s(BEFORE_CONTENT_MS)} of the send` };
    } else if (mode === 'phases') {
      next = thinking && allowanceMs() > BETWEEN_EVENTS_MS
        ? { at: lastAt + allowanceMs(), why: () => `No provider event within ${s(allowanceMs())} of a silent think's start (${budgetText()})` }
        : { at: lastAt + BETWEEN_EVENTS_MS, why: () => `No provider event within ${s(BETWEEN_EVENTS_MS)}` };
    }
    return next;
  };
  const arm = (at: number): void => {
    cancelTimer?.();
    cancelTimer = undefined;
    armedAt = at;
    if (at !== Infinity) cancelTimer = setLongTimeout(check, Math.max(0, at - performance.now()));
  };
  const check = (): void => {
    cancelTimer = undefined;
    armedAt = Infinity;
    const next = due();
    if (performance.now() >= next.at) {
      over = true;
      controller.abort(deadlineAbortReason(
        `${next.why()}: the call began at ${new Date(beganAt).toISOString()}, ` +
        `provider events: ${events}${events > 0 ? `, the last at ${new Date(lastWall).toISOString()}` : ''}`,
      ));
    } else {
      arm(next.at);
    }
  };
  // A report that brings the expiry closer moves the timer; a later one is
  // found when the timer fires early.
  const moved = (): void => {
    const next = due();
    if (next.at < armedAt) arm(next.at);
  };
  arm(due().at);

  const onAbort = (): void => {
    over = true;
    cancelTimer?.();
    cancelTimer = undefined;
    armedAt = Infinity;
    controller.abort(signal!.reason);
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  return {
    signal: controller.signal,
    report: (seen) => {
      if (over) return;
      const now = performance.now();
      lastAt = now;
      lastWall = Date.now();
      events++;
      if (seen === 'content') {
        contentSeen = true;
        thinking = false;
      } else if (seen === 'think') {
        if (contentSeen) thinking = true;
        else thinkEnds = now + allowanceMs();
      } else {
        thinking = false;
      }
      moved();
    },
    reportSend: (send) => {
      if (over) return;
      const maxTokens = send?.maxTokens;
      if (typeof maxTokens === 'number' && maxTokens > 0 && Number.isFinite(maxTokens)) budget = maxTokens;
      // Phases are reported at the send; a report after an event would
      // judge the call by rules its events weren't read under.
      if (send?.reportsPhases === true && mode === 'whole' && events === 0) mode = 'phases';
      moved();
    },
    cleanup: () => {
      over = true;
      cancelTimer?.();
      cancelTimer = undefined;
      armedAt = Infinity;
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
