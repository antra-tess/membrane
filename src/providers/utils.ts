import { networkError } from '../types/errors.js';

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
 */
export function throwOnStreamErrorFrame(parsed: unknown, providerLabel: string): void {
  if (typeof parsed !== 'object' || parsed === null) return;
  const streamError = (parsed as { error?: unknown }).error;
  if (!streamError) return;

  const { code, message } = streamError as { code?: number | string; message?: string };
  throw new Error(
    `${providerLabel} stream error${code !== undefined ? ` (${code})` : ''}: ` +
      `${message ?? JSON.stringify(streamError)}`
  );
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
