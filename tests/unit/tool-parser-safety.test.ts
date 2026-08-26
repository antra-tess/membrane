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

  it('refuses a nameless invoke rather than dispatching an empty tool name', () => {
    const text = toolBlock(`<invoke name=""/>`);

    const parsed = parseToolCalls(text);

    expect(parsed?.calls).toEqual([]);
  });

  it('keeps an apostrophe inside a double-quoted invoke name', () => {
    const text = toolBlock(`<invoke name="zz_it's_fake"/>`);

    const parsed = parseToolCalls(text);

    expect(parsed?.calls.map((c) => c.name)).toEqual([`zz_it's_fake`]);
  });
});

describe('F3 · a truncated block spliced with a later round closer', () => {
  const truncatedHalf =
    `${FUNCTION_CALLS_OPEN}\n<invoke name="zz_truncated_tool">\n<parameter name="fld1">partia`;
  const interveningTurn = '\n\nzz_user: try again\n\nzz_bot: ok\n';
  const realCall = toolBlock(
    `<invoke name="zz_real_tool">\n<parameter name="fld2">real value</parameter>\n</invoke>`
  );
  const splicedTurn = `zz_bot: calling now\n${truncatedHalf}${interveningTurn}${realCall}`;

  it('never dispatches a call whose span crosses another opener', () => {
    const parsed = parseToolCalls(splicedTurn);

    const dispatched = JSON.stringify(parsed?.calls ?? []);
    expect(dispatched).not.toContain('zz_truncated_tool');
    expect(dispatched).not.toContain('zz_user: try again');
  });

  it('re-anchors to the innermost opener so the real call still runs', () => {
    const parsed = parseToolCalls(splicedTurn);

    expect(parsed?.calls.map((c) => c.name)).toEqual(['zz_real_tool']);
    expect(parsed?.calls[0]?.input).toEqual({ fld2: 'real value' });
    expect(parsed?.beforeText).toContain('zz_truncated_tool');
  });

  it('re-anchors on the block-parsing path too', () => {
    const { blocks, toolCalls } = parseAccumulatedIntoBlocks(splicedTurn);

    expect(toolCalls.map((c) => c.name)).toEqual(['zz_real_tool']);
    expect(blocks.filter((b) => b.type === 'tool_use')).toHaveLength(1);
  });

  it('reports the repair rather than making it silently', () => {
    const clean = parseAccumulatedIntoBlocks(realCall);
    const spliced = parseAccumulatedIntoBlocks(splicedTurn);

    expect(clean.splicedToolBlocks).toBe(0);
    expect(spliced.splicedToolBlocks).toBe(1);
  });

  it('composes with executed-block detection: an earlier spent block stays spent', () => {
    const text =
      toolBlock(`<invoke name="zz_executed_tool"/>`) +
      '\n' +
      resultsBlock(`<result tool_use_id="ite1"><stdout>ok</stdout></result>`) +
      '\n' +
      `${truncatedHalf}${interveningTurn}${realCall}`;

    const parsed = parseToolCalls(text);

    expect(parsed?.calls.map((c) => c.name)).toEqual(['zz_real_tool']);
  });
});

describe('F9 · overlapping block spans', () => {
  const hypotheticalCall = toolBlock(
    `<invoke name="zz_hypothetical">\n<parameter name="fld1">v1</parameter>\n</invoke>`
  );
  const musingTurn =
    `<thinking>zz musing: I could call ${hypotheticalCall} but I will not.\n</thinking>\n` +
    'zz_bot: no.';

  it('does not emit a phantom tool_use for a block contained in a thinking block', () => {
    const { blocks, toolCalls } = parseAccumulatedIntoBlocks(musingTurn);

    expect(toolCalls).toEqual([]);
    expect(blocks.filter((b) => b.type === 'tool_use')).toHaveLength(0);
  });

  it('does not leak raw structural tags into visible text', () => {
    const { blocks } = parseAccumulatedIntoBlocks(musingTurn);

    const visibleText = blocks
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('\n');

    expect(visibleText).not.toContain('</thinking>');
    expect(visibleText).not.toContain('zz_hypothetical');
    expect(visibleText).toBe('zz_bot: no.');
  });

  it('keeps the containing thinking block whole', () => {
    const { blocks } = parseAccumulatedIntoBlocks(musingTurn);

    expect(blocks.map((b) => b.type)).toEqual(['thinking', 'text']);
    expect((blocks[0] as { thinking: string }).thinking).toContain('zz_hypothetical');
  });
});

describe('F9 · a contained call is filtered before legacy results are paired', () => {
  const shadowedCall = toolBlock(`<invoke name="zz_shadow_tool"/>`);
  const liveCall = toolBlock(`<invoke name="zz_live_tool"/>`);
  const legacyResult = resultsBlock(`<result>\n<stdout>zz-result</stdout>\n</result>`);

  // The quoted call sits earlier in the document than the live one, so a
  // callSites entry built before containment filtering is the FIRST unclaimed
  // site the legacy pairing walks — it claims the phantom and leaves the real
  // call answerless.
  const shadowedTurn =
    `<thinking>zz musing: I could call ${shadowedCall} but I will not.\n</thinking>\n` +
    `zz_bot: calling the real one\n${liveCall}\n${legacyResult}`;

  it('pairs the legacy result with the surviving call, not the quoted one', () => {
    const { blocks, toolResults } = parseAccumulatedIntoBlocks(shadowedTurn);

    const emittedCalls = blocks.filter((b) => b.type === 'tool_use') as Array<{ id: string; name: string }>;
    expect(emittedCalls.map((c) => c.name)).toEqual(['zz_live_tool']);
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]?.toolUseId).toBe(emittedCalls[0]?.id);
  });

  it('emits no tool_result addressed to a call that is not in the blocks', () => {
    const { blocks, toolResults } = parseAccumulatedIntoBlocks(shadowedTurn);

    const emittedCallIds = new Set(
      blocks.filter((b) => b.type === 'tool_use').map((b) => (b as { id: string }).id)
    );
    for (const result of toolResults) {
      expect(emittedCallIds.has(result.toolUseId)).toBe(true);
    }
  });

  it('pairs by tool_name against surviving calls only', () => {
    // The quoted call wears the SAME name as the live one, so the tool_name
    // disambiguator cannot rescue the pairing — only containment order can.
    const quotedTwin = toolBlock(`<invoke name="zz_live_tool"/>`);
    const namedResult = resultsBlock(
      `<result>\n<tool_name>zz_live_tool</tool_name>\n<stdout>zz-result</stdout>\n</result>`
    );
    const turn =
      `<thinking>zz musing: I could call ${quotedTwin} but I will not.\n</thinking>\n` +
      `zz_bot: calling the real one\n${liveCall}\n${namedResult}`;

    const { blocks, toolResults } = parseAccumulatedIntoBlocks(turn);

    const emittedCalls = blocks.filter((b) => b.type === 'tool_use') as Array<{ id: string }>;
    expect(emittedCalls).toHaveLength(1);
    expect(toolResults[0]?.toolUseId).toBe(emittedCalls[0]?.id);
  });
});

describe('F9 · the dispatch path applies the same containment', () => {
  const declinedCall = toolBlock(`<invoke name="zz_declined_tool"/>`);

  it('does not dispatch a call the model quoted and declined inside thinking', () => {
    const text = `<thinking>zz musing: I could call ${declinedCall} but I will not.\n</thinking>\nzz_bot: no.`;

    expect(parseToolCalls(text)).toBeNull();
  });

  it('does not dispatch a call quoted inside a tool result', () => {
    const text =
      `zz_bot: reading\n` +
      resultsBlock(`<result>\n<stdout>zz-result quoting ${declinedCall} verbatim</stdout>\n</result>`) +
      '\nzz_bot: done.';

    expect(parseToolCalls(text)).toBeNull();
  });

  it('still dispatches the live call that follows a quoted one', () => {
    const text =
      `<thinking>zz musing: I could call ${declinedCall} but I will not.\n</thinking>\n` +
      `zz_bot: this one though\n${toolBlock(`<invoke name="zz_live_tool"/>`)}`;

    const parsed = parseToolCalls(text);

    expect(parsed?.calls.map((c) => c.name)).toEqual(['zz_live_tool']);
    expect(parsed?.beforeText).toContain('zz_declined_tool');
  });

  it('selects the last unexecuted LIVE block, ignoring quoted ones after it', () => {
    const text =
      `zz_bot: calling\n${toolBlock(`<invoke name="zz_live_tool"/>`)}\n` +
      `<thinking>zz musing: I could also call ${declinedCall} but I will not.\n</thinking>`;

    const parsed = parseToolCalls(text);

    expect(parsed?.calls.map((c) => c.name)).toEqual(['zz_live_tool']);
  });
});

describe('F9 · diagnostics count only the spans that survive containment', () => {
  it('does not count a quoted zero-invoke block as an empty tool block', () => {
    const quotedEmptyBlock = toolBlock('zz musing: no invokes in here');
    const text = `<thinking>zz musing: a block like ${quotedEmptyBlock} would do nothing.\n</thinking>\nzz_bot: no.`;

    expect(parseAccumulatedIntoBlocks(text).emptyToolBlocks).toBe(0);
  });

  it('still counts a zero-invoke block that stands on its own', () => {
    const text = `zz_bot: here goes\n${toolBlock('zz musing: no invokes in here')}`;

    expect(parseAccumulatedIntoBlocks(text).emptyToolBlocks).toBe(1);
  });

  it('does not count a quoted spliced block as a repaired one', () => {
    const quotedSplice = `${FUNCTION_CALLS_OPEN}\n<invoke name="zz_stale_tool">\n${toolBlock(
      `<invoke name="zz_quoted_tool"/>`
    )}`;
    const text = `<thinking>zz musing: a truncation looks like ${quotedSplice}\n</thinking>\nzz_bot: no.`;

    expect(parseAccumulatedIntoBlocks(text).splicedToolBlocks).toBe(0);
  });

  it('does not flag an unclosed opener quoted inside a thinking block', () => {
    const text =
      `<thinking>zz musing: if I wrote ${FUNCTION_CALLS_OPEN} it would open a block.\n</thinking>\n` +
      'zz_bot: done.';

    expect(parseAccumulatedIntoBlocks(text).unclosedToolBlock).toBe(false);
  });

  it('does not flag an unclosed opener quoted inside a tool result', () => {
    const text =
      `zz_bot: reading\n` +
      resultsBlock(`<result>\n<stdout>zz-result mentioning ${FUNCTION_CALLS_OPEN} verbatim</stdout>\n</result>`) +
      '\nzz_bot: done.';

    expect(parseAccumulatedIntoBlocks(text).unclosedToolBlock).toBe(false);
  });

  it('still flags a genuinely unclosed block outside every span', () => {
    const text =
      `<thinking>zz musing: time to call it.\n</thinking>\n` +
      `${FUNCTION_CALLS_OPEN}\n<invoke name="zz_truncated_tool">\n<parameter name="fld1">partia`;

    expect(parseAccumulatedIntoBlocks(text).unclosedToolBlock).toBe(true);
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

describe('greptile#52-2 · a call span that crosses out of its container', () => {
  // The quoted opener sits INSIDE the thinking block and its closer sits after
  // `</thinking>`, so the call span starts inside a retained container and ends
  // past it. Retention that tested only `end` kept both spans: the quoted call
  // dispatched, and the source text from the quoted opener to `</thinking>`
  // was emitted twice — once as thinking content, once as a tool_use.
  const crossingTurn =
    `<thinking>zz musing: I could write ${FUNCTION_CALLS_OPEN}\n` +
    `<invoke name="zz_quoted_tool"><parameter name="fld1">v1</parameter></invoke>\n` +
    `but I will not.\n</thinking>\nzz_bot: no.\n${FUNCTION_CALLS_CLOSE}`;

  function countOccurrences(haystack: string, needle: string): number {
    return haystack.split(needle).length - 1;
  }

  it('does not dispatch a call that opened inside a closed thinking block', () => {
    expect(parseToolCalls(crossingTurn)).toBeNull();
  });

  it('emits no tool_use for the crossing span', () => {
    const { blocks, toolCalls } = parseAccumulatedIntoBlocks(crossingTurn);

    expect(toolCalls).toEqual([]);
    expect(blocks.filter((b) => b.type === 'tool_use')).toHaveLength(0);
  });

  it('renders the overlapping source text exactly once', () => {
    const { blocks } = parseAccumulatedIntoBlocks(crossingTurn);

    expect(countOccurrences(JSON.stringify(blocks), 'zz_quoted_tool')).toBe(1);
    expect(blocks.map((b) => b.type)).toEqual(['thinking', 'text']);
    expect((blocks[0] as { thinking: string }).thinking).toContain('zz_quoted_tool');
  });

  it('leaves the dangling closer as ordinary text', () => {
    const { blocks } = parseAccumulatedIntoBlocks(crossingTurn);

    const visibleText = blocks
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('\n');

    expect(visibleText).toContain('zz_bot: no.');
    expect(visibleText).toContain(FUNCTION_CALLS_CLOSE);
  });

  it('reports no structural defect for an unpaired closer', () => {
    // Measured, not assumed: hasUnclosedToolBlock compares opener COUNT to
    // closer count, so a closer with no opener left outside every span is
    // invisible to every structural diagnostic and simply reads as text.
    const parsed = parseAccumulatedIntoBlocks(crossingTurn);

    expect(parsed.unclosedToolBlock).toBe(false);
    expect(parsed.emptyToolBlocks).toBe(0);
    expect(parsed.splicedToolBlocks).toBe(0);
  });

  it('applies the same rule to a call opening inside a tool result', () => {
    const crossingResult =
      `zz_bot: reading\n${FUNCTION_RESULTS_OPEN}\n<result>\n<stdout>zz-result quoting ` +
      `${FUNCTION_CALLS_OPEN}\n<invoke name="zz_echoed_tool"/>\n</stdout>\n</result>\n` +
      `${FUNCTION_RESULTS_CLOSE}\nzz_bot: done.\n${FUNCTION_CALLS_CLOSE}`;

    const { blocks, toolCalls } = parseAccumulatedIntoBlocks(crossingResult);

    expect(parseToolCalls(crossingResult)).toBeNull();
    expect(toolCalls).toEqual([]);
    expect(blocks.filter((b) => b.type === 'tool_use')).toHaveLength(0);
  });

  it('still retains a span that merely abuts the previous one', () => {
    const abutting =
      `<thinking>zz musing: calling it now.\n</thinking>` +
      toolBlock(`<invoke name="zz_live_tool"/>`);

    const { blocks, toolCalls } = parseAccumulatedIntoBlocks(abutting);

    expect(toolCalls.map((c) => c.name)).toEqual(['zz_live_tool']);
    expect(blocks.map((b) => b.type)).toEqual(['thinking', 'tool_use']);
  });
});

describe('greptile#52-1 · an unclosed invoke head absorbs the next call', () => {
  // The block-splice disease one level down: INVOKE_REGEX's full-form
  // alternative is lazy, so an invoke left open pairs with the NEXT invoke's
  // closing tag. The head then dispatches carrying the inner call's parameters
  // as its own, and the inner call never parses at all.
  const absorbingBlock = toolBlock(
    `<invoke name="zz_head_tool"><parameter name="fld1">1</parameter>\n` +
      `<invoke name="zz_inner_tool"><parameter name="fld2">2</parameter></invoke>`
  );

  it('dispatches the inner invoke with its own parameters only', () => {
    const parsed = parseToolCalls(absorbingBlock);

    expect(parsed?.calls.map((c) => c.name)).toEqual(['zz_inner_tool']);
    expect(parsed?.calls[0]?.input).toEqual({ fld2: 2 });
  });

  it('never dispatches the unclosed head, absorbed content and all', () => {
    const dispatched = JSON.stringify(parseToolCalls(absorbingBlock)?.calls ?? []);

    expect(dispatched).not.toContain('zz_head_tool');
    expect(dispatched).not.toContain('fld1');
  });

  it('re-anchors on the block-parsing path too', () => {
    const { blocks, toolCalls } = parseAccumulatedIntoBlocks(absorbingBlock);

    expect(toolCalls.map((c) => c.name)).toEqual(['zz_inner_tool']);
    expect(toolCalls[0]?.input).toEqual({ fld2: 2 });
    expect(blocks.filter((b) => b.type === 'tool_use')).toHaveLength(1);
  });

  it('reports the refused head instead of dropping it silently', () => {
    expect(parseAccumulatedIntoBlocks(absorbingBlock).unclosedInvokeHeads).toBe(1);
  });

  it('counts every head an absorbing match swallowed', () => {
    const twoHeads = toolBlock(
      `<invoke name="zz_head_tool"><parameter name="fld1">1</parameter>\n` +
        `<invoke name="zz_second_head"><parameter name="fld2">2</parameter>\n` +
        `<invoke name="zz_inner_tool"><parameter name="fld3">3</parameter></invoke>`
    );

    const { toolCalls, unclosedInvokeHeads } = parseAccumulatedIntoBlocks(twoHeads);

    expect(toolCalls.map((c) => c.name)).toEqual(['zz_inner_tool']);
    expect(toolCalls[0]?.input).toEqual({ fld3: 3 });
    expect(unclosedInvokeHeads).toBe(2);
  });

  it('leaves legitimate sequential full-form invokes alone', () => {
    const sequential = toolBlock(
      `<invoke name="zz_first">\n<parameter name="fld1">v1</parameter>\n</invoke>\n` +
        `<invoke name="zz_second">\n<parameter name="fld2">v2</parameter>\n</invoke>`
    );

    const parsed = parseToolCalls(sequential);
    const { unclosedInvokeHeads } = parseAccumulatedIntoBlocks(sequential);

    expect(parsed?.calls.map((c) => c.name)).toEqual(['zz_first', 'zz_second']);
    expect(parsed?.calls.map((c) => c.input)).toEqual([{ fld1: 'v1' }, { fld2: 'v2' }]);
    expect(unclosedInvokeHeads).toBe(0);
  });

  it('leaves mixed full and self-closing order alone', () => {
    const mixed = toolBlock(
      `<invoke name="zz_first"/>\n` +
        `<invoke name="zz_second">\n<parameter name="fld1">v1</parameter>\n</invoke>\n` +
        `<invoke name="zz_third"/>`
    );

    const { toolCalls, unclosedInvokeHeads } = parseAccumulatedIntoBlocks(mixed);

    expect(toolCalls.map((c) => c.name)).toEqual(['zz_first', 'zz_second', 'zz_third']);
    expect(unclosedInvokeHeads).toBe(0);
  });

  it('re-anchors to a self-closing invoke swallowed by an open head', () => {
    const swallowedSelfClosing = toolBlock(
      `<invoke name="zz_head_tool"><parameter name="fld1">1</parameter>\n` +
        `<invoke name="zz_inner_tool"/></invoke>`
    );

    const parsed = parseToolCalls(swallowedSelfClosing);

    expect(parsed?.calls.map((c) => c.name)).toEqual(['zz_inner_tool']);
    expect(parsed?.calls[0]?.input).toEqual({});
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
