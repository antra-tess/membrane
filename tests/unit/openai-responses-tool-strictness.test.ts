/**
 * Function tools sent through the Responses adapter state their strictness.
 *
 * Connectome's tools are plain JSON Schema: a property outside `required` may
 * be omitted. Left without a `strict` field, a function tool's validation is
 * the provider's default, and strict validation makes every property one the
 * model must send — Astra's save_recent_image selectors arrived presented as
 * required (snag: connectome-save-recent-image-schema-requires-exclusive-
 * selectors). So every function tool reaches the wire with a boolean: omitted
 * or null becomes false, an explicit boolean is kept, and anything else is
 * refused, naming the tool, before a request is sent. That holds in API-key and
 * subscription modes and on all three function spellings convertTools accepts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIResponsesAPIAdapter } from '../../src/providers/openai-responses-api.js';
import { Membrane } from '../../src/membrane.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { OpenAIResponsesFormatter } from '../../src/formatters/openai-responses.js';
import { MembraneError } from '../../src/types/index.js';
import type { ProviderRequest, ToolDefinition } from '../../src/types/index.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    ref: { type: 'string' },
  },
  required: ['path'],
};

type StrictField = Record<string, unknown>;

/** The three function-tool spellings, each carrying `strict` where it keeps it. */
const SPELLINGS: Record<string, {
  tool: (strict: StrictField) => unknown;
  wire: (strict: boolean) => unknown;
}> = {
  'a flat Responses function': {
    tool: (strict) => ({ type: 'function', name: 'probe', description: 'Probe.', parameters: SCHEMA, ...strict }),
    wire: (strict) => ({ type: 'function', name: 'probe', description: 'Probe.', parameters: SCHEMA, strict }),
  },
  'a nested Chat-style function': {
    tool: (strict) => ({
      type: 'function',
      function: { name: 'probe', description: 'Probe.', parameters: SCHEMA, ...strict },
    }),
    wire: (strict) => ({ type: 'function', name: 'probe', description: 'Probe.', parameters: SCHEMA, strict }),
  },
  'a tool definition': {
    tool: (strict) => ({ name: 'probe', description: 'Probe.', inputSchema: SCHEMA, ...strict }),
    wire: (strict) => ({ type: 'function', name: 'probe', description: 'Probe.', parameters: SCHEMA, strict }),
  },
};

const ACCEPTED: Array<[string, StrictField, boolean]> = [
  ['omitted', {}, false],
  ['null', { strict: null }, false],
  ['explicit true', { strict: true }, true],
  ['explicit false', { strict: false }, false],
];

const REFUSED: Array<[string, unknown]> = [
  ['the string "true"', 'true'],
  ['the number 1', 1],
  ['an object', {}],
  ['an array', []],
];

function completedJson(): Response {
  return new Response(JSON.stringify({
    id: 'resp_strict',
    model: 'gpt-5.6',
    status: 'completed',
    output: [{
      type: 'message',
      id: 'msg_strict',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'ok' }],
    }],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function completedSse(): Response {
  const events = [
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: { type: 'message', id: 'msg_strict', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] },
    },
    {
      type: 'response.completed',
      response: {
        id: 'resp_strict',
        model: 'gpt-5.4',
        status: 'completed',
        output: [],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

const MODES = {
  'API-key mode': {
    adapter: () => new OpenAIResponsesAPIAdapter({ apiKey: 'sk-test' }),
    response: completedJson,
  },
  'subscription mode': {
    adapter: () => new OpenAIResponsesAPIAdapter({
      mode: 'subscription',
      credentials: async () => ({ token: 'subscription-token' }),
    }),
    response: completedSse,
  },
};

function request(tools: unknown[]): ProviderRequest {
  return {
    model: 'gpt-5.4',
    messages: [{ type: 'message', role: 'user', content: 'Hello' }],
    maxTokens: 1024,
    tools,
  };
}

function stubFetch(response: () => Response) {
  const fetchMock = vi.fn().mockImplementation(async () => response());
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function sentTools(fetchMock: ReturnType<typeof vi.fn>): unknown[] {
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
  return JSON.parse(String(init.body)).tools;
}

describe.each(Object.entries(MODES))('Responses function-tool strictness, %s', (_mode, mode) => {
  describe.each(Object.entries(SPELLINGS))('on %s', (_spelling, spelling) => {
    it.each(ACCEPTED)('sends %s strict as a boolean', async (_case, strict, expected) => {
      const fetchMock = stubFetch(mode.response);
      await mode.adapter().complete(request([spelling.tool(strict)]));

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(sentTools(fetchMock)).toEqual([spelling.wire(expected)]);
    });

    it.each(REFUSED)('refuses strict set to %s, naming the tool, before sending', async (_case, value) => {
      const fetchMock = stubFetch(mode.response);
      const sending = mode.adapter().complete(request([spelling.tool({ strict: value })]));

      await expect(sending).rejects.toBeInstanceOf(MembraneError);
      await expect(sending).rejects.toMatchObject({ type: 'invalid_request', retryable: false });
      await expect(sending).rejects.toThrow(/function tool "probe" has strict set to/);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it('passes non-function tools through unchanged, without a strict field', async () => {
    const fetchMock = stubFetch(mode.response);
    const webSearch = { type: 'web_search' };
    const custom = { type: 'custom', name: 'apply_patch', description: 'Patch.' };
    await mode.adapter().complete(request([webSearch, custom, SPELLINGS['a tool definition']!.tool({})]));

    const tools = sentTools(fetchMock);
    expect(tools[0]).toEqual(webSearch);
    expect(tools[1]).toEqual(custom);
    expect(tools[2]).toMatchObject({ type: 'function', name: 'probe', strict: false });
  });
});

/**
 * AF's synthesized save_recent_image tool, as agent-framework 64c480b
 * (src/framework.ts SAVE_IMAGE_TOOL) defines it: `path` required, the three
 * selectors optional. What this pins is membrane's side — the schema reaches
 * the wire unchanged, beside `strict: false` — which holds for any revision of
 * the definition.
 */
const SAVE_RECENT_IMAGE: ToolDefinition = {
  name: 'save_recent_image',
  description: 'Save one or more recent images from your own context to workspace files.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Mount-prefixed destination path, e.g. "project/photos/name.png".' },
      index: { type: 'number', description: 'Which image, counting back from the most recent (0 = most recent). Default 0.' },
      count: { type: 'number', description: 'How many images to save, starting at `index` and going further back. Default 1.' },
      ref: { type: 'string', description: 'Save a specific tool-result image by its history ref. Mutually exclusive with `index`/`count`.' },
    },
    required: ['path'],
  },
};

describe('save_recent_image through Membrane', () => {
  it('reaches the Responses wire with strict:false and its own required list (API key, Responses formatter)', async () => {
    const fetchMock = stubFetch(completedJson);
    const membrane = new Membrane(
      new OpenAIResponsesAPIAdapter({ apiKey: 'sk-test' }),
      { formatter: new OpenAIResponsesFormatter(), assistantParticipant: 'Astra' },
    );

    await membrane.complete({
      messages: [{ participant: 'nissa', content: [{ type: 'text', text: 'Keep that screenshot.' }] }],
      config: { model: 'gpt-5.6', maxTokens: 100 },
      tools: [SAVE_RECENT_IMAGE],
    });

    const [tool] = sentTools(fetchMock) as Array<Record<string, any>>;
    expect(tool).toEqual({
      type: 'function',
      name: 'save_recent_image',
      description: SAVE_RECENT_IMAGE.description,
      parameters: SAVE_RECENT_IMAGE.inputSchema,
      strict: false,
    });
    expect(tool!.parameters.required).toEqual(['path']);
  });

  it('reaches the subscription wire with strict:false from an Anthropic-shaped input_schema (native formatter)', async () => {
    const fetchMock = stubFetch(completedSse);
    const membrane = new Membrane(
      new OpenAIResponsesAPIAdapter({ mode: 'subscription', credentials: async () => ({ token: 'subscription-token' }) }),
      { formatter: new NativeFormatter(), assistantParticipant: 'Astra' },
    );

    await membrane.complete({
      messages: [{ participant: 'nissa', content: [{ type: 'text', text: 'Keep that screenshot.' }] }],
      config: { model: 'gpt-5.4', maxTokens: 100 },
      tools: [SAVE_RECENT_IMAGE],
    });

    const [tool] = sentTools(fetchMock) as Array<Record<string, any>>;
    expect(tool).toEqual({
      type: 'function',
      name: 'save_recent_image',
      description: SAVE_RECENT_IMAGE.description,
      parameters: SAVE_RECENT_IMAGE.inputSchema,
      strict: false,
    });
    expect(tool!.parameters.required).toEqual(['path']);
  });
});
