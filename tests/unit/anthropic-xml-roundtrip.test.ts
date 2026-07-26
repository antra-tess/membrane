/**
 * Round-trip fidelity tests for prefill/XML tool calls (membrane#36).
 *
 * In prefill mode the model's tool call IS generated text. Replaying a
 * synthesized paraphrase (`Participant>[tool]: {json}`) instead of the
 * original `<function_calls>` block:
 *   1. teaches the model a syntax the parser rejects (silent tool-call drop),
 *   2. rewrites the agent's own past turn.
 *
 * These tests pin the fix: parseAccumulatedIntoBlocks carries the verbatim
 * generation on the block (`rawXml`), and AnthropicXmlFormatter replays it
 * exactly. Legacy blocks without rawXml render in the canonical form the
 * parser and instructions agree on.
 */

import { describe, it, expect } from 'vitest';
import { parseAccumulatedIntoBlocks, parseToolCalls } from '../../src/utils/tool-parser.js';
import { AnthropicXmlFormatter } from '../../src/formatters/anthropic-xml.js';
import type { NormalizedMessage, ContentBlock } from '../../src/types/index.js';

// Tag fragments assembled at runtime so literal antml:-prefixed XML in this
// source file can't collide with any tooling that parses the same syntax.
const A = 'antml:';

// A generation with a large-int param and a multi-param invoke
const GENERATION_XML = `<function_calls>
<invoke name="channel-mode--set_channel_mode">
<parameter name="channelId">1234567890123456789</parameter>
<parameter name="mode">debounced</parameter>
<parameter name="debounceMs">60000</parameter>
</invoke>
</function_calls>`;

const RESULTS_XML = `<function_results>
<result tool_use_id="tool_1">
mode set: debounced @60000ms
</result>
</function_results>`;

function buildAndRender(content: ContentBlock[]): string {
  const formatter = new AnthropicXmlFormatter();
  const messages: NormalizedMessage[] = [
    { participant: 'antra', content: [{ type: 'text', text: 'set your wake gate please' }] },
    { participant: 'Rhys', content },
    { participant: 'antra', content: [{ type: 'text', text: 'thanks' }] },
    { participant: 'Rhys', content: [] }, // completion target
  ];
  const result = formatter.buildMessages(messages, { assistantParticipant: 'Rhys' });
  return result.messages
    .map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');
}

describe('parseAccumulatedIntoBlocks rawXml capture', () => {
  it('carries the verbatim function_calls substring on tool_use blocks', () => {
    const text = `Understood. Setting debounce now.\n${GENERATION_XML}`;
    const { blocks } = parseAccumulatedIntoBlocks(text);

    const toolUse = blocks.find(b => b.type === 'tool_use') as any;
    expect(toolUse).toBeDefined();
    expect(toolUse.rawXml).toBe(GENERATION_XML);
  });

  it('preserves antml: prefix and exact whitespace in rawXml', () => {
    const quirky =
      `<${A}function_calls>\n  <${A}invoke name="ping">\n` +
      `  <${A}parameter name="x">  spaced  </${A}parameter>\n` +
      `  </${A}invoke>\n</${A}function_calls>`;
    const { blocks } = parseAccumulatedIntoBlocks(quirky);

    const toolUse = blocks.find(b => b.type === 'tool_use') as any;
    expect(toolUse).toBeDefined();
    expect(toolUse.name).toBe('ping');
    expect(toolUse.rawXml).toBe(quirky);
  });

  it('shares one rawXml across every invoke parsed from a single block', () => {
    const multi = `<function_calls>
<invoke name="alpha">
<parameter name="a">1</parameter>
</invoke>
<invoke name="beta">
<parameter name="b">2</parameter>
</invoke>
</function_calls>`;
    const { blocks } = parseAccumulatedIntoBlocks(multi);

    const toolUses = blocks.filter(b => b.type === 'tool_use') as any[];
    expect(toolUses).toHaveLength(2);
    expect(toolUses[0].rawXml).toBe(multi);
    expect(toolUses[1].rawXml).toBe(multi);
  });

  it('carries the verbatim function_results substring on tool_result blocks', () => {
    const text = `${GENERATION_XML}\n${RESULTS_XML}`;
    const { blocks } = parseAccumulatedIntoBlocks(text);

    const toolResult = blocks.find(b => b.type === 'tool_result') as any;
    expect(toolResult).toBeDefined();
    expect(toolResult.rawXml).toBe(RESULTS_XML);
  });
});

describe('AnthropicXmlFormatter replay', () => {
  it('replays the verbatim generation — never the bracket paraphrase', () => {
    const accumulated = `Understood. Setting debounce now.\n${GENERATION_XML}\n${RESULTS_XML}\nDone — 60s debounce set.`;
    const { blocks } = parseAccumulatedIntoBlocks(accumulated);
    const rendered = buildAndRender(blocks);

    // Verbatim round-trip of the generation and the harness-placed results
    expect(rendered).toContain(GENERATION_XML);
    expect(rendered).toContain(RESULTS_XML);

    // The invented bracket forms must be gone
    expect(rendered).not.toContain('>[channel-mode--set_channel_mode]');
    expect(rendered).not.toContain('<[tool_result]');
  });

  it('emits a shared rawXml exactly once for multi-invoke blocks', () => {
    const multi = `<function_calls>
<invoke name="alpha">
<parameter name="a">1</parameter>
</invoke>
<invoke name="beta">
<parameter name="b">2</parameter>
</invoke>
</function_calls>`;
    const { blocks } = parseAccumulatedIntoBlocks(multi);
    const rendered = buildAndRender(blocks);

    const occurrences = rendered.split('<invoke name="alpha">').length - 1;
    expect(occurrences).toBe(1);
    expect(rendered).toContain(multi);
  });

  it('replayed document keeps parser and instructions in agreement', () => {
    // The core regression: after one replayed turn, the nearest example in
    // the document must still be the syntax the parser accepts.
    const accumulated = `${GENERATION_XML}\n${RESULTS_XML}`;
    const { blocks } = parseAccumulatedIntoBlocks(accumulated);
    const rendered = buildAndRender(blocks);

    // A model imitating the replayed example produces parseable calls
    const start = rendered.indexOf('<function_calls>');
    const end = rendered.indexOf('</function_calls>') + '</function_calls>'.length;
    const example = rendered.slice(start, end);
    const parsed = parseToolCalls(example);
    expect(parsed).not.toBeNull();
    expect(parsed!.calls[0].name).toBe('channel-mode--set_channel_mode');
    expect(parsed!.calls[0].input.channelId).toBe('1234567890123456789'); // large int stays string
    expect(parsed!.calls[0].input.debounceMs).toBe(60000);
  });
});

describe('legacy blocks (stored without rawXml)', () => {
  it('reconstructs canonical function_calls XML the parser accepts', () => {
    const legacy: ContentBlock[] = [
      { type: 'text', text: 'Opening channel.' },
      {
        type: 'tool_use',
        id: 'tool_legacy_1',
        name: 'channel_open',
        input: { channelId: '1234567890123456789', options: { mode: 'live' } },
      },
      {
        type: 'tool_result',
        toolUseId: 'tool_legacy_1',
        content: 'opened',
        isError: false,
      },
    ];
    const rendered = buildAndRender(legacy);

    // No bracket paraphrase
    expect(rendered).not.toContain('>[channel_open]');
    expect(rendered).not.toContain('<[tool_result]');

    // Canonical, parseable reconstruction
    const start = rendered.indexOf('<function_calls>');
    const end = rendered.indexOf('</function_calls>') + '</function_calls>'.length;
    expect(start).toBeGreaterThanOrEqual(0);
    const parsed = parseToolCalls(rendered.slice(start, end));
    expect(parsed).not.toBeNull();
    expect(parsed!.calls[0].name).toBe('channel_open');
    expect(parsed!.calls[0].input.channelId).toBe('1234567890123456789');
    expect(parsed!.calls[0].input.options).toEqual({ mode: 'live' });

    // Result renders as canonical function_results
    expect(rendered).toContain('<function_results>');
    expect(rendered).toContain('tool_use_id="tool_legacy_1"');
    expect(rendered).toContain('opened');
  });

  it('groups consecutive legacy tool_use blocks into one function_calls block', () => {
    const legacy: ContentBlock[] = [
      { type: 'tool_use', id: 't1', name: 'alpha', input: { a: 1 } },
      { type: 'tool_use', id: 't2', name: 'beta', input: { b: 'two' } },
    ];
    const rendered = buildAndRender(legacy);

    expect(rendered.split('<function_calls>').length - 1).toBe(1);
    const start = rendered.indexOf('<function_calls>');
    const end = rendered.indexOf('</function_calls>') + '</function_calls>'.length;
    const parsed = parseToolCalls(rendered.slice(start, end));
    expect(parsed!.calls.map(c => c.name)).toEqual(['alpha', 'beta']);
    expect(parsed!.calls[1].input.b).toBe('two');
  });
});
