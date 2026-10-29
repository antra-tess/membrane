/**
 * Anthropic refuses sampling parameters for the models NO_TEMPERATURE_MODELS
 * lists, some of which take only a top_p near 1; Haiku 4.5 accepts
 * temperature. Root-level oneOf/anyOf/allOf in a tool's input schema is legal
 * MCP and illegal for Anthropic tools.
 */

import { describe, it, expect } from 'vitest';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { Membrane } from '../../src/membrane.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { flattenRootSchemaUnion } from '../../src/providers/anthropic-tool-schema.js';

function captureAdapter() {
  const adapter = new AnthropicAdapter({ apiKey: 'sk-test' });
  const captured: any[] = [];
  (adapter as any).client = {
    messages: {
      create: async (req: any) => {
        captured.push(req);
        return {
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          model: req.model,
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    },
  };
  return { adapter, captured };
}

const baseRequest = {
  messages: [{ role: 'user', content: 'hi' } as any],
  maxTokens: 64,
};

describe('AnthropicAdapter: sampling-parameter model gate', () => {
  it('strips temperature for a model in the reject-list (claude-opus-4-8)', async () => {
    const { adapter, captured } = captureAdapter();

    await adapter.complete({
      ...baseRequest,
      model: 'claude-opus-4-8',
      temperature: 0.7,
    } as any);

    expect(captured).toHaveLength(1);
    expect(captured[0]).not.toHaveProperty('temperature');
  });

  it('FORWARDS temperature for claude-haiku-4-5 (it is NOT a reject-list model)', async () => {
    const { adapter, captured } = captureAdapter();

    await adapter.complete({
      ...baseRequest,
      model: 'claude-haiku-4-5',
      temperature: 0.7,
    } as any);

    expect(captured[0].temperature).toBe(0.7);

    await adapter.complete({
      ...baseRequest,
      model: 'claude-haiku-4-5-20251001',
      temperature: 0.4,
    } as any);

    expect(captured[1].temperature).toBe(0.4);
  });

  it('strips temperature for dated snapshots of reject-list models', async () => {
    const { adapter, captured } = captureAdapter();

    await adapter.complete({
      ...baseRequest,
      model: 'claude-opus-4-8-20251001',
      temperature: 0.7,
    } as any);

    expect(captured[0]).not.toHaveProperty('temperature');
  });

  it('strips top_p and top_k too for reject-list models', async () => {
    const { adapter, captured } = captureAdapter();

    await adapter.complete({
      ...baseRequest,
      model: 'claude-opus-4-8',
      topP: 0.9,
      topK: 40,
    } as any);

    expect(captured[0]).not.toHaveProperty('top_p');
    expect(captured[0]).not.toHaveProperty('top_k');
  });

  it('passes temperature through for models that still accept it', async () => {
    const { adapter, captured } = captureAdapter();

    await adapter.complete({
      ...baseRequest,
      model: 'claude-sonnet-4-5',
      temperature: 0.7,
    } as any);

    expect(captured[0].temperature).toBe(0.7);
  });

  it('does not confuse claude-sonnet-4-5 with the claude-sonnet-5 entry', async () => {
    const { adapter, captured } = captureAdapter();

    await adapter.complete({
      ...baseRequest,
      model: 'claude-sonnet-5',
      temperature: 0.7,
    } as any);
    await adapter.complete({
      ...baseRequest,
      model: 'claude-sonnet-4-5-20250929',
      temperature: 0.7,
    } as any);

    expect(captured[0]).not.toHaveProperty('temperature');
    expect(captured[1].temperature).toBe(0.7);
  });

  it('strips temperature, top_p and top_k for claude-haiku-5-5, each on its own', async () => {
    // With no thinking config, the API refuses temperature, top_k and top_p for
    // Haiku 5.5 with a 400 ("`temperature` is deprecated for this model", and
    // likewise for the other two), and accepts a top_p of 0.99.
    const { adapter, captured } = captureAdapter();

    await adapter.complete({ ...baseRequest, model: 'claude-haiku-5-5', temperature: 0.2 } as any);
    await adapter.complete({ ...baseRequest, model: 'claude-haiku-5-5', topP: 0.9 } as any);
    await adapter.complete({ ...baseRequest, model: 'claude-haiku-5-5', topK: 40 } as any);
    await adapter.complete({ ...baseRequest, model: 'claude-haiku-5-5', topP: 0.99 } as any);
    await adapter.complete({ ...baseRequest, model: 'claude-haiku-5-5', extra: { top_p: 0.99 } } as any);

    expect(captured[0]).not.toHaveProperty('temperature');
    expect(captured[1]).not.toHaveProperty('top_p');
    expect(captured[2]).not.toHaveProperty('top_k');
    expect(captured[3]).not.toHaveProperty('top_p');
    expect(captured[4]).not.toHaveProperty('top_p');
  });

  it('strips temperature, top_p and top_k for claude-opus-5 and claude-opus-5-5, each on its own', async () => {
    // With no thinking config, the API refuses temperature, top_k and top_p for
    // both with a 400 ("`temperature` is deprecated for this model", and
    // likewise for the other two), and accepts a top_p of 0.99.
    const { adapter, captured } = captureAdapter();
    const thinking = { type: 'adaptive', display: 'omitted' };

    for (const model of ['claude-opus-5', 'claude-opus-5-5', 'claude-opus-5-5-20260301']) {
      await adapter.complete({ ...baseRequest, model, temperature: 0.2 } as any);
      await adapter.complete({ ...baseRequest, model, topP: 0.9 } as any);
      await adapter.complete({ ...baseRequest, model, topK: 40 } as any);
      await adapter.complete({ ...baseRequest, model, topP: 0.99 } as any);
      await adapter.complete({ ...baseRequest, model, extra: { top_p: 0.99 } } as any);
      await adapter.complete({ ...baseRequest, model, topP: 0.97, thinking } as any);
    }

    expect(captured).toHaveLength(18);
    for (let i = 0; i < 18; i += 6) {
      expect(captured[i]).not.toHaveProperty('temperature');
      expect(captured[i + 1]).not.toHaveProperty('top_p');
      expect(captured[i + 2]).not.toHaveProperty('top_k');
      expect(captured[i + 3]).not.toHaveProperty('top_p');
      expect(captured[i + 4]).not.toHaveProperty('top_p');
      expect(captured[i + 5]).not.toHaveProperty('top_p');
      expect(captured[i + 5].thinking).toEqual(thinking);
    }
  });

  it('strips sampling for each listed id and its dated snapshots, and sends it as given to an unlisted later version', async () => {
    const listed = [
      'claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5', 'claude-opus-5-5', 'claude-sonnet-5',
      'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5', 'claude-fable-5-1', 'claude-mythos-5',
      'claude-mythos-5-1', 'claude-mythos-preview',
    ];
    const unlisted = ['claude-opus-5-6', 'claude-opus-5-50', 'claude-sonnet-5-6', 'claude-fable-5-2', 'claude-fable-5-10', 'claude-mythos-5-2', 'claude-haiku-5-6'];
    const { adapter, captured } = captureAdapter();

    for (const model of [...listed, ...listed.map((id) => `${id}-20260301`), ...unlisted]) {
      await adapter.complete({ ...baseRequest, model, temperature: 0.2 } as any);
    }

    const sent = captured.map((request: any) => [request.model, request.temperature]);
    expect(sent).toEqual([
      ...listed.map((id) => [id, undefined]),
      ...listed.map((id) => [`${id}-20260301`, undefined]),
      ...unlisted.map((id) => [id, 0.2]),
    ]);
  });

  it('through Membrane: Fable and Mythos ids lose config sampling by family, the list decides providerParams', async () => {
    const { adapter, captured } = captureAdapter();
    const membrane = new Membrane(adapter, { formatter: new NativeFormatter() });
    const send = (model: string, sampling: { temperature?: number; providerParams?: Record<string, unknown> }) =>
      membrane.complete({
        messages: [{ participant: 'User', content: [{ type: 'text', text: 'hi' }] }],
        config: { model, maxTokens: 64, ...(sampling.temperature !== undefined ? { temperature: sampling.temperature } : {}) },
        ...(sampling.providerParams ? { providerParams: sampling.providerParams } : {}),
      } as any);

    await send('claude-mythos-5-2', { temperature: 0.2 });
    await send('claude-mythos-5-2', { providerParams: { temperature: 0.2 } });
    await send('claude-mythos-5-1', { temperature: 0.2 });
    await send('claude-mythos-5-1', { providerParams: { temperature: 0.2 } });
    await send('claude-fable-5-1', { providerParams: { temperature: 0.2 } });
    await send('claude-opus-5-6', { temperature: 0.2 });
    await send('claude-opus-5-5', { temperature: 0.2 });

    expect(captured.map((request: any) => [request.model, request.temperature])).toEqual([
      ['claude-mythos-5-2', undefined],
      ['claude-mythos-5-2', 0.2],
      ['claude-mythos-5-1', undefined],
      ['claude-mythos-5-1', undefined],
      ['claude-fable-5-1', undefined],
      ['claude-opus-5-6', 0.2],
      ['claude-opus-5-5', undefined],
    ]);
  });

  it('strips temperature/top_k when extended thinking is enabled (any model)', async () => {
    const { adapter, captured } = captureAdapter();

    await adapter.complete({
      ...baseRequest,
      model: 'claude-sonnet-4-5',
      temperature: 0.7,
      topK: 40,
      thinking: { type: 'enabled', budget_tokens: 2048 },
    } as any);

    expect(captured[0]).not.toHaveProperty('temperature');
    expect(captured[0]).not.toHaveProperty('top_k');
    expect(captured[0].thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
  });

  it('strips temperature, top_k and a top_p below 0.95 for an adaptive config too', async () => {
    const { adapter, captured } = captureAdapter();
    const thinking = { type: 'adaptive', display: 'omitted', block_binding: { prefix_mismatch_behavior: 'drop_block' } };

    await adapter.complete({
      ...baseRequest,
      model: 'claude-sonnet-4-5',
      temperature: 0.7,
      topK: 40,
      topP: 0.9,
      thinking,
    } as any);

    expect(captured[0]).not.toHaveProperty('temperature');
    expect(captured[0]).not.toHaveProperty('top_k');
    expect(captured[0]).not.toHaveProperty('top_p');
    expect(captured[0].thinking).toEqual(thinking);
  });

  it('keeps temperature when thinking is explicitly disabled', async () => {
    const { adapter, captured } = captureAdapter();

    await adapter.complete({
      ...baseRequest,
      model: 'claude-sonnet-4-5',
      temperature: 0.7,
      thinking: { type: 'disabled' },
    } as any);

    expect(captured[0].temperature).toBe(0.7);
  });

  it('strips out-of-range top_p when thinking is on but keeps [0.95, 1]', async () => {
    const { adapter, captured } = captureAdapter();

    await adapter.complete({
      ...baseRequest,
      model: 'claude-sonnet-4-5',
      topP: 0.9,
      thinking: { type: 'enabled', budget_tokens: 2048 },
    } as any);
    await adapter.complete({
      ...baseRequest,
      model: 'claude-sonnet-4-5',
      topP: 0.97,
      thinking: { type: 'enabled', budget_tokens: 2048 },
    } as any);

    expect(captured[0]).not.toHaveProperty('top_p');
    expect(captured[1].top_p).toBe(0.97);
  });

  it('drops temperature/top_p/top_k passed via `extra` for reject-list models', async () => {
    const { adapter, captured } = captureAdapter();

    await adapter.complete({
      ...baseRequest,
      model: 'claude-opus-4-8',
      extra: { temperature: 0.7, top_p: 0.9, top_k: 40 },
    } as any);

    expect(captured[0]).not.toHaveProperty('temperature');
    expect(captured[0]).not.toHaveProperty('top_p');
    expect(captured[0]).not.toHaveProperty('top_k');
  });

  it('strips temperature when thinking is enabled via `extra` (bypass closed)', async () => {
    const { adapter, captured } = captureAdapter();

    await adapter.complete({
      ...baseRequest,
      model: 'claude-sonnet-4-5',
      extra: {
        thinking: { type: 'enabled', budget_tokens: 2048 },
        temperature: 0.7,
      },
    } as any);

    expect(captured[0]).not.toHaveProperty('temperature');
    expect(captured[0].thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
  });

  it('drops temperature/top_k passed via `extra` under extended thinking', async () => {
    const { adapter, captured } = captureAdapter();

    await adapter.complete({
      ...baseRequest,
      model: 'claude-sonnet-4-5',
      thinking: { type: 'enabled', budget_tokens: 2048 },
      extra: { temperature: 0.7, top_k: 40 },
    } as any);

    expect(captured[0]).not.toHaveProperty('temperature');
    expect(captured[0]).not.toHaveProperty('top_k');
    expect(captured[0].thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
  });

  it('keeps sampling params passed via `extra` for models that still accept them', async () => {
    const { adapter, captured } = captureAdapter();

    await adapter.complete({
      ...baseRequest,
      model: 'claude-sonnet-4-5',
      extra: { temperature: 0.3 },
    } as any);

    expect(captured[0].temperature).toBe(0.3);
  });
});

describe('flattenRootSchemaUnion', () => {
  it('returns the same reference when there is nothing to repair', () => {
    const schema = {
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
    };
    expect(flattenRootSchemaUnion(schema)).toBe(schema);
  });

  it('leaves nested unions (inside properties) untouched', () => {
    const schema = {
      type: 'object',
      properties: {
        value: { oneOf: [{ type: 'string' }, { type: 'number' }] },
      },
    };
    expect(flattenRootSchemaUnion(schema)).toBe(schema);
  });

  it('flattens a root oneOf of object variants into a single object schema', () => {
    const schema = {
      oneOf: [
        {
          type: 'object',
          properties: { channelId: { type: 'string' }, message: { type: 'string' } },
          required: ['channelId', 'message'],
        },
        {
          type: 'object',
          properties: { userId: { type: 'string' }, message: { type: 'string' } },
          required: ['userId', 'message'],
        },
      ],
    };

    const result = flattenRootSchemaUnion(schema) as Record<string, any>;

    expect(result).not.toHaveProperty('oneOf');
    expect(result).not.toHaveProperty('anyOf');
    expect(result.type).toBe('object');
    expect(Object.keys(result.properties).sort()).toEqual([
      'channelId',
      'message',
      'userId',
    ]);
    expect(result.required).toEqual(['message']);
    expect(result.description).toContain('channelId, message');
    expect(result.description).toContain('userId, message');
  });

  it('flattens a root anyOf the same way', () => {
    const schema = {
      description: 'Query tool',
      anyOf: [
        { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
        { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
      ],
    };

    const result = flattenRootSchemaUnion(schema) as Record<string, any>;

    expect(result).not.toHaveProperty('anyOf');
    expect(result.type).toBe('object');
    expect(Object.keys(result.properties).sort()).toEqual(['id', 'q']);
    expect(result.required).toBeUndefined();
    expect(result.description).toContain('Query tool');
  });

  it('unions required lists for a root allOf (intersective semantics)', () => {
    const schema = {
      allOf: [
        { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
        { type: 'object', properties: { b: { type: 'string' } }, required: ['b'] },
      ],
    };

    const result = flattenRootSchemaUnion(schema) as Record<string, any>;

    expect(result).not.toHaveProperty('allOf');
    expect(result.type).toBe('object');
    expect([...result.required].sort()).toEqual(['a', 'b']);
  });

  it('merges all root union keys when multiple combinators are present at once, requiring the union of what each combinator requires in every variant', () => {
    const schema = {
      oneOf: [
        { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
        { type: 'object', properties: { b: { type: 'string' } }, required: ['b'] },
      ],
      anyOf: [
        { type: 'object', properties: { c: { type: 'string' } }, required: ['c'] },
        { type: 'object', properties: { d: { type: 'string' } }, required: ['c', 'd'] },
      ],
    };

    const result = flattenRootSchemaUnion(schema) as Record<string, any>;

    expect(result).not.toHaveProperty('oneOf');
    expect(result).not.toHaveProperty('anyOf');
    expect(result.type).toBe('object');
    expect(Object.keys(result.properties).sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(result.required).toEqual(['c']);
    expect(result.description).toContain('(a) | (b)');
    expect(result.description).toContain('(c) | (c, d)');
  });

  it('drops variant-level additionalProperties:false from the merged schema', () => {
    const schema = {
      oneOf: [
        { type: 'object', properties: { a: {} }, additionalProperties: false },
        { type: 'object', properties: { b: {} }, additionalProperties: false },
      ],
    };

    const result = flattenRootSchemaUnion(schema) as Record<string, any>;
    expect(result).not.toHaveProperty('additionalProperties');
  });

  it('falls back to a permissive object schema for non-object variants', () => {
    const schema = {
      description: 'Weird tool',
      oneOf: [{ type: 'string' }, { type: 'object', properties: { a: {} } }],
    };

    const result = flattenRootSchemaUnion(schema) as Record<string, any>;

    expect(result).not.toHaveProperty('oneOf');
    expect(result.type).toBe('object');
    expect(result.additionalProperties).toBe(true);
    expect(result.description).toContain('Weird tool');
    expect(result.description).toContain('"type":"string"');
  });

  it('preserves $defs/definitions on the fallback path so serialized $refs resolve', () => {
    const schema = {
      definitions: {
        A: { type: 'object', properties: { a: { type: 'string' } } },
      },
      $defs: {
        B: { type: 'object', properties: { b: { type: 'number' } } },
      },
      oneOf: [{ $ref: '#/definitions/A' }, { $ref: '#/$defs/B' }],
    };

    const result = flattenRootSchemaUnion(schema) as Record<string, any>;

    expect(result).not.toHaveProperty('oneOf');
    expect(result.type).toBe('object');
    expect(result.additionalProperties).toBe(true);
    expect(result.definitions).toEqual({
      A: { type: 'object', properties: { a: { type: 'string' } } },
    });
    expect(result.$defs).toEqual({
      B: { type: 'object', properties: { b: { type: 'number' } } },
    });
    expect(result.description).toContain('$ref');
  });

  it('passes non-object schemas through untouched', () => {
    expect(flattenRootSchemaUnion(undefined)).toBeUndefined();
    expect(flattenRootSchemaUnion(null)).toBeNull();
    expect(flattenRootSchemaUnion('not a schema')).toBe('not a schema');
  });

  it('merges a variant property named like an Object.prototype member, and drops a required name only the prototype carries', () => {
    const schema = JSON.parse(`{
      "required": ["toString"],
      "oneOf": [
        { "type": "object", "properties": { "constructor": { "type": "string" }, "a": {} },
          "required": ["constructor"] },
        { "type": "object", "properties": { "constructor": { "type": "string" }, "b": {} },
          "required": ["constructor"] }
      ]
    }`);

    const result = flattenRootSchemaUnion(schema) as Record<string, any>;

    expect(Object.keys(result.properties).sort()).toEqual(['a', 'b', 'constructor']);
    expect(result.properties.constructor).toEqual({ type: 'string' });
    expect(result.required).toEqual(['constructor']);
  });
});

describe('AnthropicAdapter: tool input_schema union flattening', () => {
  it('rewrites a root oneOf so the compiled tool schema has no root-level union', async () => {
    const { adapter, captured } = captureAdapter();

    await adapter.complete({
      ...baseRequest,
      model: 'claude-sonnet-4-5',
      tools: [
        {
          name: 'send_message',
          description: 'Send a message to a channel or user',
          input_schema: {
            oneOf: [
              {
                type: 'object',
                properties: { channelId: { type: 'string' }, text: { type: 'string' } },
                required: ['channelId', 'text'],
              },
              {
                type: 'object',
                properties: { userId: { type: 'string' }, text: { type: 'string' } },
                required: ['userId', 'text'],
              },
            ],
          },
        },
      ],
    } as any);

    const shippedTool = captured[0].tools[0];
    expect(shippedTool.name).toBe('send_message');
    expect(shippedTool.input_schema).not.toHaveProperty('oneOf');
    expect(shippedTool.input_schema).not.toHaveProperty('anyOf');
    expect(shippedTool.input_schema).not.toHaveProperty('allOf');
    expect(shippedTool.input_schema.type).toBe('object');
    expect(Object.keys(shippedTool.input_schema.properties).sort()).toEqual([
      'channelId',
      'text',
      'userId',
    ]);
  });

  it('leaves well-formed tools untouched', async () => {
    const { adapter, captured } = captureAdapter();

    const tool = {
      name: 'get_weather',
      description: 'Get the weather',
      input_schema: {
        type: 'object',
        properties: { location: { type: 'string' } },
        required: ['location'],
      },
    };

    await adapter.complete({
      ...baseRequest,
      model: 'claude-sonnet-4-5',
      tools: [tool],
    } as any);

    expect(captured[0].tools[0]).toEqual(tool);
  });
});
