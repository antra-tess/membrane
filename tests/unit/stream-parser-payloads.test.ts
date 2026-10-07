/**
 * The incremental parser and CDATA payloads (shelf-376).
 *
 * A parameter value written as CDATA is data: a literal `</function_calls>`,
 * `<thinking>` or `</parameter>` inside it must not move the depths the loops
 * use to tell a real stop from a false one, must not end the tool_call block
 * that typed its text, and a stop sequence inside it is not a stop. The
 * accumulated parser reads complete text by the same rule; these tests also
 * hold the two views to agreement over every way the text can arrive in chunks.
 */
import { describe, expect, it } from 'vitest';
import { IncrementalXmlParser } from '../../src/utils/stream-parser.js';
import { hasUnclosedToolBlock } from '../../src/utils/tool-parser.js';

const CALLS_OPEN = '<' + 'function_calls>';
const CALLS_CLOSE = '</' + 'function_calls>';

const payload = `${CALLS_CLOSE} and <thinking> and </parameter></invoke> and ]] then >`;
const call =
  `${CALLS_OPEN}\n<invoke name="note">\n<parameter name="text"><![CDATA[${payload}]]></parameter>\n` +
  `<parameter name="also">\n<![CDATA[a]]]]><![CDATA[>b]]>\n</parameter>\n</invoke>\n${CALLS_CLOSE}`;

function streamed(text: string, chunkSize: number): IncrementalXmlParser {
  const parser = new IncrementalXmlParser();
  for (let at = 0; at < text.length; at += chunkSize) parser.processChunk(text.slice(at, at + chunkSize));
  return parser;
}

describe('a CDATA payload in the incremental parser', () => {
  it('leaves depths alone and keeps its text typed as the tool call, closing only at the real closer', () => {
    const parser = new IncrementalXmlParser();
    const before = call.slice(0, call.lastIndexOf(CALLS_CLOSE));
    const result = parser.processChunk(before);

    expect(parser.getDepths()).toEqual({ functionCalls: 1, functionResults: 0, thinking: 0 });
    const payloadText = result.emissions
      .filter((emission) => emission.kind === 'content')
      .map((emission) => emission as { text: string; meta: { type: string; visible: boolean } })
      .filter((emission) => emission.text.includes('<thinking>'));
    expect(payloadText.length).toBeGreaterThan(0);
    for (const emission of payloadText) expect(emission.meta).toMatchObject({ type: 'tool_call', visible: false });

    parser.processChunk(CALLS_CLOSE);
    expect(parser.getDepths().functionCalls).toBe(0);
  });

  it.each([1, 2, 3, 7, 13])('reads the same at chunk size %i, through push and through processChunk', (size) => {
    const pushed = new IncrementalXmlParser();
    for (let at = 0; at < call.length; at += size) pushed.push(call.slice(at, at + size));
    const chunked = streamed(call, size);

    for (const parser of [pushed, chunked]) {
      expect(parser.isInsideBlock()).toBe(false);
      expect(parser.isInsidePayload()).toBe(false);
      expect(parser.getAccumulated()).toBe(call);
    }
  });

  it('knows, at every point of the text, whether it is inside a payload — as the complete-text parser does', () => {
    for (let end = 1; end <= call.length; end++) {
      const prefix = call.slice(0, end);
      for (const size of [1, 5, 64]) {
        const parser = streamed(prefix, size);
        expect(parser.isInsideFunctionCalls()).toBe(hasUnclosedToolBlock(prefix));
      }
    }
  });

  it('locates its payloads in the accumulated text', () => {
    const parser = streamed(call, 4);
    const inside = call.indexOf(`${CALLS_CLOSE} and <thinking>`);
    expect(parser.isPayloadAt(inside)).toBe(true);
    expect(parser.isPayloadAt(call.lastIndexOf(CALLS_CLOSE))).toBe(false);
    expect(parser.isPayloadAt(call.indexOf('<invoke'))).toBe(false);
  });

  it('is inside a payload where a stop inside one leaves the text, and resumes inside it', () => {
    const parser = new IncrementalXmlParser();
    const cut = call.indexOf(CALLS_CLOSE, call.indexOf('<![CDATA['));
    parser.processChunk(call.slice(0, cut));
    expect(parser.isInsidePayload()).toBe(true);

    // A provider stop consumed the closer: it is restored once, and the stream resumes.
    parser.push(CALLS_CLOSE);
    parser.resetForNewIteration();
    expect(parser.isInsidePayload()).toBe(true);
    parser.processChunk(call.slice(cut + CALLS_CLOSE.length));
    expect(parser.isInsideBlock()).toBe(false);
  });

  it('starts no payload outside a structural parameter: in prose, in thinking, or after an opener inside a raw value', () => {
    const prose = new IncrementalXmlParser();
    prose.processChunk(`<parameter name="x"><![CDATA[ ${CALLS_OPEN}`);
    expect(prose.isInsidePayload()).toBe(false);
    expect(prose.isInsideFunctionCalls()).toBe(true);

    const thinking = new IncrementalXmlParser();
    thinking.processChunk(`<thinking>${CALLS_OPEN}<invoke name="t"><parameter name="x"><![CDATA[`);
    expect(thinking.isInsidePayload()).toBe(false);

    const raw = new IncrementalXmlParser();
    raw.processChunk(`${CALLS_OPEN}<invoke name="t"><parameter name="x">a <parameter name="y"><![CDATA[ ${CALLS_CLOSE}`);
    expect(raw.isInsidePayload()).toBe(false);
    expect(raw.isInsideFunctionCalls()).toBe(false);
  });

  it('ends a payload history left open where history ends', () => {
    const parser = new IncrementalXmlParser();
    parser.push(`${CALLS_OPEN}<invoke name="t"><parameter name="x"><![CDATA[left open`);
    expect(parser.isInsidePayload()).toBe(true);
    parser.endHistory();
    expect(parser.isInsidePayload()).toBe(false);

    // The turn's own tags are structure again.
    parser.processChunk(`${CALLS_CLOSE}\n${CALLS_OPEN}`);
    expect(parser.getDepths().functionCalls).toBeGreaterThan(0);
  });

  it('reads an element by name: a parameter named thinking is not a thinking tag', () => {
    const parser = new IncrementalXmlParser();
    parser.processChunk(`${CALLS_OPEN}<invoke name="t"><parameter name="thinking_budget">5</parameter></invoke>${CALLS_CLOSE}`);
    expect(parser.getDepths()).toEqual({ functionCalls: 0, functionResults: 0, thinking: 0 });
  });
});
