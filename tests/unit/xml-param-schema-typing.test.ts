/**
 * Schema-typed XML parameter parsing (A1 finding F4).
 *
 * Parameter values were guessed — trimmed, then JSON.parse'd with the trimmed
 * text as fallback — with the declared inputSchema never consulted. A
 * string-typed argument lost its leading/trailing whitespace (fatal for
 * exact-match edit tools) and silently changed type whenever its text happened
 * to be valid JSON.
 *
 * The fix consults the declaration at the parse site: a parameter declared
 * `string` keeps its raw, untrimmed text; JSON-shaped declarations JSON-parse
 * with a loud diagnostic on disagreement; undeclared parameters keep the legacy
 * guess exactly.
 */

import { describe, it, expect, vi } from 'vitest';
import { parseToolCalls, parseAccumulatedIntoBlocks } from '../../src/utils/tool-parser.js';
import type { ToolDefinition } from '../../src/types/index.js';

const zzEditTool: ToolDefinition = {
  name: 'zz_edit_tool',
  description: 'obviously-fake exact-match edit tool',
  inputSchema: {
    type: 'object',
    properties: {
      fld1: { type: 'string' },
      fld2: { type: 'object' },
      fld3: { type: 'number' },
      fld4: { type: 'boolean' },
      fld5: { type: 'array' },
    },
  },
};

const tools = [zzEditTool];

function callWith(params: Record<string, string>): string {
  const body = Object.entries(params)
    .map(([name, value]) => `<parameter name="${name}">${value}</parameter>`)
    .join('\n');
  return `<function_calls>\n<invoke name="zz_edit_tool">\n${body}\n</invoke>\n</function_calls>`;
}

function inputOf(xml: string, opts?: { tools?: ToolDefinition[] }): Record<string, unknown> {
  const parsed = parseToolCalls(xml, opts);
  expect(parsed).not.toBeNull();
  expect(parsed!.calls).toHaveLength(1);
  return parsed!.calls[0]!.input;
}

describe('schema-typed parameter parsing', () => {
  it('keeps a string-typed value RAW and UNTRIMMED', () => {
    const input = inputOf(callWith({ fld1: '\n  zz-indented-line\n' }), { tools });
    expect(input.fld1).toBe('\n  zz-indented-line\n');
  });

  it('never JSON-coerces a string-typed value', () => {
    const input = inputOf(callWith({ fld1: '{"ite1": 1}' }), { tools });
    expect(input.fld1).toBe('{"ite1": 1}');
    expect(typeof input.fld1).toBe('string');

    for (const literal of ['true', '2', 'null', '"zz-quoted"']) {
      const one = inputOf(callWith({ fld1: literal }), { tools });
      expect(one.fld1).toBe(literal);
      expect(typeof one.fld1).toBe('string');
    }
  });

  it('parses object / array / number / boolean values as JSON', () => {
    const input = inputOf(
      callWith({ fld2: '{"ite1": 1}', fld3: ' 42 ', fld4: 'true', fld5: '[1, 2]' }),
      { tools }
    );
    expect(input.fld2).toEqual({ ite1: 1 });
    expect(input.fld3).toBe(42);
    expect(input.fld4).toBe(true);
    expect(input.fld5).toEqual([1, 2]);
  });

  it('is LOUD when a typed value does not parse, and keeps the raw text', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const input = inputOf(callWith({ fld2: 'zz-not-json-at-all' }), { tools });
      expect(input.fld2).toBe('zz-not-json-at-all');
      expect(warn).toHaveBeenCalled();
      const message = warn.mock.calls.map(c => c.join(' ')).join('\n');
      expect(message).toContain('zz_edit_tool');
      expect(message).toContain('fld2');
      expect(message).toContain('object');
    } finally {
      warn.mockRestore();
    }
  });

  it('is LOUD when a typed value parses to the wrong JSON type', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const input = inputOf(callWith({ fld5: '{"ite1": 1}' }), { tools });
      expect(input.fld5).toEqual({ ite1: 1 });
      expect(warn).toHaveBeenCalled();
      const message = warn.mock.calls.map(c => c.join(' ')).join('\n');
      expect(message).toContain('fld5');
      expect(message).toContain('array');
    } finally {
      warn.mockRestore();
    }
  });

  it('falls back to the legacy guess when no schema is supplied', () => {
    const input = inputOf(callWith({ fld1: '  zz-spaced  ', fld3: '7' }));
    expect(input.fld1).toBe('zz-spaced');
    expect(input.fld3).toBe(7);
  });

  it('applies the same schema treatment on the accumulated-blocks path', () => {
    const { toolCalls } = parseAccumulatedIntoBlocks(callWith({ fld1: '\n  zz-indented-line\n' }), {
      tools,
    });
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.input.fld1).toBe('\n  zz-indented-line\n');
  });

  it('types a re-anchored invoke against the tool it actually dispatches', () => {
    // collectInvokes re-anchors an invoke head that swallowed the next one:
    // only the INNERMOST head owns the closing tag and gets dispatched. The
    // schema consulted must therefore be the innermost head's, not the
    // outer head's — the two disagree about fld1 on purpose here.
    const zzOuterTool: ToolDefinition = {
      name: 'zz_outer_tool',
      description: 'obviously-fake tool the swallowed head names',
      inputSchema: { type: 'object', properties: { fld1: { type: 'object' } } },
    };
    const xml =
      '<function_calls>\n<invoke name="zz_outer_tool">\n' +
      '<invoke name="zz_edit_tool">\n' +
      '<parameter name="fld1">  {"ite1": 1}  </parameter>\n' +
      '</invoke>\n</function_calls>';

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const parsed = parseToolCalls(xml, { tools: [zzOuterTool, zzEditTool] });
      expect(parsed!.calls.map(c => c.name)).toEqual(['zz_edit_tool']);
      expect(parsed!.calls[0]!.input.fld1).toBe('  {"ite1": 1}  ');
      // The outer tool's `object` declaration never applied, so its
      // JSON-kind diagnostic never fired.
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
