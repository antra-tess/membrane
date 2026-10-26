/**
 * In prefill mode the model's tool call is generated text, and the model
 * writes what it sees in its history: a replayed paraphrase of a call teaches
 * it a syntax the parser rejects.
 */

import { describe, it, expect } from 'vitest';
import { parseAccumulatedIntoBlocks, parseToolCalls } from '../../src/utils/tool-parser.js';
import { AnthropicXmlFormatter } from '../../src/formatters/anthropic-xml.js';
import type { NormalizedMessage, ContentBlock } from '../../src/types/index.js';

// Tag fragments assembled at runtime so literal antml:-prefixed XML in this
// source file can't collide with any tooling that parses the same syntax.
const A = 'antml:';

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
    { participant: 'Rhys', content: [] },
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

    expect(rendered).toContain(GENERATION_XML);
    expect(rendered).toContain(RESULTS_XML);

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
    const accumulated = `${GENERATION_XML}\n${RESULTS_XML}`;
    const { blocks } = parseAccumulatedIntoBlocks(accumulated);
    const rendered = buildAndRender(blocks);

    const start = rendered.indexOf('<function_calls>');
    const end = rendered.indexOf('</function_calls>') + '</function_calls>'.length;
    const example = rendered.slice(start, end);
    const parsed = parseToolCalls(example);
    expect(parsed).not.toBeNull();
    expect(parsed!.calls[0].name).toBe('channel-mode--set_channel_mode');
    expect(parsed!.calls[0].input.channelId).toBe('1234567890123456789');
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

    expect(rendered).not.toContain('>[channel_open]');
    expect(rendered).not.toContain('<[tool_result]');

    const start = rendered.indexOf('<function_calls>');
    const end = rendered.indexOf('</function_calls>') + '</function_calls>'.length;
    expect(start).toBeGreaterThanOrEqual(0);
    const parsed = parseToolCalls(rendered.slice(start, end));
    expect(parsed).not.toBeNull();
    expect(parsed!.calls[0].name).toBe('channel_open');
    expect(parsed!.calls[0].input.channelId).toBe('1234567890123456789');
    expect(parsed!.calls[0].input.options).toEqual({ mode: 'live' });

    expect(rendered).toContain('<function_results>');
    expect(rendered).not.toContain('tool_use_id=');
    expect(rendered).toContain('<stdout>');
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

describe('tool-result replay attribution (D2, Evander 2026-08-08)', () => {
  function renderConversation(messages: NormalizedMessage[]): string {
    const formatter = new AnthropicXmlFormatter();
    const result = formatter.buildMessages(messages, { assistantParticipant: 'Rhys' });
    return result.messages
      .map(m => (typeof m.content === 'string'
        ? m.content
        : (m.content as Array<{ text?: string }>).map(b => b.text ?? '').join('')))
      .join('\n');
  }

  const toolRoundMessages: NormalizedMessage[] = [
    { participant: 'antra', content: [{ type: 'text', text: 'please check the mode' }] },
    {
      participant: 'Rhys',
      content: [
        { type: 'text', text: 'Checking now.' },
        {
          type: 'tool_use', id: 'tool_d2_1', name: 'gate_status', input: {},
          rawXml: '<function_calls>\n<invoke name="gate_status">\n</invoke>\n</function_calls>',
        } as ContentBlock,
      ],
    },
    {
      participant: 'user',
      content: [
        { type: 'tool_result', toolUseId: 'tool_d2_1', toolName: 'gate_status', content: 'mode: debounced', isError: false } as ContentBlock,
      ],
    },
    { participant: 'Rhys', content: [{ type: 'text', text: 'The mode is debounced.' }] },
    { participant: 'antra', content: [{ type: 'text', text: 'thanks' }] },
    { participant: 'Rhys', content: [] },
  ];

  it('replays results unlabeled inside the assistant flow (no user: attribution)', () => {
    const doc = renderConversation(toolRoundMessages);
    expect(doc).toContain('<function_results>');
    expect(doc).not.toContain('user: <function_results>');
    expect(doc).toContain('<tool_name>gate_status</tool_name>');
    expect(doc).toContain('mode: debounced');
  });

  it('continues the same assistant turn after results without a fresh label', () => {
    const doc = renderConversation(toolRoundMessages);
    const afterResults = doc.slice(doc.indexOf('</function_results>'));
    expect(afterResults).not.toContain('Rhys: The mode is debounced.');
    expect(afterResults).toContain('The mode is debounced.');
    expect(doc).toContain('antra: thanks');
  });
});
