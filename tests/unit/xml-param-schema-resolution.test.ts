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
import {
  parseToolCalls,
  parseAccumulatedIntoBlocks,
  toolDefinitionForPrompt,
  formatToolDefinitions,
} from '../../src/utils/tool-parser.js';
import { readToolSchema } from '../../src/utils/tool-schema.js';
import { AnthropicXmlFormatter } from '../../src/formatters/anthropic-xml.js';
import type { ToolDefinition, NormalizedMessage } from '../../src/types/index.js';

/** Every tool this file builds with `toolWith`, for the check that the two readings agree. */
const everyToolBuilt: ToolDefinition[] = [];

function toolWith(name: string, inputSchema: ToolDefinition['inputSchema']): ToolDefinition {
  const tool = { name, description: 'obviously-fake schema-form probe', inputSchema };
  everyToolBuilt.push(tool);
  return tool;
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

  it('follows a two-hop reference chain', () => {
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
    // zod's encoding of a union of literals.
    const tool = toolWith('zz_literal_union_tool', {
      type: 'object',
      properties: {
        fld1: { anyOf: [{ type: 'string', const: 'zz-a' }, { type: 'string', const: '1' }] },
      },
    });
    const { result, messages } = captureWarnings(() => parseParam(tool, 'fld1', '1'));
    expect(result).toBe('1');
    expect(messages).toHaveLength(0);
    expect(renderedTools(tool)).toContain('<parameter name="fld1" type="string" enum="zz-a,1">');
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

describe("OpenAPI's nullable: true beside a type (#143)", () => {
  // OpenAPI 3.0 and Gemini's dialect say a parameter may be null with
  // `nullable: true` beside its `type`, where JSON Schema names null in the
  // type itself.
  const tool = toolWith('zz_openapi_nullable_tool', {
    type: 'object',
    properties: {
      fld1: { type: 'string', nullable: true } as never,
      fld2: { type: ['string', 'null'] },
      fld3: { type: 'integer', nullable: true } as never,
      fld4: { type: 'object', nullable: true } as never,
      fld5: { $ref: '#/$defs/zz1' },
      fld6: { type: 'string', nullable: false } as never,
      fld7: { type: 'string', nullable: 'true' } as never,
      fld8: { type: 'string', nullable: true, enum: ['zz-a', 'zz-b'] } as never,
      fld9: { allOf: [{ type: 'string', nullable: true }, { type: 'string' }] } as never,
    },
    $defs: { zz1: { type: 'string', nullable: true } as never },
  });

  it('reads both spellings of a nullable string the same', () => {
    for (const fld of ['fld1', 'fld2']) {
      expect(parseParam(tool, fld, 'null')).toBeNull();
      expect(parseParam(tool, fld, '  {"ite1": 1}  ')).toBe('  {"ite1": 1}  ');
    }
    const doc = renderedTools(tool);
    expect(doc).toContain('<parameter name="fld1" type="string" nullable="true">');
    expect(doc).toContain('<parameter name="fld2" type="string" nullable="true">');
  });

  const writtenNulls = (...flds: string[]) =>
    captureWarnings(() => {
      const parsed = parseToolCalls(
        '<function_calls>\n<invoke name="zz_openapi_nullable_tool">\n' +
          flds.map(fld => `<parameter name="${fld}">\nnull\n</parameter>\n`).join('') +
          '</invoke>\n</function_calls>',
        { tools: [tool] }
      );
      return parsed!.calls[0]!.input;
    });

  it('delivers null, not the text "null", for a string, through a $ref too', () => {
    const { result, messages } = writtenNulls('fld1', 'fld5');
    expect(result).toEqual({ fld1: null, fld5: null });
    expect(messages).toHaveLength(0);
  });

  it('delivers null for an integer or an object without a type-mismatch warning', () => {
    // Main parsed these as JSON, so the null arrived, but each warned that
    // the value wasn't the declared type.
    const { result, messages } = writtenNulls('fld3', 'fld4');
    expect(messages).toEqual([]);
    expect(result).toEqual({ fld3: null, fld4: null });
  });

  it('keeps every other value by the declared type', () => {
    expect(parseParam(tool, 'fld1', '  nullish  ')).toBe('  nullish  ');
    expect(parseParam(tool, 'fld3', ' 17 ')).toBe(17);
    expect(parseParam(tool, 'fld4', '{"ite1": 1}')).toEqual({ ite1: 1 });
    expect(parseParam(tool, 'fld5', '  zz-spaced-text  ')).toBe('  zz-spaced-text  ');
  });

  it('tells the model which parameters admit null, through a $ref too', () => {
    const doc = renderedTools(tool);
    expect(doc).toContain('<parameter name="fld3" type="integer" nullable="true">');
    expect(doc).toContain('<parameter name="fld4" type="object" nullable="true">');
    expect(doc).toContain('<parameter name="fld5" type="string" nullable="true">');
  });

  it('reads only `nullable: true` itself: false, or the text "true", does not admit null', () => {
    expect(parseParam(tool, 'fld6', 'null')).toBe('null');
    expect(parseParam(tool, 'fld7', 'null')).toBe('null');
    const doc = renderedTools(tool);
    expect(doc).toContain('<parameter name="fld6" type="string">');
    expect(doc).toContain('<parameter name="fld7" type="string">');
  });

  it('parses `nullable: true` beside an enum without consulting the enum, but does not mark it (#150)', () => {
    // As for every `type` here, the enum beside it isn't read for what the
    // parameter admits, so the parse delivers null though the enum doesn't
    // list it, as it already did for `{type: ['string', 'null'], enum: [...]}`.
    // The instructions do consult the enum: null is a value this schema
    // doesn't accept, so the model isn't told it may send one.
    expect(parseParam(tool, 'fld8', 'null')).toBeNull();
    expect(renderedTools(tool)).toContain(
      '<parameter name="fld8" type="string" enum="zz-a,zz-b">'
    );
  });

  it('admits null through allOf only when every branch admits it', () => {
    expect(parseParam(tool, 'fld9', 'null')).toBe('null');
    expect(renderedTools(tool)).toContain('<parameter name="fld9" type="string">');
  });

  it('reads `nullable` only beside a type, where OpenAPI 3.0.3 gives it effect', () => {
    // Without a `type`, the declaration is read from its other keywords, as
    // before: here an enum of strings, and OpenAPI's wrapper of a $ref in an
    // allOf, so a written null stays text.
    const untyped = toolWith('zz_nullable_without_type_tool', {
      type: 'object',
      properties: {
        fld1: { nullable: true, enum: ['zz-a', 'zz-b'] } as never,
        fld2: { nullable: true } as never,
        fld3: { nullable: true, allOf: [{ $ref: '#/$defs/zz1' }] } as never,
      },
      $defs: { zz1: { type: 'string' } },
    });
    expect(parseParam(untyped, 'fld1', 'null')).toBe('null');
    expect(parseParam(untyped, 'fld3', 'null')).toBe('null');
    // fld2 constrains nothing, so it keeps the legacy guess: null, as before.
    expect(parseParam(untyped, 'fld2', 'null')).toBeNull();
    const doc = renderedTools(untyped);
    expect(doc).toContain('<parameter name="fld1" type="string" enum="zz-a,zz-b">');
    expect(doc).toContain('<parameter name="fld2">');
    expect(doc).toContain('<parameter name="fld3" type="string">');
  });
});

describe('an enum or const beside a type that admits null (#150)', () => {
  // A type may admit null while the enum or const beside it leaves null out,
  // and the specifications let it decide (OpenAPI 3.0.3 on `nullable`: other
  // constraints "may disallow the use of null as a value"; JSON Schema
  // 2020-12 §6.1.2 on `enum`).
  const tool = toolWith('zz_enum_nullable_tool', {
    type: 'object',
    properties: {
      fld1: { type: ['string', 'null'], enum: ['zz-a', 'zz-b'] } as never,
      fld2: { type: ['string', 'null'], enum: ['zz-a', 'zz-b', null] } as never,
      fld3: { type: 'string', nullable: true, enum: ['zz-a', 'zz-b'] } as never,
      fld4: { type: ['string', 'null'], const: 'zz-a' } as never,
      fld5: { type: ['string', 'null'], const: null } as never,
      fld6: { type: ['integer', 'null'], enum: [1, 2, null] } as never,
      fld7: { $ref: '#/$defs/zz1' },
      fld8: { anyOf: [{ type: ['string', 'null'], enum: ['zz-a', 'zz-b'] }, { type: 'integer' }] } as never,
      fld9: { anyOf: [{ type: 'string', enum: ['zz-a', 'zz-b'] }, { type: 'null' }] } as never,
      fld10: { anyOf: [{ type: ['string', 'null'], enum: ['zz-a', 'zz-b'] }, { type: 'string' }] } as never,
      fld11: { allOf: [{ type: ['string', 'null'], enum: ['zz-a', 'zz-b'] }, { type: ['string', 'null'] }] } as never,
      fld12: { $ref: '#/$defs/zz2' },
      fld13: { type: ['string', 'null'], allOf: [{ enum: ['zz-a', 'zz-b'] }] } as never,
      fld14: { type: ['string', 'null'], $ref: '#/$defs/zz3' } as never,
      fld15: { type: ['string', 'null'], anyOf: [{ enum: ['zz-a'] }, { type: 'null' }] } as never,
      // A type name this reader doesn't know, beside an enum: unresolved, as on
      // main, and the tool's other parameters read as they do without it.
      fld16: { type: ['STRING', 'null'], enum: ['zz-a'] } as never,
    },
    $defs: {
      // An OpenAPI component enum declared nullable, as converted schemas carry it.
      zz1: { type: 'string', nullable: true, enum: ['zz-a', 'zz-b'] } as never,
      zz2: { type: ['string', 'null'], enum: ['zz-a', 'zz-b'] } as never,
      zz3: { enum: ['zz-a', 'zz-b'] },
    },
  });
  // Root alternatives declaring one parameter. A call may fit either of a
  // oneOf's alternatives, and must fit both of an allOf's.
  const rootTool = toolWith('zz_enum_nullable_root_tool', {
    type: 'object',
    oneOf: [
      { properties: { fld1: { type: ['string', 'null'] } } },
      { properties: { fld1: { type: 'string', enum: ['zz-a', 'zz-b'] } } },
    ],
  } as never);
  const rootSplitTool = toolWith('zz_enum_nullable_root_split_tool', {
    type: 'object',
    oneOf: [
      { properties: { fld1: { type: ['string', 'null'], enum: ['zz-a', 'zz-b'] } } },
      { properties: { fld1: { type: 'string' } } },
    ],
  } as never);
  const rootAllOfTool = toolWith('zz_enum_nullable_root_allof_tool', {
    type: 'object',
    allOf: [
      { properties: { fld1: { type: ['string', 'null'] } } },
      { properties: { fld1: { type: 'string', enum: ['zz-a', 'zz-b'] } } },
    ],
  } as never);

  it('does not mark a parameter nullable when its enum leaves null out', () => {
    const doc = renderedTools(tool);
    expect(doc).toContain('<parameter name="fld1" type="string" enum="zz-a,zz-b">');
    expect(doc).not.toContain('name="fld1" type="string" nullable="true"');
  });

  it('marks it nullable when the enum lists null, and prints that member as `null`', () => {
    const doc = renderedTools(tool);
    expect(doc).toContain('<parameter name="fld2" type="string" nullable="true" enum="zz-a,zz-b,null">');
    expect(doc).toContain('<parameter name="fld6" type="integer" nullable="true" enum="1,2,null">');
    expect(doc).not.toContain('enum="zz-a,zz-b,"');
  });

  it("does not mark OpenAPI's `nullable: true` beside an enum without null", () => {
    const doc = renderedTools(tool);
    expect(doc).toContain('<parameter name="fld3" type="string" enum="zz-a,zz-b">');
    expect(doc).not.toContain('name="fld3" type="string" nullable="true"');
  });

  it('consults a sibling const the same way', () => {
    const doc = renderedTools(tool);
    expect(doc).toContain('<parameter name="fld4" type="string" enum="zz-a">');
    expect(doc).toContain('<parameter name="fld5" type="string" nullable="true" enum="null">');
  });

  it('reads an enum behind a $ref the same way', () => {
    const doc = renderedTools(tool);
    expect(doc).toContain('<parameter name="fld7" type="string" enum="zz-a,zz-b">');
    expect(doc).toContain('<parameter name="fld12" type="string" enum="zz-a,zz-b">');
  });

  it('reads an enum in a branch the same way', () => {
    const doc = renderedTools(tool);
    // Neither branch accepts null: the first's enum leaves it out, the second is integer.
    expect(doc).toContain('<parameter name="fld8">');
    expect(doc).toContain('<parameter name="fld10" type="string">');
    expect(doc).toContain('<parameter name="fld11" type="string" enum="zz-a,zz-b">');
  });

  it('reads the keywords beside a type, not only its own enum or const', () => {
    const doc = renderedTools(tool);
    expect(doc).toContain('<parameter name="fld13" type="string" enum="zz-a,zz-b">');
    expect(doc).toContain('<parameter name="fld14" type="string" enum="zz-a,zz-b">');
    expect(doc).toContain('<parameter name="fld15" type="string" nullable="true" enum="zz-a,null">');
  });

  it('keeps the mark where a branch admits null on its own', () => {
    expect(renderedTools(tool)).toContain('<parameter name="fld9" type="string" nullable="true" enum="zz-a,zz-b,null">');
  });

  it('keeps the mark where one root alternative admits null', () => {
    expect(renderedTools(rootTool)).toContain('<parameter name="fld1" type="string" nullable="true">');
  });

  it('withholds it where no root alternative admits null', () => {
    // The second alternative takes any string, so no list holds for every call.
    expect(renderedTools(rootSplitTool)).toContain('<parameter name="fld1" type="string">');
  });

  it('reads root allOf alternatives together, for the mark and the parse', () => {
    expect(renderedTools(rootAllOfTool)).toContain('<parameter name="fld1" type="string" enum="zz-a,zz-b">');
    expect(parseParam(rootAllOfTool, 'fld1', 'null')).toBe('null');
  });

  it('leaves a type name it cannot read beside an enum as it was', () => {
    expect(renderedTools(tool)).toContain('<parameter name="fld16" enum="zz-a">');
  });

  it('keeps the parse as it was behind a $ref, in a branch, beside a type and in a root alternative', () => {
    const { result } = captureWarnings(() => [
      ...['fld7', 'fld8', 'fld9', 'fld10', 'fld11', 'fld12', 'fld13', 'fld14'].map(fld =>
        parseParam(tool, fld, 'null')
      ),
      parseParam(rootTool, 'fld1', 'null'),
      parseParam(rootSplitTool, 'fld1', 'null'),
    ]);
    expect(result).toEqual([null, null, null, null, null, null, null, null, null, null]);
  });

  it('keeps the parse as it was: a written null still follows the type', () => {
    const { result, messages } = captureWarnings(() => [
      parseParam(tool, 'fld1', 'null'),
      parseParam(tool, 'fld2', 'null'),
      parseParam(tool, 'fld3', 'null'),
      parseParam(tool, 'fld4', 'null'),
      parseParam(tool, 'fld5', 'null'),
      parseParam(tool, 'fld6', 'null'),
      parseParam(tool, 'fld1', 'zz-a'),
    ]);
    expect(result).toEqual([null, null, null, null, null, null, 'zz-a']);
    expect(messages).toHaveLength(0);
  });
});

describe('values behind a $ref, in branches and across root alternatives', () => {
  const color = { enum: ['zz-red', 'zz-green'], title: 'Color', type: 'string' };
  const tool = toolWith('zz_values_tool', {
    type: 'object',
    properties: {
      // pydantic v2 (2.14.1): an Enum field, and Optional[Enum] = None.
      fld1: { $ref: '#/$defs/Color' },
      fld2: { anyOf: [{ $ref: '#/$defs/Color' }, { type: 'null' }], default: null } as never,
      // zod 4: z.enum([...]).nullable().
      fld3: { anyOf: [{ type: 'string', enum: ['zz-red', 'zz-green'] }, { type: 'null' }] } as never,
      // OpenAPI 3.0's wrapper; `nullable` without a type adds nothing.
      fld4: { nullable: true, allOf: [{ $ref: '#/$defs/Color' }] } as never,
      fld5: { oneOf: [{ const: 'zz-red', description: 'warm' }, { const: 'zz-green', description: 'cool' }] } as never,
      fld6: { type: 'string', const: 'zz-search' } as never,
      fld7: { anyOf: [{ type: 'string', enum: ['zz-red', 'zz-green'] }, { type: 'integer' }] } as never,
      fld8: { allOf: [{ enum: ['zz-c', 'zz-b', 'zz-a'] }, { enum: ['zz-a', 'zz-c'] }] } as never,
      fld9: { anyOf: [{ enum: ['zz-b', 'zz-a'] }, { enum: ['zz-a', 'zz-c'] }] } as never,
      fld10: { anyOf: [{ type: 'string', enum: ['zz-a', 1] }, { type: 'integer', enum: [2] }] } as never,
      fld11: { $ref: '#/$defs/Loop' },
      fld12: { allOf: [{ enum: ['zz-a'] }, { enum: ['zz-b'] }] } as never,
      fld13: { allOf: [{ type: 'string' }, { enum: ['zz-a', 1] }] } as never,
      fld14: { type: ['ZZ-UNKNOWN', 'null'], enum: ['zz-a', null] } as never,
      fld15: { oneOf: [{ enum: ['zz-a', 'zz-b'] }, { enum: ['zz-b', 'zz-c'] }] } as never,
      fld16: { anyOf: [{ allOf: [{ type: 'integer' }, { enum: [1, 1.5] }] }, { enum: [2.5] }] } as never,
      fld17: { $ref: '#/$defs/CycleA' },
      fld18: { $ref: '#/$defs/CycleB' },
      fld19: { enum: ['zz-a', 'zz-b'], $ref: '#/$defs/Missing' } as never,
      fld20: { enum: 'zz-a' } as never,
      fld21: { enum: [{ zz: 1 }, 'zz-a'] } as never,
      fld22: { const: { toString: 1 } } as never,
      fld23: { anyOf: [false, { enum: ['zz-a'] }] } as never,
      fld24: { enum: ['zz-a', 'zz-b'], const: 'zz-b' } as never,
      fld25: { enum: ['zz-a'], const: 'zz-b' } as never,
      fld26: { type: 'null' },
    },
    $defs: {
      Color: color,
      Loop: { anyOf: [{ enum: ['zz-a'] }, { $ref: '#/$defs/Loop' }] },
      CycleA: { allOf: [{ enum: ['zz-x', 'zz-y'] }, { $ref: '#/$defs/CycleB' }] },
      CycleB: { allOf: [{ enum: ['zz-y', 'zz-z'] }, { $ref: '#/$defs/CycleA' }] },
    } as never,
  });
  const more = toolWith('zz_values_more_tool', {
    type: 'object',
    properties: {
      fld1: { oneOf: [{ type: 'null', allOf: [{ type: 'string' }] }, { enum: ['zz-a', null] }] } as never,
      fld2: { enum: ['zz-a', 'zz-b'], allOf: [true] } as never,
      fld3: { enum: ['zz-a'], anyOf: 'zz-x' } as never,
      fld4: { enum: ['zz-a'], $ref: 7 } as never,
      fld5: { enum: ['zz-a'], allOf: 'zz-x' } as never,
      fld6: { enum: ['zz-a', 'zz-a', 'zz-b'] } as never,
      fld7: { oneOf: [{ enum: ['zz-a', 'zz-a'] }, { enum: ['zz-b'] }] } as never,
      fld8: { enum: ['zz-a'], anyOf: [{ const: 'zz-a' }, { $ref: '#/$defs/Missing' }] } as never,
      fld9: { enum: ['zz-a'], oneOf: [{ type: 'string' }, { type: 'integer' }] } as never,
      fld10: { anyOf: [{ type: 'string', enum: ['zz-a', 1], allOf: [{ type: 'ZZ-UNKNOWN' }] }, { const: 2 }] } as never,
      fld11: { enum: [true, false] } as never,
      fld12: { const: false } as never,
      fld13: {
        oneOf: [
          { enum: ['zz-a', null], allOf: [{ type: ['string', 'null'], allOf: [{ type: 'string' }] }] },
          { enum: ['zz-b', null] },
        ],
      } as never,
    },
  });
  // The same cycle, read from its other end first.
  const cycleFromB = toolWith('zz_values_cycle_tool', {
    type: 'object',
    properties: { fld18: { $ref: '#/$defs/CycleB' }, fld17: { $ref: '#/$defs/CycleA' } },
    $defs: {
      CycleA: { allOf: [{ enum: ['zz-x', 'zz-y'] }, { $ref: '#/$defs/CycleB' }] },
      CycleB: { allOf: [{ enum: ['zz-y', 'zz-z'] }, { $ref: '#/$defs/CycleA' }] },
    } as never,
  });
  // A call names its alternative by `kind`, so a value two alternatives share
  // is valid in each.
  const rootTool = toolWith('zz_values_root_tool', {
    type: 'object',
    oneOf: [
      { properties: { kind: { const: 'zz-x' }, fld1: { enum: ['zz-a', 'zz-b'] } }, required: ['kind'] },
      { properties: { kind: { const: 'zz-y' }, fld1: { enum: ['zz-b', 'zz-c'] } }, required: ['kind'] },
    ],
  } as never);
  // The root's list, narrowed by an allOf alternative; and a root type that
  // keeps two of an alternative's three kinds.
  const rootAllOfTool = toolWith('zz_values_root_allof_tool', {
    type: 'object',
    properties: { fld1: { enum: ['zz-a', 'zz-b', 'zz-c'] }, fld2: { type: ['string', 'integer'] } },
    allOf: [{ properties: { fld1: { enum: ['zz-a', 'zz-b'] }, fld2: { enum: ['zz-a', 1, true] } } }],
  } as never);

  it('lists the values of an enum behind a $ref, as pydantic writes an Enum field', () => {
    expect(renderedTools(tool)).toContain('<parameter name="fld1" type="string" enum="zz-red,zz-green">');
  });

  it('lists them with null for a nullable enum, as pydantic and zod write it', () => {
    const doc = renderedTools(tool);
    expect(doc).toContain('<parameter name="fld2" type="string" nullable="true" enum="zz-red,zz-green,null">');
    expect(doc).toContain('<parameter name="fld3" type="string" nullable="true" enum="zz-red,zz-green,null">');
  });

  it('lists them through an allOf wrapper', () => {
    expect(renderedTools(tool)).toContain('<parameter name="fld4" type="string" enum="zz-red,zz-green">');
  });

  it('lists a const as its one value, and alternatives of consts as theirs', () => {
    const doc = renderedTools(tool);
    expect(doc).toContain('<parameter name="fld5" type="string" enum="zz-red,zz-green">');
    expect(doc).toContain('<parameter name="fld6" type="string" enum="zz-search">');
  });

  it('lists nothing when a branch has no list of its own, or when a $ref cycles', () => {
    const doc = renderedTools(tool);
    expect(doc).toContain('<parameter name="fld7">');
    expect(doc).toContain('<parameter name="fld11">');
  });

  it('keeps schema order, each value where it first appears', () => {
    const doc = renderedTools(tool);
    expect(doc).toContain('<parameter name="fld8" type="string" enum="zz-c,zz-a">');
    expect(doc).toContain('<parameter name="fld9" type="string" enum="zz-b,zz-a,zz-c">');
  });

  it("keeps only the values of kinds each node's type admits", () => {
    expect(renderedTools(tool)).toContain('<parameter name="fld10" enum="zz-a,2">');
  });

  it('keeps only the values of kinds the parameter admits, and null only where it is marked', () => {
    const doc = renderedTools(tool);
    // The first allOf branch takes strings only, so 1 can't be sent.
    expect(doc).toContain('<parameter name="fld13" type="string" enum="zz-a">');
    // A type name this reader can't read gives no null mark, so null isn't listed.
    expect(doc).toContain('<parameter name="fld14" enum="zz-a">');
  });

  it('renders no enum when no value is in every list', () => {
    expect(renderedTools(tool)).toContain('<parameter name="fld12" type="string">');
  });

  it("lists every root alternative's values", () => {
    expect(renderedTools(rootTool)).toContain('<parameter name="fld1" type="string" enum="zz-a,zz-b,zz-c">');
  });

  it('narrows the root list by an allOf alternative, and keeps only the kinds the root admits', () => {
    const doc = renderedTools(rootAllOfTool);
    expect(doc).toContain('<parameter name="fld1" type="string" enum="zz-a,zz-b">');
    expect(doc).toContain('<parameter name="fld2" enum="zz-a,1">');
  });

  it('lists for a nested oneOf only the values exactly one branch admits', () => {
    expect(renderedTools(tool)).toContain('<parameter name="fld15" type="string" enum="zz-a,zz-c">');
  });

  it('keeps only the values of kinds every keyword of a branch admits', () => {
    // The allOf branch takes integers only, so 1.5 can't be sent through it.
    expect(renderedTools(tool)).toContain('<parameter name="fld16" type="number" enum="1,2.5">');
  });

  it('lists nothing through a cycle, from either end', () => {
    const doc = renderedTools(tool);
    expect(doc).toContain('<parameter name="fld17">');
    expect(doc).toContain('<parameter name="fld18">');
    const fromB = renderedTools(cycleFromB);
    expect(fromB).toContain('<parameter name="fld17">');
    expect(fromB).toContain('<parameter name="fld18">');
  });

  it("lists nothing where a $ref doesn't resolve, an enum isn't a list, or a listed or const value isn't a scalar", () => {
    const doc = renderedTools(tool);
    expect(doc).toContain('<parameter name="fld19">');
    expect(doc).toContain('<parameter name="fld20">');
    expect(doc).toContain('<parameter name="fld21">');
    expect(doc).toContain('<parameter name="fld22" type="object">');
  });

  it('reads a false branch as admitting nothing', () => {
    expect(renderedTools(tool)).toContain('<parameter name="fld23" type="string" enum="zz-a">');
  });

  it("intersects an enum with a const beside it", () => {
    const doc = renderedTools(tool);
    expect(doc).toContain('<parameter name="fld24" type="string" enum="zz-b">');
    expect(doc).toContain('<parameter name="fld25" type="string">');
  });

  it('lists nothing for a parameter whose type is null', () => {
    expect(renderedTools(tool)).toContain('<parameter name="fld26" type="null">');
  });

  it("reads a null-only branch's other keywords before a oneOf counts it", () => {
    // The first branch admits nothing, so null is in exactly one branch.
    expect(renderedTools(more)).toContain('<parameter name="fld1" type="string" nullable="true" enum="zz-a,null">');
  });

  it('leaves a list as it is beside a true schema', () => {
    expect(renderedTools(more)).toContain('<parameter name="fld2" type="string" enum="zz-a,zz-b">');
  });

  it('lists nothing beside a combinator or a $ref of the wrong shape', () => {
    const doc = renderedTools(more);
    expect(doc).toContain('<parameter name="fld3">');
    expect(doc).toContain('<parameter name="fld4">');
    expect(doc).toContain('<parameter name="fld5">');
  });

  it('keeps a value repeated in one enum once, also where a oneOf counts it', () => {
    const doc = renderedTools(more);
    expect(doc).toContain('<parameter name="fld6" type="string" enum="zz-a,zz-b">');
    expect(doc).toContain('<parameter name="fld7" type="string" enum="zz-a,zz-b">');
  });

  it("tells a union that can't be read from one that names no list", () => {
    const doc = renderedTools(more);
    expect(doc).toContain('<parameter name="fld8">');
    expect(doc).toContain('<parameter name="fld9" type="string" enum="zz-a">');
  });

  it("keeps a known type's filter beside a type name it can't read", () => {
    expect(renderedTools(more)).toContain('<parameter name="fld10" enum="zz-a,2">');
  });

  it('lists boolean values', () => {
    const doc = renderedTools(more);
    expect(doc).toContain('<parameter name="fld11" type="boolean" enum="true,false">');
    expect(doc).toContain('<parameter name="fld12" type="boolean" enum="false">');
  });

  it("hands toolDefinitionForPrompt's enum over as strings, as its type says", () => {
    const { parameters } = toolDefinitionForPrompt(more);
    expect(parameters.fld11!.enum).toEqual(['true', 'false']);
    expect(parameters.fld1!.enum).toEqual(['zz-a', 'null']);
  });

  it("reads the kinds of a branch's keywords as the instructions do", () => {
    // The nested type excludes null for the instructions, so only the second
    // branch admits it.
    expect(renderedTools(more)).toContain('<parameter name="fld13" type="string" nullable="true" enum="zz-a,zz-b,null">');
  });

  it('keeps each value once through unions of a shared list', () => {
    // Sixteen levels of two branches onto the same next definition, ending in
    // an enum: a union that kept duplicates would double the list per level.
    const defs: Record<string, unknown> = {};
    for (let level = 0; level < 16; level++) {
      defs[`zz${level}`] = {
        anyOf: [{ $ref: `#/$defs/zz${level + 1}` }, { $ref: `#/$defs/zz${level + 1}` }],
      };
    }
    defs.zz16 = { enum: ['zz-a', 'zz-b'] };
    const diamond = toolWith('zz_values_diamond_tool', {
      type: 'object',
      properties: { fld1: { $ref: '#/$defs/zz0' } },
      $defs: defs as Record<string, never>,
    });
    expect(renderedTools(diamond)).toContain('<parameter name="fld1" type="string" enum="zz-a,zz-b">');
  });

  // Spreading 300,000 values into `push` throws RangeError past about 125,000 arguments on Node 24.
  it('reads a very long enum whole', () => {
    const long = Array.from({ length: 300000 }, (_, index) => `zz-${index}`);
    const reading = readToolSchema({
      type: 'object',
      properties: { fld1: { anyOf: [{ enum: long }, { enum: ['zz-last'] }] } },
    });
    expect(reading.failure).toBeUndefined();
    expect(reading.parameters.get('fld1')?.enum).toHaveLength(300001);
  }, 30_000);

  it('leaves the parse as it was', () => {
    const { result, messages } = captureWarnings(() => [
      parseParam(tool, 'fld1', 'zz-red'),
      parseParam(tool, 'fld2', 'null'),
      parseParam(tool, 'fld3', 'null'),
      parseParam(tool, 'fld6', 'zz-search'),
    ]);
    expect(result).toEqual(['zz-red', null, null, 'zz-search']);
    expect(messages).toHaveLength(0);
  });
});

describe('null beside several types, and declarations membrane cannot type (#143)', () => {
  // Gemini names its types in upper case (`STRING`).
  const tool = toolWith('zz_unresolved_nullable_tool', {
    type: 'object',
    properties: {
      fld1: { type: ['STRING', 'null'] } as never,
      fld2: { type: 'STRING', nullable: true } as never,
      fld3: { type: ['string', 'number', 'null'] } as never,
      fld4: { anyOf: [{ type: 'STRING' }, { type: 'null' }] } as never,
      fld5: { anyOf: [{ type: 'string', nullable: true }, { type: 'number' }] } as never,
      fld6: { type: 'STRING' } as never,
      fld7: { allOf: [{ type: 'STRING' }, { type: ['string', 'null'] }] } as never,
      fld8: { type: ['string', 'number'], nullable: true } as never,
    },
  });

  it('tells the model null is admitted where it can read every type named', () => {
    const doc = renderedTools(tool);
    expect(doc).toContain('<parameter name="fld3" nullable="true">');
    expect(doc).toContain('<parameter name="fld5" nullable="true">');
    expect(doc).toContain('<parameter name="fld8" nullable="true">');
  });

  it('leaves a declaration it cannot read as it was, with no type and no mark', () => {
    const doc = renderedTools(tool);
    for (const fld of ['fld1', 'fld2', 'fld4', 'fld6', 'fld7']) {
      expect(doc).toContain(`<parameter name="${fld}">`);
    }
  });

  it('keeps the legacy guess for them, which reads a written null as null', () => {
    const { result } = captureWarnings(() =>
      ['fld1', 'fld2', 'fld3', 'fld4', 'fld5', 'fld8'].map(fld => parseParam(tool, fld, 'null'))
    );
    expect(result).toEqual([null, null, null, null, null, null]);
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
      expect(doc).toContain('<parameter name="kind" type="string" required="true" enum="zz-text,zz-json">');
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

/** Whether a value is of a JSON Schema type name. */
function isOfType(value: unknown, type: string): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return Number.isInteger(value);
    case 'number':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'null':
      return value === null;
    default:
      return false;
  }
}

describe("enum values the attribute can't show exactly (#176)", () => {
  // Each list puts the value it can't show second, so the check has to read
  // every value.
  const unshowableSecond: Record<string, string[]> = {
    fld1: ['zz-a', 'say "hi"'],
    fld2: ['zz-a', 'x,y'],
    fld3: ['zz-a', 'line1\nline2'],
    fld4: ['zz-a', 'line1\rline2'],
    fld5: ['zz-a', 'zz\tb'],
    fld6: ['zz-a', 'zz-b\u0085'],
    fld7: ['zz-a', 'line1\u2028line2'],
    fld8: ['zz-a', 'line1\u2029line2'],
    fld9: ['zz-a', 'zz-\uD800'],
    fld10: ['zz-a', ''],
    fld11: ['zz-a', ' zz-padded'],
    fld12: ['zz-a', 'zz-padded '],
  };
  const tool = toolWith('zz_exact_tool', {
    type: 'object',
    properties: {
      ...Object.fromEntries(
        Object.entries(unshowableSecond).map(([name, values]) => [name, { type: 'string', enum: values }])
      ),
      fld1: { type: 'string', enum: unshowableSecond.fld1, description: 'zz-quote-description' },
      fld13: { type: 'string', enum: ['R&D', "it's", 'a<b', 'a>b'] },
      fld14: { type: 'string', enum: ['read only', 'read write'] },
      fld15: { type: 'string', enum: ['zz-red', 'zz-green'] },
    },
  } as never);

  it('lists nothing where a value holds a quote, a comma, a control character, a separator or a lone surrogate', () => {
    const doc = renderedTools(tool);
    for (const name of ['fld1', 'fld2', 'fld3', 'fld4', 'fld5', 'fld6', 'fld7', 'fld8', 'fld9']) {
      expect(doc).toContain(`<parameter name="${name}" type="string">`);
    }
  });

  it('lists nothing where a value is empty or has whitespace at either end', () => {
    const doc = renderedTools(tool);
    for (const name of ['fld10', 'fld11', 'fld12']) {
      expect(doc).toContain(`<parameter name="${name}" type="string">`);
    }
  });

  it('keeps the type and the description of a parameter it lists nothing for', () => {
    expect(renderedTools(tool)).toContain('<parameter name="fld1" type="string">\nzz-quote-description\n</parameter>');
  });

  it('prints every other list raw, as the model should write its values', () => {
    // The parser keeps an entity the model copies, so `&amp;` here would be
    // sent as `&amp;`.
    const doc = renderedTools(tool);
    expect(doc).toContain(`<parameter name="fld13" type="string" enum="R&D,it's,a<b,a>b">`);
    expect(doc).toContain('<parameter name="fld14" type="string" enum="read only,read write">');
    expect(doc).toContain('<parameter name="fld15" type="string" enum="zz-red,zz-green">');
  });

  it('prints a hand-built list of other kinds by String, and no empty list', () => {
    const doc = formatToolDefinitions([
      {
        name: 'zz_hand_tool',
        description: 'zz',
        parameters: {
          fld1: { enum: [1, null] as unknown as string[] },
          fld2: { type: 'string', enum: [] },
        },
      },
    ]);
    expect(doc).toContain('<parameter name="fld1" enum="1,null">');
    expect(doc).toContain('<parameter name="fld2" type="string">');
  });

  it('keeps an entity the model writes in a string value', () => {
    expect(parseParam(tool, 'fld13', 'R&amp;D')).toBe('R&amp;D');
  });

  it('still hands toolDefinitionForPrompt every value', () => {
    const { parameters } = toolDefinitionForPrompt(tool);
    for (const [name, values] of Object.entries(unshowableSecond)) {
      expect(parameters[name]!.enum, name).toEqual(values);
    }
  });
});

describe("the instructions' values and the kinds reading agree, over every tool built above (keep it last)", () => {
  // Runs last, over every tool `toolWith` builds, so the values the line lists
  // can't drift from what its type and nullable mark say. A parameter of
  // several kinds renders no type, so its kinds aren't checked here; its own
  // tests pin its list.
  it("lists only values of a parameter's type, and null only where it's marked nullable", () => {
    let lists = 0;
    for (const tool of everyToolBuilt) {
      for (const [name, declaration] of readToolSchema(tool.inputSchema).parameters) {
        if (declaration.enum === undefined) continue;
        lists += 1;
        for (const value of declaration.enum as unknown[]) {
          const where = `${tool.name}.${name}: ${JSON.stringify(value)}`;
          if (value === null) {
            expect(declaration.instructedNullable, where).toBe(true);
          } else if (declaration.type !== undefined) {
            expect(isOfType(value, declaration.type), where).toBe(true);
          }
        }
      }
    }
    expect(lists).toBeGreaterThan(20);
  });
});
