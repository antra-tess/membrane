/**
 * Parser-safety regressions for the XML tool parser.
 *
 * Each case here fails on the unfixed parser — they are the red fixtures for
 * the 2026-08-25 review findings F3 (spliced truncated block), F8 (one-spelling
 * invoke regex + silent zero-invoke block), F9 (contained spans), F11 (document
 * order across invoke forms) and F13 (executed-block lookahead).
 */

import { describe, it, expect } from 'vitest';
import { parseAccumulatedIntoBlocks, parseToolCalls } from '../../src/utils/tool-parser.js';

const FUNCTION_CALLS_OPEN = '<' + 'function_calls>';
const FUNCTION_CALLS_CLOSE = '</' + 'function_calls>';
const FUNCTION_RESULTS_OPEN = '<' + 'function_results>';
const FUNCTION_RESULTS_CLOSE = '</' + 'function_results>';

function toolBlock(inner: string): string {
  return `${FUNCTION_CALLS_OPEN}\n${inner}\n${FUNCTION_CALLS_CLOSE}`;
}

function resultsBlock(inner: string): string {
  return `${FUNCTION_RESULTS_OPEN}\n${inner}\n${FUNCTION_RESULTS_CLOSE}`;
}

describe('F8 · invoke tag spelling tolerance', () => {
  it('parses a single-quoted invoke name', () => {
    const text = toolBlock(`<invoke name='zz_single_quoted'>\n<parameter name="fld1">v1</parameter>\n</invoke>`);

    const parsed = parseToolCalls(text);

    expect(parsed?.calls.map((c) => c.name)).toEqual(['zz_single_quoted']);
    expect(parsed?.calls[0]?.input).toEqual({ fld1: 'v1' });
  });

  it('parses an invoke tag with whitespace before the closing angle bracket', () => {
    const text = toolBlock(`<invoke name="zz_spaced_gt" >\n<parameter name="fld1">v1</parameter>\n</invoke>`);

    const parsed = parseToolCalls(text);

    expect(parsed?.calls.map((c) => c.name)).toEqual(['zz_spaced_gt']);
  });

  it('parses a single-quoted self-closing invoke', () => {
    const text = toolBlock(`<invoke name='zz_single_quoted_self'  />`);

    const parsed = parseToolCalls(text);

    expect(parsed?.calls.map((c) => c.name)).toEqual(['zz_single_quoted_self']);
    expect(parsed?.calls[0]?.input).toEqual({});
  });

  it('keeps an apostrophe inside a double-quoted invoke name', () => {
    const text = toolBlock(`<invoke name="zz_it's_fake"/>`);

    const parsed = parseToolCalls(text);

    expect(parsed?.calls.map((c) => c.name)).toEqual([`zz_it's_fake`]);
  });
});

describe('F13 · executed-block detection', () => {
  it('treats a block as executed when only whitespace separates it from its results', () => {
    const text =
      toolBlock(`<invoke name="zz_padded"/>`) +
      ' '.repeat(120) +
      resultsBlock(`<result tool_use_id="ite1"><stdout>ok</stdout></result>`);

    expect(parseToolCalls(text)).toBeNull();
  });

  it('does not treat a block as executed when model text intervenes before the results', () => {
    const text =
      toolBlock(`<invoke name="zz_unexecuted"/>`) +
      '\nzz_bot: standing by\n' +
      resultsBlock(`<result tool_use_id="ite1"><stdout>ok</stdout></result>`);

    const parsed = parseToolCalls(text);

    expect(parsed?.calls.map((c) => c.name)).toEqual(['zz_unexecuted']);
  });
});

describe('F11 · document order across invoke forms', () => {
  const mixedFormsBlock = toolBlock(
    `<invoke name="zz_first"/>\n` +
      `<invoke name="zz_second">\n<parameter name="fld1">v1</parameter>\n</invoke>\n` +
      `<invoke name="zz_third"/>`
  );

  it('preserves document order in parseToolCalls', () => {
    const parsed = parseToolCalls(mixedFormsBlock);

    expect(parsed?.calls.map((c) => c.name)).toEqual(['zz_first', 'zz_second', 'zz_third']);
  });

  it('preserves document order in parseAccumulatedIntoBlocks', () => {
    const { blocks, toolCalls } = parseAccumulatedIntoBlocks(mixedFormsBlock);

    expect(toolCalls.map((c) => c.name)).toEqual(['zz_first', 'zz_second', 'zz_third']);
    expect(blocks.filter((b) => b.type === 'tool_use').map((b) => (b as { name: string }).name)).toEqual([
      'zz_first',
      'zz_second',
      'zz_third',
    ]);
  });
});
