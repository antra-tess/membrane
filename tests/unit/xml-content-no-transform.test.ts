import { describe, it, expect } from 'vitest';
import {
  parseToolCalls,
  parseAccumulatedIntoBlocks,
  formatToolResults,
} from '../../src/utils/tool-parser.js';
import { AnthropicXmlFormatter } from '../../src/formatters/anthropic-xml.js';
import type {
  ToolDefinition,
  NormalizedMessage,
  ContentBlock,
} from '../../src/types/index.js';

const zzMarkup = '<div class="zz1">zz-markup</div>';
const zzEntityText = 'zz-entity-text: &lt;zz-b&gt; and &amp; zz-raw';
const zzJsonText = '{"ite1": "  zz-spaced  "}';
const zzOrdinaryPayloads = [zzMarkup, zzEntityText, zzJsonText];

const zzStringParamTool: ToolDefinition = {
  name: 'zz_no_transform_tool',
  description: 'obviously-fake tool whose one parameter is declared string',
  inputSchema: { type: 'object', properties: { fld1: { type: 'string' } } },
};

function callWith(value: string): string {
  return (
    '<function_calls>\n<invoke name="zz_no_transform_tool">\n' +
    `<parameter name="fld1">${value}</parameter>\n` +
    '</invoke>\n</function_calls>'
  );
}

function parsedParam(value: string): unknown {
  const parsed = parseToolCalls(callWith(value), { tools: [zzStringParamTool] });
  expect(parsed).not.toBeNull();
  return parsed!.calls[0]!.input.fld1;
}

function renderThroughFormatter(content: ContentBlock[]): string {
  const formatter = new AnthropicXmlFormatter();
  const messages: NormalizedMessage[] = [
    { participant: 'zz-user', content: [{ type: 'text', text: 'zz-render-request' }] },
    { participant: 'zz-bot', content },
    { participant: 'zz-user', content: [{ type: 'text', text: 'zz-render-followup' }] },
    { participant: 'zz-bot', content: [] },
  ];
  const result = formatter.buildMessages(messages, { assistantParticipant: 'zz-bot' });
  return result.messages
    .map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');
}

function lastCallBlock(doc: string): string {
  const start = doc.lastIndexOf('<function_calls>');
  const end = doc.indexOf('</function_calls>', start) + '</function_calls>'.length;
  expect(start).toBeGreaterThanOrEqual(0);
  return doc.slice(start, end);
}

describe('parameter values are byte-untouched on the READ polarity', () => {
  for (const payload of zzOrdinaryPayloads) {
    it(`carries ${JSON.stringify(payload)} through to the tool unchanged`, () => {
      expect(parsedParam(payload)).toBe(payload);
    });
  }

  it('keeps the spaces around ordinary content, dropping one framing newline on each side', () => {
    expect(parsedParam(`\n  ${zzMarkup}  \n`)).toBe(`  ${zzMarkup}  `);
    expect(parsedParam(`  ${zzMarkup}  `)).toBe(`  ${zzMarkup}  `);
  });
});

describe('parameter values are byte-untouched on the WRITE polarity', () => {
  for (const payload of [...zzOrdinaryPayloads, `\n${zzMarkup}\n`, 'zz-line\n', '\n']) {
    it(`writes ${JSON.stringify(payload)} to the wire raw and reads it back whole`, () => {
      const doc = renderThroughFormatter([
        { type: 'tool_use', id: 'ite1', name: 'zz_no_transform_tool', input: { fld1: payload } },
      ]);
      expect(doc).toContain(payload);

      const parsed = parseToolCalls(lastCallBlock(doc), { tools: [zzStringParamTool] });
      expect(parsed!.calls[0]!.input.fld1).toBe(payload);
    });
  }
});

describe('tool-result bodies are byte-untouched', () => {
  const roundTrip = (content: string): { wire: string; readBack: unknown } => {
    const wire = formatToolResults([
      { toolUseId: 'ite1', toolName: 'zz_no_transform_tool', content, isError: false },
    ]);
    const { toolResults } = parseAccumulatedIntoBlocks(wire);
    expect(toolResults).toHaveLength(1);
    return { wire, readBack: toolResults[0]!.content };
  };

  for (const payload of [zzMarkup, zzJsonText]) {
    it(`round-trips ${JSON.stringify(payload)} byte for byte`, () => {
      const { wire, readBack } = roundTrip(payload);
      expect(wire).toContain(payload);
      expect(readBack).toBe(payload);
    });
  }

  it('writes entity TEXT to the wire raw, without blanket escaping', () => {
    const { wire } = roundTrip(zzEntityText);
    expect(wire).toContain(zzEntityText);
    expect(wire).not.toContain('&amp;lt;');
  });
});
