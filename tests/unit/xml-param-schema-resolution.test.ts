/**
 * Declared-type resolution for XML-mode parameters (greptile #53, tool-parser.ts:52).
 *
 * The schema-typed parse landed reading `properties[paramName].type` and
 * nothing else, so every OTHER spelling of the same declaration — a
 * `["string","null"]` type array, an `anyOf` of a type and null, a `$ref` into
 * the tool's own definitions, a parameter carried inside a ROOT-level union —
 * looked undeclared and fell back to the legacy guess: trim, then JSON.parse.
 * Whitespace-sensitive and JSON-looking string arguments changed shape on the
 * way to the tool callback, silently.
 *
 * resolveDeclaredType collapses those forms to one type name; a form it cannot
 * collapse keeps the legacy guess but says so ONCE per tool/parameter, which
 * turns a silent divergence into a named bound.
 */

import { describe, it, expect, vi } from 'vitest';
import { parseToolCalls } from '../../src/utils/tool-parser.js';
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

  it('gives up past the depth cap instead of following forever', () => {
    const tool = toolWith('zz_deep_ref_tool', {
      type: 'object',
      properties: { fld1: { $ref: '#/$defs/zz1' } },
      $defs: {
        zz1: { $ref: '#/$defs/zz2' },
        zz2: { $ref: '#/$defs/zz3' },
        zz3: { $ref: '#/$defs/zz4' },
        zz4: { type: 'string' },
      },
    });
    const { result, messages } = captureWarnings(() =>
      parseParam(tool, 'fld1', '  zz-spaced-text  ')
    );
    expect(result).toBe('zz-spaced-text');
    expect(messages).toHaveLength(1);
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

  it('leaves sibling anyOf + oneOf unresolved rather than intersecting them', () => {
    const tool = toolWith('zz_sibling_combinator_tool', {
      type: 'object',
      properties: {
        fld1: { anyOf: [{ type: 'string' }], oneOf: [{ type: 'string' }] },
      },
    });
    const { result, messages } = captureWarnings(() =>
      parseParam(tool, 'fld1', '  zz-spaced-text  ')
    );
    expect(result).toBe('zz-spaced-text');
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

  it('lets root properties win over a variant, then takes the FIRST variant to declare a key', () => {
    const tool = toolWith('zz_root_collision_tool', {
      type: 'object',
      properties: { fld1: { type: 'string' } },
      oneOf: [
        { type: 'object', properties: { fld1: { type: 'object' }, fld2: { type: 'string' } } },
        { type: 'object', properties: { fld2: { type: 'object' } } },
      ],
    });
    expect(parseParam(tool, 'fld1', '  {"ite1": 1}  ')).toBe('  {"ite1": 1}  ');
    expect(parseParam(tool, 'fld2', '  {"ite1": 1}  ')).toBe('  {"ite1": 1}  ');
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
    expect(doc).toContain('<parameter name="fld2" type="integer">');
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
