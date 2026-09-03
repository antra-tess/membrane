/**
 * The no-transform contract for XML-mode content.
 *
 * Ordinary content — HTML-shaped markup, entity TEXT, JSON-looking text — is
 * data, not syntax. The parser and the XML formatter must carry it through
 * byte for byte, on the way in and on the way out. This file pins that
 * property so any future change to the XML encoding has to break an explicit
 * assertion rather than a habit.
 *
 * Eight of the nine cells below are byte-identity on merged main and stay
 * byte-identity here. The ninth is a NAMED, pre-existing asymmetry on the
 * tool-result READ path, pinned as it currently behaves in its own describe
 * block at the bottom — see the comment there for what the encoding-redesign
 * lane must do to it.
 */

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

/** Render a tool_use block back to XML through the formatter it ships with. */
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

  it('preserves leading and trailing whitespace around ordinary content', () => {
    const padded = `\n  ${zzMarkup}  \n`;
    expect(parsedParam(padded)).toBe(padded);
  });
});

describe('parameter values are byte-untouched on the WRITE polarity', () => {
  for (const payload of zzOrdinaryPayloads) {
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
      // No blanket escaping on the write: the bytes are on the wire as-is.
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

describe('NAMED ASYMMETRY: entity text in a result body is decoded on read', () => {
  it('is pinned as it currently behaves, NOT as it should behave', () => {
    // Pre-existing on merged main, predating PR #53 entirely: the result-read
    // path decodes result and error bodies unconditionally, at the four
    // unescapeXml calls inside parseAccumulatedIntoBlocks — the result body,
    // the error body, the legacy result body and the legacy error body
    // (src/utils/tool-parser.ts:1072, 1089, 1107, 1122 at the time of writing;
    // grep `unescapeXml(` in that function if the numbers have moved). The
    // write side does NOT escape correspondingly, so entity text survives the
    // wire and is then consumed on the way back.
    //
    // The collision-only redesign narrows this decode to collision entities
    // only, making write/read symmetric; this test then flips to assert
    // byte-identity.
    const wire = formatToolResults([
      { toolUseId: 'ite1', content: zzEntityText, isError: false },
    ]);
    const { toolResults } = parseAccumulatedIntoBlocks(wire);
    expect(toolResults[0]!.content).toBe('zz-entity-text: <zz-b> and & zz-raw');
    expect(toolResults[0]!.content).not.toBe(zzEntityText);
  });
});
