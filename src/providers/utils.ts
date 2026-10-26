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
  const choice = (parsed as { choices?: Array<{ finish_reason?: unknown; error?: unknown } | null> }).choices?.[0];
  const topLevelError = (parsed as { error?: unknown }).error;
  const streamError = topLevelError || choice?.error;
  if (!streamError && choice?.finish_reason !== 'error') return;

  const fields: StreamErrorFrameFields =
    streamError && typeof streamError === 'object' ? (streamError as StreamErrorFrameFields) : {};
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

export type ToolUseInput = { input: Record<string, unknown>; unparseableInput?: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function notAnObject(raw: string, value: unknown): ToolUseInput {
  const kind = value === null ? 'null' : Array.isArray(value) ? 'an array' : `a ${typeof value}`;
  console.warn(`[membrane] Tool arguments are ${kind}, not an object; input is {} and unparseableInput keeps them`);
  return { input: {}, unparseableInput: raw };
}

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
      if (!tc.id && !name && !tc.function?.arguments) return;
      const another = (c: StreamedToolCall): boolean => !!name && !!c.function.name && name !== c.function.name;
      let call: StreamedToolCall | undefined;
      let slot: StreamedToolCall[] | undefined;
      if (tc.index !== undefined && tc.index !== null) {
        const index = streamIndex(tc.index);
        if (index === undefined) return;
        slot = indexed[index] ??= [];
        const own = tc.id ? slot.filter((c) => c.id === tc.id).at(-1) : undefined;
        call = own ?? slot[slot.length - 1];
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

export function isToolCallArgumentsDelta(delta: unknown): boolean {
  return delta !== null && typeof delta === 'object' &&
    (delta as { type?: unknown }).type === 'input_json_delta' &&
    typeof (delta as { partial_json?: unknown }).partial_json === 'string';
}

export function isEventObject(value: unknown): boolean {
  return isPlainObject(value);
}

export function toolUseInputFromText(text: unknown): ToolUseInput {
  if (text === undefined || text === null) return { input: {} };
  if (typeof text !== 'string') return toolUseInputFromValue(text);
  if (/^[ \t\n\r]*$/.test(text)) return { input: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.warn("[membrane] Tool arguments aren't valid JSON; input is {} and unparseableInput keeps them (not logged: tool arguments can carry secrets)");
    return { input: {}, unparseableInput: text };
  }
  return isPlainObject(parsed) ? { input: parsed } : notAnObject(text, parsed);
}

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

export function deadlineTimeoutError(error: unknown, rawRequest?: unknown): TimeoutAbortError {
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

  feed(chunk: string): string[] {
    this.buffer += chunk;
    const results: string[] = [];

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
