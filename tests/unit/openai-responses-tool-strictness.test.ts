/**
 * Responses attempts to normalize an omitted `strict` into strict mode when
 * possible; that mode requires every property. Explicit `strict: false` opts
 * out, preserving the caller's optional-property semantics.
 * https://developers.openai.com/api/docs/guides/function-calling#strict-mode
 * These mocked tests assert the outbound contract, not the model's choice of
 * tool arguments.
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

const REFUSED: Array<[string, unknown, string]> = [
  ['the string "true"', 'true', '"true"'],
  ['an empty string', '', '""'],
  ['a string of 40 characters, the longest quoted', 'x'.repeat(40), JSON.stringify('x'.repeat(40))],
  ['a string too long to quote', 'x'.repeat(41), 'a 41-character string'],
  ['the number 1', 1, 'number 1'],
  ['the number 0', 0, 'number 0'],
  ['an object', {}, 'an object'],
  ['an array', [], 'an array'],
  ['a function', () => true, 'a function'],
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

function frozen<T>(value: T): T {
  if (value !== null && (typeof value === 'object' || typeof value === 'function') && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Reflect.ownKeys(value as object)) frozen((value as Record<PropertyKey, unknown>)[key]);
  }
  return value;
}

function request(tools: unknown[]): ProviderRequest {
  return {
    model: 'gpt-5.4',
    messages: [{ type: 'message', role: 'user', content: 'Hello' }],
    maxTokens: 1024,
    tools: frozen(tools),
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

    it.each(REFUSED)('refuses strict set to %s, naming the tool, before sending', async (_case, value, spelled) => {
      const fetchMock = stubFetch(mode.response);
      const refused = request([spelling.tool({ strict: value })]);
      const sending = mode.adapter().complete(refused);

      await expect(sending).rejects.toBeInstanceOf(MembraneError);
      await expect(sending).rejects.toMatchObject({ type: 'invalid_request', retryable: false });
      await expect(sending).rejects.toThrow(`function tool "probe" has strict set to ${spelled}; strict must be true, false, null or omitted`);
      const error = await sending.catch((caught: unknown) => caught);
      expect((error as MembraneError).rawRequest).toMatchObject({ model: refused.model, tools: refused.tools });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it('names a tool without a name by its position', async () => {
    const fetchMock = stubFetch(mode.response);
    const sending = mode.adapter().complete(request([
      SPELLINGS['a tool definition']!.tool({}),
      { description: 'Nameless.', inputSchema: SCHEMA, strict: 'yes' },
    ]));

    await expect(sending).rejects.toThrow('the function tool at tools[1], which has no name, has strict set to "yes";');
    for (const nameless of [
      { type: 'function', name: '', parameters: SCHEMA, strict: 'yes' },
      { type: 'function', function: { parameters: SCHEMA, strict: 'yes' } },
    ]) {
      await expect(mode.adapter().complete(request([nameless]))).rejects.toThrow('the function tool at tools[0], which has no name, has strict set to "yes";');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps a flat function as given apart from strict: its other fields stay, and no parameters are added', async () => {
    const fetchMock = stubFetch(mode.response);
    const flat = { type: 'function', name: 'probe', description: 'Probe.', defer_loading: true };
    await mode.adapter().complete(request([flat]));

    expect(sentTools(fetchMock)).toEqual([{ ...flat, strict: false }]);
  });

  it('reads a Chat-style wrapper\'s own strict when its function\'s is omitted or null', async () => {
    const wrapped = (outer: unknown, inner: StrictField = {}) => ({
      type: 'function',
      strict: outer,
      function: { name: 'probe', description: 'Probe.', parameters: SCHEMA, ...inner },
    });
    const sent = async (tool: unknown) => {
      const fetchMock = stubFetch(mode.response);
      await mode.adapter().complete(request([tool]));
      return sentTools(fetchMock);
    };
    const wire = SPELLINGS['a flat Responses function']!.wire;

    expect(await sent(wrapped(true))).toEqual([wire(true)]);
    expect(await sent(wrapped(true, { strict: null }))).toEqual([wire(true)]);
    expect(await sent(wrapped(true, { strict: false }))).toEqual([wire(false)]);

    const refusing = stubFetch(mode.response);
    await expect(mode.adapter().complete(request([wrapped('yes')]))).rejects.toThrow('function tool "probe" has strict set to "yes";');
    expect(refusing).not.toHaveBeenCalled();
  });

  it('applies the same rule to tools supplied as a provider-params override', async () => {
    const fetchMock = stubFetch(mode.response);
    const overridden: ProviderRequest = {
      ...request([SPELLINGS['a tool definition']!.tool({})]),
      extra: { tools: frozen([SPELLINGS['a flat Responses function']!.tool({}), { type: 'web_search' }]) },
    };
    await mode.adapter().complete(overridden);

    expect(sentTools(fetchMock)).toEqual([
      SPELLINGS['a flat Responses function']!.wire(false),
      { type: 'web_search' },
    ]);
  });

  it('converts the override alone, so request.tools it replaces is never refused', async () => {
    const fetchMock = stubFetch(mode.response);
    await mode.adapter().complete({
      ...request([SPELLINGS['a tool definition']!.tool({ strict: 'yes' })]),
      extra: { tools: frozen([SPELLINGS['a flat Responses function']!.tool({})]) },
    });

    expect(sentTools(fetchMock)).toEqual([SPELLINGS['a flat Responses function']!.wire(false)]);
  });

  it('refuses a non-boolean strict in a provider-params override before sending', async () => {
    const fetchMock = stubFetch(mode.response);
    const sending = mode.adapter().complete({
      ...request([]),
      extra: { tools: frozen([SPELLINGS['a nested Chat-style function']!.tool({ strict: 'yes' })]) },
    });

    await expect(sending).rejects.toMatchObject({ type: 'invalid_request', retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
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

  it('passes a container tool through as the caller wrote it, member functions included', async () => {
    const fetchMock = stubFetch(mode.response);
    const namespace = { type: 'namespace', name: 'files', tools: [{ type: 'function', name: 'read', parameters: SCHEMA }] };
    await mode.adapter().complete({ ...request([]), extra: { tools: frozen([namespace]) } });

    expect(sentTools(fetchMock)).toEqual([namespace]);
  });
});

const SAVE_RECENT_IMAGE: ToolDefinition = frozen({
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
});

// Schema shape from agent-framework 0.22.1, with abbreviated descriptions.
// This fixture does not track that module: Membrane must preserve any schema
// revision unchanged and send strict:false, regardless of its paging rules.
const WORKSPACE_READ: ToolDefinition = frozen({
  name: 'workspace--read',
  description: 'Read workspace text using either line or character paging, never both.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      offset: { type: 'number' },
      limit: { type: 'number' },
      offsetChars: { type: 'integer' },
      limitChars: { type: 'integer' },
    },
    required: ['path'],
  },
});

describe('function tools through Membrane', () => {
  it.each([SAVE_RECENT_IMAGE, WORKSPACE_READ])('$name reaches the Responses wire with strict:false and its own required list (API key, Responses formatter)', async (fixture) => {
    const fetchMock = stubFetch(completedJson);
    const membrane = new Membrane(
      new OpenAIResponsesAPIAdapter({ apiKey: 'sk-test' }),
      { formatter: new OpenAIResponsesFormatter(), assistantParticipant: 'Astra' },
    );

    await membrane.complete({
      messages: [{ participant: 'nissa', content: [{ type: 'text', text: 'Use the requested tool.' }] }],
      config: { model: 'gpt-5.6', maxTokens: 100 },
      tools: [fixture],
    });

    const [tool] = sentTools(fetchMock) as Array<Record<string, any>>;
    expect(tool).toEqual({
      type: 'function',
      name: fixture.name,
      description: fixture.description,
      parameters: fixture.inputSchema,
      strict: false,
    });
    expect(tool!.parameters.required).toEqual(['path']);
  });

  it('states strictness on function tools a caller passes as providerParams.tools', async () => {
    const fetchMock = stubFetch(completedJson);
    const membrane = new Membrane(
      new OpenAIResponsesAPIAdapter({ apiKey: 'sk-test' }),
      { formatter: new OpenAIResponsesFormatter(), assistantParticipant: 'Astra' },
    );

    await membrane.complete({
      messages: [{ participant: 'nissa', content: [{ type: 'text', text: 'Keep that screenshot.' }] }],
      config: { model: 'gpt-5.6', maxTokens: 100 },
      providerParams: {
        tools: frozen([{ type: 'function', name: 'save_recent_image', parameters: SAVE_RECENT_IMAGE.inputSchema }]),
      },
    });

    expect(sentTools(fetchMock)).toEqual([
      { type: 'function', name: 'save_recent_image', parameters: SAVE_RECENT_IMAGE.inputSchema, strict: false },
    ]);
  });

  it.each(['complete', 'stream'] as const)(
    'refuses a non-boolean strict from %s() once, unretried, with no onError, carrying the request it refused',
    async (call) => {
      const fetchMock = stubFetch(completedJson);
      const adapter = new OpenAIResponsesAPIAdapter({ apiKey: 'sk-test' });
      const adapterCalls = vi.spyOn(adapter, call);
      const onError = vi.fn(() => 'retry' as const);
      const membrane = new Membrane(adapter, {
        formatter: new OpenAIResponsesFormatter(),
        assistantParticipant: 'Astra',
        retry: { maxRetries: 3 },
        hooks: { onError },
      });
      const tools = frozen([{ type: 'function', name: 'save_recent_image', parameters: SAVE_RECENT_IMAGE.inputSchema, strict: 'yes' }]);

      const error = await membrane[call]({
        messages: [{ participant: 'nissa', content: [{ type: 'text', text: 'Keep that screenshot.' }] }],
        config: { model: 'gpt-5.6', maxTokens: 100 },
        providerParams: { tools },
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(MembraneError);
      expect(error).toMatchObject({ type: 'invalid_request', retryable: false });
      expect((error as Error).message).toContain('function tool "save_recent_image" has strict set to "yes";');
      expect((error as MembraneError).rawRequest).toMatchObject({ model: 'gpt-5.6', tools });
      expect(adapterCalls).toHaveBeenCalledOnce();
      expect(onError).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('refuses on a retry with the retry\'s own request, not the attempt sent before it', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => new Response(JSON.stringify({ error: { message: 'boom', type: 'server_error' } }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockImplementation(async () => completedJson());
    vi.stubGlobal('fetch', fetchMock);
    const refusedTools = frozen([{ type: 'function', name: 'save_recent_image', parameters: SAVE_RECENT_IMAGE.inputSchema, strict: 'yes' }]);
    let attempt = 0;
    const membrane = new Membrane(new OpenAIResponsesAPIAdapter({ apiKey: 'sk-test' }), {
      formatter: new OpenAIResponsesFormatter(),
      assistantParticipant: 'Astra',
      retry: { maxRetries: 2, retryDelayMs: 1 },
      hooks: {
        beforeRequest: (_request, providerRequest) =>
          (++attempt === 2 ? { ...(providerRequest as object), tools: refusedTools } : providerRequest),
      },
    });

    const error = await membrane.complete({
      messages: [{ participant: 'nissa', content: [{ type: 'text', text: 'Keep that screenshot.' }] }],
      config: { model: 'gpt-5.6', maxTokens: 100 },
      tools: [SAVE_RECENT_IMAGE],
    }).catch((caught: unknown) => caught);

    expect(attempt).toBe(2);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(error).toMatchObject({ type: 'invalid_request', retryable: false });
    const sent = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body)) as { tools: unknown };
    expect(sent.tools).toEqual([expect.objectContaining({ name: 'save_recent_image', strict: false })]);
    expect(((error as MembraneError).rawRequest as { tools?: unknown }).tools).toEqual(refusedTools);
  });

  it.each([SAVE_RECENT_IMAGE, WORKSPACE_READ])('$name reaches the subscription wire with strict:false from an Anthropic-shaped input_schema (native formatter)', async (fixture) => {
    const fetchMock = stubFetch(completedSse);
    const membrane = new Membrane(
      new OpenAIResponsesAPIAdapter({ mode: 'subscription', credentials: async () => ({ token: 'subscription-token' }) }),
      { formatter: new NativeFormatter(), assistantParticipant: 'Astra' },
    );

    await membrane.complete({
      messages: [{ participant: 'nissa', content: [{ type: 'text', text: 'Use the requested tool.' }] }],
      config: { model: 'gpt-5.4', maxTokens: 100 },
      tools: [fixture],
    });

    const [tool] = sentTools(fetchMock) as Array<Record<string, any>>;
    expect(tool).toEqual({
      type: 'function',
      name: fixture.name,
      description: fixture.description,
      parameters: fixture.inputSchema,
      strict: false,
    });
    expect(tool!.parameters.required).toEqual(['path']);
  });
});
