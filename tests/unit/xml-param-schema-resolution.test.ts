/**
 * Declared-type resolution for XML-mode parameters (greptile #53, tool-parser.ts:52;
 * review of 2026-09-29, findings 1, 2, 3, 5, 6 and 7).
 *
 * The schema-typed parse landed reading `properties[paramName].type` and
 * nothing else, so every OTHER spelling of the same declaration — a
 * `["string","null"]` type array, an `anyOf` of a type and null, a `$ref` into
 * the tool's own definitions, a parameter carried inside a ROOT-level union —
 * looked undeclared and fell back to the legacy guess: trim, then JSON.parse.
 * Whitespace-sensitive and JSON-looking string arguments changed shape on the
 * way to the tool callback, silently.
 *
 * readToolSchema (src/utils/tool-schema.ts) reads every declaration as the set
 * of JSON types it admits: a declaration that admits exactly one type (null
 * aside) is parsed by it; one that admits several, none, or cannot be read
 * keeps the legacy guess but says so ONCE per distinct schema form, which turns
 * a silent divergence into a named bound. Schema shapes are read as data:
 * nothing a producer sends makes reading throw.
 */

import { describe, it, expect, vi } from 'vitest';
import { parseToolCalls, parseAccumulatedIntoBlocks } from '../../src/utils/tool-parser.js';
import { AnthropicXmlFormatter } from '../../src/formatters/anthropic-xml.js';
import type { ToolDefinition, NormalizedMessage } from '../../src/types/index.js';

function toolWith(name: string, inputSchema: ToolDefinition['inputSchema']): ToolDefinition {
  return { name, description: 'obviously-fake schema-form probe', inputSchema };
}

function callXml(toolName: string, paramName: string, value: string): string {
  return (
    `<function_calls>\n<invoke name="${toolName}">\n` +
    `<parameter name="${paramName}">${value}</parameter>\n` +
    '</invoke>\n</function_calls>'
  );
}

function parseParam(tool: ToolDefinition, paramName: string, value: string): unknown {
  const parsed = parseToolCalls(callXml(tool.name, paramName, value), { tools: [tool] });
  expect(parsed).not.toBeNull();
  expect(parsed!.calls).toHaveLength(1);
  return parsed!.calls[0]!.input[paramName];
}

function captureWarnings<T>(body: () => T): { result: T; messages: string[] } {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const result = body();
    return { result, messages: warn.mock.calls.map(call => call.join(' ')) };
  } finally {
    warn.mockRestore();
  }
}

function renderedTools(tool: ToolDefinition): string {
  const formatter = new AnthropicXmlFormatter();
  const messages: NormalizedMessage[] = [
    { participant: 'zz-user', content: [{ type: 'text', text: 'zz-render-request' }] },
    { participant: 'zz-bot', content: [] },
  ];
  const result = formatter.buildMessages(messages, {
    assistantParticipant: 'zz-bot',
    tools: [tool],
  });
  return result.messages
    .map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');
}

describe('type declared as an array', () => {
  it('resolves ["string","null"] to string and keeps the raw, untrimmed text', () => {
    const tool = toolWith('zz_nullable_string_tool', {
      type: 'object',
      properties: { fld1: { type: ['string', 'null'] } },
    });
    expect(parseParam(tool, 'fld1', '  zz-spaced-text  ')).toBe('  zz-spaced-text  ');
  });

  it('resolves ["integer","null"] to integer', () => {
    const tool = toolWith('zz_nullable_integer_tool', {
      type: 'object',
      properties: { fld1: { type: ['integer', 'null'] } },
    });
    expect(parseParam(tool, 'fld1', ' 17 ')).toBe(17);
  });

  it('leaves a two-non-null type array unresolved, warning once and guessing as before', () => {
    const tool = toolWith('zz_ambiguous_array_tool', {
      type: 'object',
      properties: { fld1: { type: ['string', 'number'] } },
    });
    const { result, messages } = captureWarnings(() => parseParam(tool, 'fld1', '  42  '));
    expect(result).toBe(42);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('zz_ambiguous_array_tool');
    expect(messages[0]).toContain('fld1');
    expect(messages[0]).toContain('["string","number"]');
  });
});

describe('$ref into the tool\'s own definitions', () => {
  it('round-trips a #/definitions/X integer parameter typed', () => {
    const tool = toolWith('zz_definitions_ref_tool', {
      type: 'object',
      properties: { fld1: { $ref: '#/definitions/zz1' } },
      definitions: { zz1: { type: 'integer' } },
    });
    expect(parseParam(tool, 'fld1', ' 17 ')).toBe(17);
    const { result, messages } = captureWarnings(() =>
      parseParam(tool, 'fld1', '  zz-not-a-number  ')
    );
    expect(result).toBe('  zz-not-a-number  ');
    expect(messages.join('\n')).toContain('"integer"');
  });

  it('round-trips a #/$defs/X string parameter raw', () => {
    const tool = toolWith('zz_defs_ref_tool', {
      type: 'object',
      properties: { fld1: { $ref: '#/$defs/zz1' } },
      $defs: { zz1: { type: 'string' } },
    });
    expect(parseParam(tool, 'fld1', '  {"ite1": 1}  ')).toBe('  {"ite1": 1}  ');
  });

  it('follows a chain within the depth cap', () => {
    const tool = toolWith('zz_ref_chain_tool', {
      type: 'object',
      properties: { fld1: { $ref: '#/$defs/zz1' } },
      $defs: { zz1: { $ref: '#/$defs/zz2' }, zz2: { type: 'string' } },
    });
    expect(parseParam(tool, 'fld1', '  zz-spaced-text  ')).toBe('  zz-spaced-text  ');
  });

  it('follows a chain of any length: no depth budget to exhaust', () => {
    // A three-hop cap used to be shared with union traversal, so a $ref inside a
    // parameter anyOf inside a root variant ran out of hops and fell back.
    const defs: Record<string, unknown> = {};
    for (let hop = 1; hop < 12; hop++) defs[`zz${hop}`] = { $ref: `#/$defs/zz${hop + 1}` };
    defs.zz12 = { type: 'string' };
    const tool = toolWith('zz_deep_ref_tool', {
      type: 'object',
      oneOf: [
        {
          type: 'object',
          properties: { fld1: { anyOf: [{ $ref: '#/$defs/zz1' }, { type: 'null' }] } },
        },
      ],
      $defs: defs as Record<string, never>,
    });
    const { result, messages } = captureWarnings(() =>
      parseParam(tool, 'fld1', '  zz-spaced-text  ')
    );
    expect(result).toBe('  zz-spaced-text  ');
    expect(messages).toHaveLength(0);
  });

  it('reads a definition shared along many paths once, not once per path', () => {
    // Forty levels of two branches onto the same next definition: 2^40 paths,
    // one definition each. Finishing at all is the assertion.
    const defs: Record<string, unknown> = {};
    for (let level = 0; level < 40; level++) {
      defs[`zz${level}`] = {
        anyOf: [{ $ref: `#/$defs/zz${level + 1}` }, { $ref: `#/$defs/zz${level + 1}` }],
      };
    }
    defs.zz40 = { type: 'string' };
    const tool = toolWith('zz_diamond_ref_tool', {
      type: 'object',
      properties: { fld1: { $ref: '#/$defs/zz0' } },
      $defs: defs as Record<string, never>,
    });
    expect(parseParam(tool, 'fld1', '  zz-spaced-text  ')).toBe('  zz-spaced-text  ');
  });

  it('terminates on a $ref cycle', () => {
    const tool = toolWith('zz_cyclic_ref_tool', {
      type: 'object',
      properties: { fld1: { $ref: '#/$defs/zz1' } },
      $defs: { zz1: { $ref: '#/$defs/zz2' }, zz2: { $ref: '#/$defs/zz1' } },
    });
    const { result, messages } = captureWarnings(() =>
      parseParam(tool, 'fld1', '  zz-spaced-text  ')
    );
    expect(result).toBe('zz-spaced-text');
    expect(messages).toHaveLength(1);
  });

  it('leaves a $ref outside the tool schema unresolved', () => {
    const tool = toolWith('zz_external_ref_tool', {
      type: 'object',
      properties: { fld1: { $ref: 'https://zz-schemas.invalid/zz1.json' } },
    });
    const { result, messages } = captureWarnings(() =>
      parseParam(tool, 'fld1', '  zz-spaced-text  ')
    );
    expect(result).toBe('zz-spaced-text');
    expect(messages).toHaveLength(1);
  });
});

describe('anyOf / oneOf unions', () => {
  it('preserves a raw string through anyOf [string, null], JSON-looking text included', () => {
    const tool = toolWith('zz_anyof_string_tool', {
      type: 'object',
      properties: { fld1: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
    });
    expect(parseParam(tool, 'fld1', '  {"ite1": 1}  ')).toBe('  {"ite1": 1}  ');
  });

  it('resolves oneOf [null, integer] regardless of branch order', () => {
    const tool = toolWith('zz_oneof_integer_tool', {
      type: 'object',
      properties: { fld1: { oneOf: [{ type: 'null' }, { type: 'integer' }] } },
    });
    expect(parseParam(tool, 'fld1', ' 17 ')).toBe(17);
  });

  it('resolves a nested union branch that is itself a $ref', () => {
    const tool = toolWith('zz_anyof_ref_tool', {
      type: 'object',
      properties: { fld1: { anyOf: [{ $ref: '#/definitions/zz1' }, { type: 'null' }] } },
      definitions: { zz1: { type: 'string' } },
    });
    expect(parseParam(tool, 'fld1', '  zz-spaced-text  ')).toBe('  zz-spaced-text  ');
  });

  it('leaves a two-non-null union unresolved, warning EXACTLY once across repeated parses', () => {
    const tool = toolWith('zz_ambiguous_union_tool', {
      type: 'object',
      properties: { fld1: { anyOf: [{ type: 'string' }, { type: 'number' }] } },
    });
    const { result, messages } = captureWarnings(() => {
      const first = parseParam(tool, 'fld1', '  zz-spaced-text  ');
      parseParam(tool, 'fld1', '  zz-spaced-text  ');
      parseParam(tool, 'fld1', ' 17 ');
      return first;
    });
    // Unchanged from the unfixed tip: the legacy guess still trims and parses.
    expect(result).toBe('zz-spaced-text');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('zz_ambiguous_union_tool');
    expect(messages[0]).toContain('anyOf');
  });

  it('intersects sibling anyOf + oneOf, since both must hold', () => {
    const tool = toolWith('zz_sibling_combinator_tool', {
      type: 'object',
      properties: {
        fld1: {
          anyOf: [{ type: 'string' }, { type: 'number' }],
          oneOf: [{ type: 'string' }, { type: 'boolean' }],
        },
      },
    });
    const { result, messages } = captureWarnings(() =>
      parseParam(tool, 'fld1', '  zz-spaced-text  ')
    );
    expect(result).toBe('  zz-spaced-text  ');
    expect(messages).toHaveLength(0);
  });

  it('reads branches of ONE type as that type (literal unions)', () => {
    // zod's union of literals: every branch is a string, so the parameter is.
    const tool = toolWith('zz_literal_union_tool', {
      type: 'object',
      properties: {
        fld1: { anyOf: [{ type: 'string', const: 'zz-a' }, { type: 'string', const: '1' }] },
      },
    });
    const { result, messages } = captureWarnings(() => parseParam(tool, 'fld1', '1'));
    expect(result).toBe('1');
    expect(messages).toHaveLength(0);
    expect(renderedTools(tool)).toContain('<parameter name="fld1" type="string">');
  });

  it('reads an integer branch and a number branch as number', () => {
    const tool = toolWith('zz_numeric_union_tool', {
      type: 'object',
      properties: { fld1: { oneOf: [{ type: 'integer' }, { type: 'number' }] } },
    });
    expect(parseParam(tool, 'fld1', ' 1.5 ')).toBe(1.5);
  });

  it('intersects a parameter-level allOf', () => {
    const tool = toolWith('zz_param_allof_tool', {
      type: 'object',
      properties: {
        fld1: { allOf: [{ type: 'string' }, { minLength: 1 }] },
        fld2: { allOf: [{ type: 'number' }, { type: 'integer' }] },
      },
    });
    expect(parseParam(tool, 'fld1', '  {"ite1": 1}  ')).toBe('  {"ite1": 1}  ');
    const { result, messages } = captureWarnings(() => parseParam(tool, 'fld2', ' 1.5 '));
    expect(result).toBe(1.5);
    expect(messages.join('\n')).toContain('declares type "integer"');
  });
});

describe('nullable declarations', () => {
  // A declaration that admits null lets the model write `null` for it. Main
  // delivered null for these; collapsing ["string","null"] to plain string
  // delivered the four-character text "null" instead.
  const tool = toolWith('zz_nullable_tool', {
    type: 'object',
    properties: {
      fld1: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      fld2: { type: ['string', 'null'] },
      fld3: { anyOf: [{ type: 'object' }, { type: 'null' }] },
      fld4: { type: 'string' },
      fld5: { enum: ['zz-a', 'zz-b', null] },
    },
  });

  it('delivers null for a written null, without a warning', () => {
    const { result, messages } = captureWarnings(() => {
      const parsed = parseToolCalls(
        '<function_calls>\n<invoke name="zz_nullable_tool">\n' +
          '<parameter name="fld1">null</parameter>\n' +
          '<parameter name="fld2">  null  </parameter>\n' +
          '<parameter name="fld3">null</parameter>\n' +
          '<parameter name="fld5">null</parameter>\n' +
          '</invoke>\n</function_calls>',
        { tools: [tool] }
      );
      return parsed!.calls[0]!.input;
    });
    expect(result).toEqual({ fld1: null, fld2: null, fld3: null, fld5: null });
    expect(messages).toHaveLength(0);
  });

  it('keeps every other value by the non-null type', () => {
    expect(parseParam(tool, 'fld1', '  nullish  ')).toBe('  nullish  ');
    expect(parseParam(tool, 'fld2', '"null"')).toBe('"null"');
    expect(parseParam(tool, 'fld3', '{"ite1": 1}')).toEqual({ ite1: 1 });
    expect(parseParam(tool, 'fld5', 'zz-a')).toBe('zz-a');
  });

  it('keeps the text "null" for a string that does NOT admit null', () => {
    expect(parseParam(tool, 'fld4', 'null')).toBe('null');
  });

  it('tells the model which parameters admit null', () => {
    const doc = renderedTools(tool);
    expect(doc).toContain('<parameter name="fld1" type="string" nullable="true">');
    expect(doc).toContain('<parameter name="fld2" type="string" nullable="true">');
    expect(doc).toContain('<parameter name="fld3" type="object" nullable="true">');
    expect(doc).toContain('<parameter name="fld4" type="string">');
  });
});

describe('enum and const without a type', () => {
  it('reads the type of the listed values', () => {
    const tool = toolWith('zz_untyped_enum_tool', {
      type: 'object',
      properties: {
        fld1: { enum: ['1', '2'] } as never,
        fld2: { const: 'zz-fixed' } as never,
        fld3: { enum: [1, 2] } as never,
      },
    });
    const { result, messages } = captureWarnings(() => [
      parseParam(tool, 'fld1', '1'),
      parseParam(tool, 'fld2', 'zz-fixed'),
      parseParam(tool, 'fld3', ' 2 '),
    ]);
    // Main guessed '1' into the number 1, which no value of this enum is.
    expect(result).toEqual(['1', 'zz-fixed', 2]);
    expect(messages).toHaveLength(0);
    const doc = renderedTools(tool);
    expect(doc).toContain('<parameter name="fld1" type="string" enum="1,2">');
    expect(doc).toContain('<parameter name="fld3" type="integer" enum="1,2">');
  });

  it('leaves values of several types unresolved', () => {
    const tool = toolWith('zz_mixed_enum_tool', {
      type: 'object',
      properties: { fld1: { enum: ['zz-a', 1] } as never },
    });
    const { result, messages } = captureWarnings(() => parseParam(tool, 'fld1', ' 1 '));
    expect(result).toBe(1);
    expect(messages).toHaveLength(1);
  });
});

describe('root-level unions', () => {
  it('finds a parameter declared only inside a root oneOf variant', () => {
    const tool = toolWith('zz_root_oneof_tool', {
      type: 'object',
      oneOf: [
        { type: 'object', properties: { fld1: { type: 'string' } }, required: ['fld1'] },
        { type: 'object', properties: { fld2: { type: 'integer' } }, required: ['fld2'] },
      ],
    });
    expect(parseParam(tool, 'fld1', '  zz-spaced-text  ')).toBe('  zz-spaced-text  ');
    expect(parseParam(tool, 'fld2', ' 17 ')).toBe(17);
  });

  it('finds a parameter declared only inside a root anyOf or allOf variant', () => {
    const anyOfTool = toolWith('zz_root_anyof_tool', {
      type: 'object',
      anyOf: [{ type: 'object', properties: { fld1: { type: ['string', 'null'] } } }],
    });
    expect(parseParam(anyOfTool, 'fld1', '  zz-spaced-text  ')).toBe('  zz-spaced-text  ');

    const allOfTool = toolWith('zz_root_allof_tool', {
      type: 'object',
      allOf: [{ type: 'object', properties: { fld1: { $ref: '#/$defs/zz1' } } }],
      $defs: { zz1: { type: 'string' } },
    });
    expect(parseParam(allOfTool, 'fld1', '  zz-spaced-text  ')).toBe('  zz-spaced-text  ');
  });

  it('types a parameter every declaring alternative agrees on', () => {
    const tool = toolWith('zz_root_agreeing_tool', {
      type: 'object',
      oneOf: [
        { type: 'object', properties: { fld1: { const: 'zz-text' }, fld2: { type: 'string' } } },
        { type: 'object', properties: { fld1: { const: 'zz-other' }, fld2: { type: 'string' } } },
      ],
    });
    expect(parseParam(tool, 'fld1', 'zz-other')).toBe('zz-other');
    expect(parseParam(tool, 'fld2', '  {"ite1": 1}  ')).toBe('  {"ite1": 1}  ');
  });

  it('widens to null when one alternative admits it', () => {
    const tool = toolWith('zz_root_nullable_alternative_tool', {
      type: 'object',
      anyOf: [
        { type: 'object', properties: { fld1: { type: 'string' } } },
        { type: 'object', properties: { fld1: { type: ['string', 'null'] } } },
      ],
    });
    expect(parseParam(tool, 'fld1', 'null')).toBeNull();
    expect(parseParam(tool, 'fld1', '  zz-text  ')).toBe('  zz-text  ');
  });

  describe('alternatives that disagree on a parameter', () => {
    // A discriminated union: `kind` selects the alternative, and the two
    // alternatives declare `fld2` with different types. Taking the FIRST
    // alternative's declaration parsed a valid call to the second one by the
    // first one's type. Neither type is safe to apply without choosing the
    // alternative, so the parameter keeps the legacy guess — the values main
    // delivered — and the instructions state no type for it.
    const tool = toolWith('zz_root_disagreeing_tool', {
      type: 'object',
      oneOf: [
        {
          type: 'object',
          properties: { kind: { const: 'zz-text' }, fld2: { type: 'string' } },
          required: ['kind', 'fld2'],
        },
        {
          type: 'object',
          properties: { kind: { const: 'zz-json' }, fld2: { type: 'object' } },
          required: ['kind', 'fld2'],
        },
      ],
    });
    const call = (kind: string, value: string) =>
      parseToolCalls(
        '<function_calls>\n<invoke name="zz_root_disagreeing_tool">\n' +
          `<parameter name="kind">${kind}</parameter>\n` +
          `<parameter name="fld2">${value}</parameter>\n` +
          '</invoke>\n</function_calls>',
        { tools: [tool] }
      )!.calls[0]!.input;

    it('parses a valid call to the SECOND alternative as main did', () => {
      const { result, messages } = captureWarnings(() => call('zz-json', '{"ite1": 1}'));
      expect(result).toEqual({ kind: 'zz-json', fld2: { ite1: 1 } });
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('zz_root_disagreeing_tool');
      expect(messages[0]).toContain('"fld2"');
      expect(messages[0]).toContain('[{"type":"string"},{"type":"object"}]');
    });

    it('parses a valid call to the FIRST alternative as main did', () => {
      const { result } = captureWarnings(() => call('zz-text', '  zz-plain-text  '));
      expect(result).toEqual({ kind: 'zz-text', fld2: 'zz-plain-text' });
    });

    it('states no type for it in the instructions', () => {
      const doc = renderedTools(tool);
      expect(doc).toContain('<parameter name="kind" type="string" required="true">');
      expect(doc).toContain('<parameter name="fld2" required="true">');
    });
  });

  it('leaves a parameter the root and a variant declare differently unresolved', () => {
    const tool = toolWith('zz_root_variant_conflict_tool', {
      type: 'object',
      properties: { fld1: { type: 'string' } },
      allOf: [{ type: 'object', properties: { fld1: { type: 'object' } } }],
    });
    const { result, messages } = captureWarnings(() => parseParam(tool, 'fld1', ' {"ite1": 1} '));
    expect(result).toEqual({ ite1: 1 });
    expect(messages).toHaveLength(1);
  });

  describe('a root union whose variants are not all object schemas', () => {
    // The native wire merges a root union only when every variant is an
    // object schema, and otherwise falls back to a permissive object schema
    // whose properties are the root's own. The XML surfaces read the same
    // union the same way: variant parameters are not read, and saying
    // otherwise (rendering one alternative's parameters as required, say)
    // told the model something the native wire does not.
    const tool = toolWith('zz_root_unmergeable_tool', {
      type: 'object',
      properties: { fld1: { type: 'string' } },
      required: ['fld1'],
      allOf: [
        { type: 'object', properties: { fld2: { type: 'string' } }, required: ['fld2'] },
        { $ref: '#/$defs/zz1' },
      ],
      $defs: { zz1: { type: 'object', properties: { fld3: { type: 'integer' } } } },
    });

    it('renders the root parameters only, as the native wire falls back', () => {
      const doc = renderedTools(tool);
      expect(doc).toContain('<parameter name="fld1" type="string" required="true">');
      expect(doc).not.toContain('name="fld2"');
      expect(doc).not.toContain('name="fld3"');
    });

    it('parses a variant parameter by the legacy guess, naming the unread union once', () => {
      const { result, messages } = captureWarnings(() => [
        parseParam(tool, 'fld2', '  zz-spaced-text  '),
        parseParam(tool, 'fld2', '  zz-spaced-text  '),
      ]);
      expect(result).toEqual(['zz-spaced-text', 'zz-spaced-text']);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('zz_root_unmergeable_tool');
      expect(messages[0]).toContain('"fld2"');
      expect(messages[0]).toContain('allOf');
    });

    it('still types the root parameters', () => {
      expect(parseParam(tool, 'fld1', '  zz-spaced-text  ')).toBe('  zz-spaced-text  ');
    });
  });
});

describe('parameters with no declaration at all', () => {
  it('keeps the legacy guess SILENTLY, so the warn cannot become noise', () => {
    const tool = toolWith('zz_undeclared_param_tool', {
      type: 'object',
      properties: { fld1: { type: 'string' } },
    });
    const { result, messages } = captureWarnings(() => parseParam(tool, 'fld9', '  42  '));
    expect(result).toBe(42);
    expect(messages).toHaveLength(0);
  });

  it('keeps the legacy guess silently for a declaration that admits any value', () => {
    const tool = toolWith('zz_any_param_tool', {
      type: 'object',
      properties: { fld1: { description: 'zz-anything-goes' } },
    });
    const { result, messages } = captureWarnings(() => parseParam(tool, 'fld1', '  42  '));
    expect(result).toBe(42);
    expect(messages).toHaveLength(0);
  });
});

describe('schema shapes are data, never structure', () => {
  // Tool schemas arrive from producers unvalidated, and the parser runs on
  // every model reply: nothing in a schema, and nothing a model names, may
  // make it throw. A parameter named like an Object.prototype member used to
  // resolve to the prototype FUNCTION, whose serialization is undefined; the
  // diagnostic then threw on its length, once per process, aborting the
  // inference that carried the call.
  const agentFrameworkReadTool = toolWith('zz_read_tool', {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  });

  for (const name of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__defineGetter__']) {
    it(`parses a call carrying an undeclared "${name}" parameter, silently, every time`, () => {
      const xml =
        '<function_calls>\n<invoke name="zz_read_tool">\n' +
        '<parameter name="path">zz-file</parameter>\n' +
        `<parameter name="${name}">zz-extra</parameter>\n` +
        '</invoke>\n</function_calls>';
      const { result, messages } = captureWarnings(() => [
        parseToolCalls(xml, { tools: [agentFrameworkReadTool] })!.calls[0]!.input,
        parseAccumulatedIntoBlocks(xml, { tools: [agentFrameworkReadTool] }).toolCalls[0]!.input,
      ]);
      for (const input of result) {
        expect(input.path).toBe('zz-file');
        expect(Object.getOwnPropertyDescriptor(input, name)?.value).toBe('zz-extra');
      }
      expect(messages).toHaveLength(0);
    });
  }

  it('reads a parameter DECLARED with such a name like any other', () => {
    const tool = toolWith(
      'zz_prototype_named_tool',
      JSON.parse(`{
        "type": "object",
        "properties": { "constructor": { "type": "string" } },
        "anyOf": [{ "type": "object", "properties": { "toString": { "type": "integer" } } }]
      }`)
    );
    expect(parseParam(tool, 'constructor', '  zz-spaced-text  ')).toBe('  zz-spaced-text  ');
    expect(parseParam(tool, 'toString', ' 7 ')).toBe(7);
    const doc = renderedTools(tool);
    expect(doc).toContain('<parameter name="constructor" type="string">');
    expect(doc).toContain('<parameter name="toString" type="integer">');
  });

  it('leaves a $ref naming such a member, absent from $defs, unresolved', () => {
    const tool = toolWith('zz_prototype_ref_tool', {
      type: 'object',
      properties: { fld1: { $ref: '#/$defs/constructor' } },
      $defs: {},
    });
    const { result, messages } = captureWarnings(() => parseParam(tool, 'fld1', '  zz-text  '));
    expect(result).toBe('zz-text');
    expect(messages).toHaveLength(1);
  });

  it('survives malformed schema shapes', () => {
    const malformed: unknown[] = [
      { type: 'object', properties: 'zz-not-an-object' },
      { type: 'object', properties: { fld1: null } },
      { type: 'object', properties: { fld1: { anyOf: 'zz-not-an-array' } } },
      { type: 'object', properties: { fld1: { enum: 'zz-not-an-array' } } },
      { type: 'object', properties: { fld1: { type: 7 } } },
      { type: 'object', properties: { fld1: { $ref: 7 } } },
      { type: 'object', oneOf: [null, 'zz-not-a-schema'] },
      { type: 'object', oneOf: 'zz-not-an-array', required: 'fld1' },
      { type: 'object', properties: { fld1: { allOf: [null, { type: 'string' }] } } },
      null,
      'zz-not-a-schema',
    ];
    for (const [index, inputSchema] of malformed.entries()) {
      const tool = { name: `zz_malformed_${index}`, description: 'zz', inputSchema } as ToolDefinition;
      const { result } = captureWarnings(() => parseParam(tool, 'fld1', '  42  '));
      expect(result).toBe(42);
      expect(() => renderedTools(tool)).not.toThrow();
    }
  });
});

describe('unresolved-form diagnostics are deduplicated by schema content', () => {
  // Keyed by tool and parameter NAME alone, the first schema to warn silenced
  // every other: two agents in one host whose servers expose the same tool
  // name with different schemas heard only about the first.
  it('warns once per distinct schema, not once per tool and parameter name', () => {
    const first = toolWith('zz_shared_name_tool', {
      type: 'object',
      properties: { fld1: { anyOf: [{ type: 'string' }, { type: 'number' }] } },
    });
    const second = toolWith('zz_shared_name_tool', {
      type: 'object',
      properties: { fld1: { anyOf: [{ type: 'boolean' }, { type: 'array' }] } },
    });
    const firstAgain = toolWith('zz_shared_name_tool', JSON.parse(JSON.stringify(first.inputSchema)));
    const { messages } = captureWarnings(() => {
      parseParam(first, 'fld1', 'zz-text');
      parseParam(second, 'fld1', 'zz-text');
      parseParam(firstAgain, 'fld1', 'zz-text');
      parseParam(second, 'fld1', 'zz-text');
    });
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain('"string"');
    expect(messages[1]).toContain('"boolean"');
  });
});

describe('schema-mismatch diagnostics name coordinates, never argument content', () => {
  // Tool arguments routinely carry credentials, tokens and private documents,
  // and the mismatch path fires exactly when a model formats such a value
  // oddly. BOTH warn paths of a JSON-shaped declaration are covered here:
  // (a) text that is not valid JSON at all, (b) valid JSON of the wrong kind.
  const zzSecret = 'zz-secret-token-8f3a1c';

  it('omits the value when the text does not parse as JSON', () => {
    const tool = toolWith('zz_mismatch_unparseable_tool', {
      type: 'object',
      properties: { fld1: { type: 'object' } },
    });
    const { result, messages } = captureWarnings(() =>
      parseParam(tool, 'fld1', `{${zzSecret} not json`)
    );
    expect(result).toBe(`{${zzSecret} not json`);
    expect(messages).toHaveLength(1);
    expect(messages.join('\n')).not.toContain(zzSecret);
    expect(messages[0]).toContain('zz_mismatch_unparseable_tool');
    expect(messages[0]).toContain('fld1');
    expect(messages[0]).toContain('object');
    expect(messages[0]).toContain('passing the raw text through');
  });

  it('omits the value when the text parses to a different JSON kind', () => {
    const tool = toolWith('zz_mismatch_wrongkind_tool', {
      type: 'object',
      properties: { fld1: { type: 'object' } },
    });
    const { result, messages } = captureWarnings(() =>
      parseParam(tool, 'fld1', JSON.stringify(zzSecret))
    );
    expect(result).toBe(zzSecret);
    expect(messages).toHaveLength(1);
    expect(messages.join('\n')).not.toContain(zzSecret);
    expect(messages[0]).toContain('zz_mismatch_wrongkind_tool');
    expect(messages[0]).toContain('fld1');
    expect(messages[0]).toContain('object');
    expect(messages[0]).toContain('parsed as string');
  });
});

describe('tool instructions rendered from the same resolution', () => {
  it('states the resolved type for an indirect form instead of type="undefined"', () => {
    const doc = renderedTools(
      toolWith('zz_prompt_ref_tool', {
        type: 'object',
        properties: { fld1: { $ref: '#/$defs/zz1' }, fld2: { type: ['integer', 'null'] } },
        $defs: { zz1: { type: 'string' } },
      })
    );
    expect(doc).toContain('<parameter name="fld1" type="string">');
    expect(doc).toContain('<parameter name="fld2" type="integer" nullable="true">');
    expect(doc).not.toContain('type="undefined"');
  });

  it('omits the type attribute entirely when no type resolves', () => {
    const doc = renderedTools(
      toolWith('zz_prompt_unresolved_tool', {
        type: 'object',
        properties: { fld1: { anyOf: [{ type: 'string' }, { type: 'number' }] } },
      })
    );
    expect(doc).toContain('<parameter name="fld1">');
    expect(doc).not.toContain('type="undefined"');
  });

  it('includes parameters declared only inside a root union', () => {
    const doc = renderedTools(
      toolWith('zz_prompt_root_oneof_tool', {
        type: 'object',
        oneOf: [
          { type: 'object', properties: { fld1: { type: 'string' } }, required: ['fld1'] },
        ],
      })
    );
    // The lone alternative applies to every valid instance, so its required
    // list IS the effective one.
    expect(doc).toContain('<parameter name="fld1" type="string" required="true">');
  });
});

describe('effective requiredness across root combinators', () => {
  it('marks a key required by an allOf branch, alongside root required', () => {
    const doc = renderedTools(
      toolWith('zz_prompt_allof_required_tool', {
        type: 'object',
        properties: { fld1: { type: 'string' } },
        required: ['fld1'],
        allOf: [
          { type: 'object', properties: { fld2: { type: 'integer' } }, required: ['fld2'] },
          { type: 'object', properties: { fld3: { type: 'boolean' } } },
        ],
      })
    );
    expect(doc).toContain('<parameter name="fld1" type="string" required="true">');
    expect(doc).toContain('<parameter name="fld2" type="integer" required="true">');
    expect(doc).toContain('<parameter name="fld3" type="boolean">');
  });

  it('marks a key required by EVERY anyOf alternative', () => {
    const doc = renderedTools(
      toolWith('zz_prompt_anyof_required_tool', {
        type: 'object',
        anyOf: [
          {
            type: 'object',
            properties: { fld1: { type: 'string' }, fld2: { type: 'integer' } },
            required: ['fld1', 'fld2'],
          },
          {
            type: 'object',
            properties: { fld1: { type: 'string' }, fld3: { type: 'boolean' } },
            required: ['fld1'],
          },
        ],
      })
    );
    expect(doc).toContain('<parameter name="fld1" type="string" required="true">');
  });

  it('leaves a key required by only SOME alternatives optional', () => {
    const doc = renderedTools(
      toolWith('zz_prompt_oneof_partial_tool', {
        type: 'object',
        oneOf: [
          {
            type: 'object',
            properties: { fld1: { type: 'string' }, fld2: { type: 'integer' } },
            required: ['fld1', 'fld2'],
          },
          {
            type: 'object',
            properties: { fld1: { type: 'string' }, fld2: { type: 'integer' } },
            required: ['fld1'],
          },
        ],
      })
    );
    expect(doc).toContain('<parameter name="fld1" type="string" required="true">');
    expect(doc).toContain('<parameter name="fld2" type="integer">');
    expect(doc).not.toContain('<parameter name="fld2" type="integer" required="true">');
  });
});
