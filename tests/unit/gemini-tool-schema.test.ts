/**
 * Gemini's `FunctionDeclaration.parameters` takes only its OpenAPI-subset
 * `Schema`: a `type` there is one value, and `$schema`, `$defs`, `$ref` and
 * `const` are unknown fields, which fail the whole generateContent call with
 * 400 INVALID_ARGUMENT. `parametersJsonSchema` takes the schema as JSON Schema.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { GeminiAdapter } from '../../src/providers/gemini.js';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Answers every request with a plain completion and keeps each request body. */
function recordBodies(): Array<Record<string, any>> {
  const bodies: Array<Record<string, any>> = [];
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'zz-answer' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof globalThis.fetch;
  return bodies;
}

/** A nullable field as JSON Schema writes it. */
const NULLABLE = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    index: { type: ['integer', 'null'], description: 'null to save the newest image.' },
  },
  required: ['path'],
};

/** What MCP servers' schema generators write: a draft URI, definitions and references, constants, and null as a branch. */
const GENERATED = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  $defs: {
    Item: {
      type: 'object',
      properties: { id: { type: 'integer' }, tags: { type: 'array', items: { type: 'string' } } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  properties: {
    items: { type: 'array', items: { $ref: '#/$defs/Item' } },
    mode: { anyOf: [{ type: 'string', enum: ['a', 'b'] }, { type: 'null' }] },
    choice: { oneOf: [{ const: 'x' }, { const: 'y' }] },
  },
  required: ['items'],
  additionalProperties: false,
};

const request = (tools: unknown[]) => ({
  model: 'gemini-3.5-flash-lite', maxTokens: 64, messages: [{ role: 'user', content: 'zz-prompt' }], tools,
}) as any;

describe('GeminiAdapter tool schemas', () => {
  for (const [label, schema] of [['a type array', NULLABLE], ['a generated schema', GENERATED]] as const) {
    it(`sends ${label} unchanged as parametersJsonSchema, and no parameters`, async () => {
      const bodies = recordBodies();
      // Taken before the call, so an adapter that edited the caller's schema
      // in place would differ from it.
      const schemaBeforeTheCall = structuredClone(schema);
      await new GeminiAdapter({ apiKey: 'zz-key-not-used' }).complete(
        request([{ name: 'zz_tool', description: 'zz-description', inputSchema: schema }]),
      );

      const [declaration] = bodies[0]!.tools[0].functionDeclarations;
      expect(declaration).toEqual({ name: 'zz_tool', description: 'zz-description', parametersJsonSchema: schemaBeforeTheCall });
      expect(declaration).not.toHaveProperty('parameters');
      expect(schema).toEqual(schemaBeforeTheCall);
    });
  }

  it('sends the schema the same way on stream()', async () => {
    const bodies: Array<Record<string, any>> = [];
    globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
      bodies.push(JSON.parse(String(init?.body)));
      const frame = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'zz-answer' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 } })}\n\n`;
      return new Response(
        new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(frame)); controller.close(); } }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    }) as typeof globalThis.fetch;
    const expected = structuredClone(NULLABLE);
    await new GeminiAdapter({ apiKey: 'zz-key-not-used' }).stream(
      request([{ name: 'zz_tool', description: 'zz-description', inputSchema: NULLABLE }]),
      { onChunk: () => { /* noop */ } },
    );

    const [declaration] = bodies[0]!.tools[0].functionDeclarations;
    expect(declaration).toEqual({ name: 'zz_tool', description: 'zz-description', parametersJsonSchema: expected });
    expect(declaration).not.toHaveProperty('parameters');
  });

  it('gives a tool with no schema an empty object schema, as before', async () => {
    const bodies = recordBodies();
    await new GeminiAdapter({ apiKey: 'zz-key-not-used' }).complete(request([{ name: 'zz_tool', description: 'zz-description' }]));

    const [declaration] = bodies[0]!.tools[0].functionDeclarations;
    expect(declaration.parametersJsonSchema).toEqual({ type: 'object', properties: {} });
    expect(declaration).not.toHaveProperty('parameters');
  });
});
