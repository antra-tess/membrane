/**
 * The literal spelling of an XML tool-call parameter value: CDATA.
 *
 * A parameter's content may be written as one or more consecutive CDATA
 * sections directly after its opening tag (one framing newline allowed). The
 * sections concatenate, which is how a literal `]]>` is carried: split it as
 * `]]]]><![CDATA[>`. Such a payload is opaque to every structural scan, so a
 * value can carry `</parameter>`, `</invoke>`, `</function_calls>` or any other
 * markup exactly. CDATA is recognized only at the start of a parameter's
 * value; anywhere else it is ordinary text.
 *
 * This module holds the pieces every reader and writer of that spelling
 * shares: the accumulated-text parser (tool-parser.ts), the incremental
 * streaming parser (stream-parser.ts) and the legacy reconstruction renderer
 * (formatters/anthropic-xml.ts).
 */

export const CDATA_OPEN = '<![CDATA[';
export const CDATA_CLOSE = ']]>';

/** What a parameter value begins with, read from just after its opening tag. */
export type PayloadRead =
  /** Not CDATA-led: an ordinary value, read as it always was. */
  | { kind: 'raw' }
  /**
   * One or more consecutive, terminated CDATA sections. `start` is the first
   * section's `<![CDATA[`, `end` is just past the last `]]>`, and `payload` is
   * the sections' contents concatenated: the value, exactly.
   */
  | { kind: 'cdata'; start: number; end: number; payload: string }
  /** A CDATA section that does not end before `bound`. `start` is its `<![CDATA[`. */
  | { kind: 'unterminated'; start: number };

/**
 * Read the value that starts at `valueStart` (just past a parameter's opening
 * tag) as a CDATA payload, if it is one.
 *
 * `bound` is where the readable text ends: the end of the text, or the end of
 * the history a payload may not run past. A section whose `]]>` lies beyond
 * the bound is unterminated.
 */
export function readPayload(text: string, valueStart: number, bound: number = text.length): PayloadRead {
  let cursor = valueStart;
  if (text[cursor] === '\n') cursor++;
  if (!text.startsWith(CDATA_OPEN, cursor) || cursor + CDATA_OPEN.length > bound) return { kind: 'raw' };

  const start = cursor;
  let payload = '';
  do {
    const contentStart = cursor + CDATA_OPEN.length;
    const close = text.indexOf(CDATA_CLOSE, contentStart);
    if (close === -1 || close + CDATA_CLOSE.length > bound) return { kind: 'unterminated', start };
    payload += text.slice(contentStart, close);
    cursor = close + CDATA_CLOSE.length;
  } while (text.startsWith(CDATA_OPEN, cursor) && cursor + CDATA_OPEN.length <= bound);

  return { kind: 'cdata', start, end: cursor, payload };
}

/**
 * Write `text` as CDATA that reads back as exactly `text`: one section, or
 * several where the text contains `]]>`, split between its `]]` and `>`.
 */
export function encodeCdata(text: string): string {
  return `${CDATA_OPEN}${text.split(CDATA_CLOSE).join(`]]${CDATA_CLOSE}${CDATA_OPEN}>`)}${CDATA_CLOSE}`;
}
