import { TimeoutAbortError } from '../types/errors.js';

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

function deadlineAbortReason(): DOMException {
  const reason = new DOMException('Request timed out', 'AbortError');
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
  return new TimeoutAbortError('Request timed out', error, rawRequest);
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
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  if (timeoutMs) {
    timeoutId = setTimeout(() => controller.abort(deadlineAbortReason()), timeoutMs);
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
