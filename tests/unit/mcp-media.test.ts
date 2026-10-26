/** MCP's media form is `{ type, data, mimeType }`, with no `source`. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { AnthropicAdapter, toAnthropicContent } from '../../src/providers/anthropic.js';
import { BedrockAdapter } from '../../src/providers/bedrock.js';
import { GeminiAdapter } from '../../src/providers/gemini.js';
import { OpenAIAdapter } from '../../src/providers/openai.js';
import { OpenAICompatibleAdapter } from '../../src/providers/openai-compatible.js';
import { OpenRouterAdapter } from '../../src/providers/openrouter.js';
import { OpenAIResponsesAPIAdapter } from '../../src/providers/openai-responses-api.js';
import { OpenAIResponsesAdapter } from '../../src/providers/openai-responses.js';
import { transformToChat } from '../../src/transforms/chat.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { AnthropicXmlFormatter } from '../../src/formatters/anthropic-xml.js';
import { OpenAIResponsesFormatter } from '../../src/formatters/openai-responses.js';
import { CompletionsFormatter } from '../../src/formatters/completions.js';
import { convertMcpMedia } from '../../src/utils/mcp-media.js';
import { formatToolResults, formatToolResultsForSplitTurn } from '../../src/utils/tool-parser.js';
import type {
  ContentBlock,
  NormalizedMessage,
  NormalizedRequest,
  ProviderAdapter,
  ProviderRequest,
  ProviderRequestOptions,
  ProviderResponse,
  RoundReport,
  StreamCallbacks,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../../src/types/index.js';
import type { PrefillFormatter } from '../../src/formatters/types.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64');
const WAV = 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
const PDF = Buffer.from('%PDF-1.4\n%%EOF\n').toString('base64');

const text = (value: string) => ({ type: 'text', text: value });
/** An MCP server may send annotations and _meta beside a piece of media; no provider request carries them. */
const mcp = (type: string, data: string, mimeType: string, extra: object = {}) =>
  ({ type, data, mimeType, annotations: { audience: ['user'], priority: 0.5 }, _meta: { server: 'test' }, ...extra });
const ours = (type: string, data: string, mediaType: string, extra: object = {}) => ({ type, ...extra, source: { type: 'base64', data, mediaType } });

type Form = typeof mcp;
const FORMS: Array<[string, Form]> = [["MCP's form", mcp], ["membrane's form", ours]];

function history(form: Form, options: { audioAtTop?: boolean } = {}): NormalizedMessage[] {
  const media = () => [form('image', PNG, 'image/png'), form('image', SVG, 'image/svg+xml')];
  return [
    { participant: 'User', content: [text('look'), ...media(), ...(options.audioAtTop ? [form('audio', WAV, 'audio/wav')] : [])] },
    { participant: 'Claude', content: [{ type: 'tool_use', id: 'shot', name: 'noop', input: {} }] },
    { participant: 'User', content: [{ type: 'tool_result', toolUseId: 'shot', content: [text('here'), ...media(), form('audio', WAV, 'audio/wav')] }] },
    { participant: 'Claude', content: [text('seen')] },
    { participant: 'User', content: [text('go on')] },
  ] as NormalizedMessage[];
}

const noop: ToolDefinition = { name: 'noop', description: 'A tool', inputSchema: { type: 'object', properties: {} } };
const CALL_XML = '<function_calls>\n<invoke name="noop">\n</invoke>';
const config = { model: 'claude-sonnet-4-5', maxTokens: 64 };

class ScriptedAnthropic extends AnthropicAdapter {
  sent: any[] = [];
  private round = 0;
  constructor(private mode: 'native' | 'xml', private calls = 0) {
    super({ apiKey: 'test', cacheKeepalive: { enabled: false } });
  }
  override async stream(request: ProviderRequest, callbacks: StreamCallbacks, options?: ProviderRequestOptions): Promise<ProviderResponse> {
    const wire = (this as any).buildRequest(request, options?.onContentAltered);
    this.sent.push(JSON.parse(JSON.stringify(wire)));
    options?.onRequest?.(wire);
    const call = this.round < this.calls;
    this.round++;
    const base = { usage: { inputTokens: 10, outputTokens: 2 }, model: request.model, rawRequest: wire, raw: {} };
    if (call && this.mode === 'native') {
      return { ...base, content: [{ type: 'tool_use', id: `call${this.round}`, name: 'noop', input: {} }], stopReason: 'tool_use' };
    }
    const said = call ? CALL_XML : 'done';
    callbacks.onChunk(said);
    return { ...base, content: [text(said)], stopReason: call ? 'stop_sequence' : 'end_turn', ...(call ? { stopSequence: '</function_calls>' } : {}) };
  }
}

class ScriptedResponses extends OpenAIResponsesAPIAdapter {
  sent: any[] = [];
  constructor() { super({ apiKey: 'sk-test' }); }
  override async stream(request: ProviderRequest, callbacks: StreamCallbacks, options?: ProviderRequestOptions): Promise<any> {
    const wire = (this as any).buildRequest(request, options?.onContentAltered);
    this.sent.push(JSON.parse(JSON.stringify(wire)));
    callbacks.onChunk('done');
    return { content: [text('done')], stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 2 }, model: request.model, rawRequest: wire, raw: {} };
  }
}

class Recording implements ProviderAdapter {
  readonly name = 'recording';
  readonly reportsContentAlterations = true;
  readonly usageCacheConvention = 'cache-excluded' as const;
  sent: any[] = [];
  supportsModel() { return true; }
  async complete(): Promise<ProviderResponse> { throw new Error('not used'); }
  async stream(request: ProviderRequest, callbacks: StreamCallbacks): Promise<ProviderResponse> {
    this.sent.push(JSON.parse(JSON.stringify(request.messages)));
    callbacks.onChunk('done');
    return { content: [text('done')], stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 2 }, model: request.model, rawRequest: request, raw: {} } as ProviderResponse;
  }
}

interface Turn {
  rounds: RoundReport[];
  given: ToolResult[][];
  contexts: ToolContext[];
  response: any;
}

async function turn(
  method: 'stream' | 'streamYielding',
  membrane: Membrane,
  request: NormalizedRequest,
  results: (id: string) => ToolResult[] = (id) => [{ toolUseId: id, content: 'ok' }],
): Promise<Turn> {
  const out: Turn = { rounds: [], given: [], contexts: [], response: undefined };
  const answer = (id: string, context: ToolContext) => {
    out.contexts.push(context);
    const given = results(id);
    out.given.push(given);
    return given;
  };
  if (method === 'stream') {
    out.response = await membrane.stream(request, { onToolCalls: async (calls, context) => answer(calls[0]!.id, context) });
    return out;
  }
  const stream = membrane.streamYielding(request);
  for await (const event of stream) {
    if (event.type === 'usage' && event.round) out.rounds.push(event.round);
    if (event.type === 'tool-calls') stream.provideToolResults(answer(event.calls[0]!.id, event.context));
    if (event.type === 'complete') out.response = event.response;
    if (event.type === 'error') throw event.error;
  }
  return out;
}

describe('the rule: what converts, and what stays as it was', () => {
  it.each(['image', 'document', 'audio', 'video'])('a %s block in MCP\'s form becomes membrane\'s, keeping its other fields but MCP\'s annotations and _meta, at any depth', (type) => {
    const block = mcp(type, 'AAAA', 'x/y', { annotations: { audience: ['user'] }, _meta: { n: 1 }, cache_control: { type: 'ephemeral' } });
    const converted = ours(type, 'AAAA', 'x/y', { cache_control: { type: 'ephemeral' } });
    const nested = (inner: unknown) => ({ type: 'tool_result', toolUseId: 't', content: [text('t'), inner] });
    expect(convertMcpMedia([block])).toEqual([converted]);
    expect(convertMcpMedia([nested(nested(block))])).toEqual([nested(nested(converted))]);
    expect(convertMcpMedia([{ participant: 'User', content: [block] }])).toEqual([{ participant: 'User', content: [converted] }]);
    expect(convertMcpMedia([{ toolUseId: 't', content: [block] }])).toEqual([{ toolUseId: 't', content: [converted] }]);
  });

  it('an image in MCP\'s form with no mimeType, or an empty one, becomes membrane\'s with no mediaType, at any depth, since every request that sends an image decides it by its header', () => {
    const block = { type: 'image', data: PNG, annotations: { audience: ['user'] } };
    const converted = { type: 'image', source: { type: 'base64', data: PNG } };
    const nested = (inner: unknown) => ({ type: 'tool_result', toolUseId: 't', content: [text('t'), inner] });
    expect(convertMcpMedia([block])).toStrictEqual([converted]);
    expect(convertMcpMedia([nested(block)])).toStrictEqual([nested(converted)]);
    expect(convertMcpMedia([{ ...block, mimeType: '' }])).toStrictEqual([converted]);
  });

  it('a media block with neither data nor mimeType is someone else\'s shape, not MCP\'s form, and stays as it came', () => {
    const others = [{ type: 'image' }, { type: 'image', image_url: 'https://example.com/a.png' }, { type: 'audio', url: 'https://example.com/a.wav' }];
    expect(convertMcpMedia(others)).toBe(others);
    const result = { type: 'tool_result', toolUseId: 't', content: others };
    expect(convertMcpMedia([result])[0]).toBe(result);
  });

  it('an image in MCP\'s form converts whatever its data, since every request that sends an image notes data that is missing, empty or no image', () => {
    const converted = (data: unknown) => ({ type: 'image', source: { type: 'base64', data, mediaType: 'image/png' } });
    expect(convertMcpMedia([
      { type: 'image', data: '', mimeType: 'image/png' },
      { type: 'image', mimeType: 'image/png' },
      { type: 'image', data: 7, mimeType: 'image/png' },
    ])).toStrictEqual([converted(''), converted(undefined), converted(7)]);
  });

  it('leaves what doesn\'t fit; gives back the same array when nothing converts, and changes nothing it\'s handed', () => {
    const left = [
      text('t'),
      { type: 'audio', data: WAV },
      { type: 'document', data: PNG },
      { type: 'video', data: PNG },
      { type: 'audio', data: WAV, mimeType: '' },
      { type: 'audio', mimeType: 'audio/wav' },
      { type: 'document', data: '', mimeType: 'application/pdf' },
      { type: 'video', data: 7, mimeType: 'video/mp4' },
      { type: 'image', data: PNG, mimeType: 'image/png', source: { type: 'url', url: 'https://example.com/a.png' } },
      { type: 'generated_image', data: PNG, mimeType: 'image/png' },
      { type: 'tool_result', toolUseId: 't', content: 'a string' },
      { type: 'tool_result', toolUseId: 't', content: [text('nothing to convert')] },
      null,
      'a string',
    ];
    deepFreeze(left);
    expect(convertMcpMedia(left)).toBe(left);

    const mixed = deepFreeze([...left, { type: 'tool_result', toolUseId: 't', content: [text('u'), mcp('image', PNG, 'image/png')] }]);
    const before = structuredClone(mixed);
    const out = convertMcpMedia(mixed);
    expect(out).not.toBe(mixed);
    expect(mixed).toEqual(before);
    left.forEach((item, i) => expect(out[i]).toBe(item));
    expect((out[left.length] as any).content[0]).toBe((mixed[left.length] as any).content[0]);
    expect((out[left.length] as any).content[1]).toEqual(ours('image', PNG, 'image/png'));
  });
});

const DIRECT: Array<[string, () => any, (adapter: any, messages: unknown[], report?: (block: unknown) => void) => unknown, boolean]> = [
  ['Bedrock', () => new BedrockAdapter({ accessKeyId: 'x', secretAccessKey: 'y', region: 'us-east-1' }),
    (adapter, messages, report) => adapter.buildRequest({ model: 'claude-sonnet-4-5', maxTokens: 64, messages }, undefined, report).messages, true],
  ['OpenAI', () => new OpenAIAdapter({ apiKey: 'test' }),
    (adapter, messages) => adapter.buildRequest({ model: 'gpt-5.4', maxTokens: 64, messages }).messages, false],
  ['OpenAI-compatible', () => new OpenAICompatibleAdapter({ apiKey: 'test', baseURL: 'http://localhost:1' }),
    (adapter, messages) => adapter.buildRequest({ model: 'local', maxTokens: 64, messages }).messages, false],
  ['OpenRouter', () => new OpenRouterAdapter({ apiKey: 'test' }),
    (adapter, messages) => adapter.buildRequest({ model: 'openai/gpt-5.4', maxTokens: 64, messages }).messages, false],
  ['Gemini', () => new GeminiAdapter({ apiKey: 'test' }),
    (adapter, messages) => adapter.buildRequest({ model: 'gemini-3-pro', maxTokens: 64, messages }).contents, false],
  ['the Responses adapter in subscription mode', () => new OpenAIResponsesAPIAdapter({ mode: 'subscription', credentials: {} as any }),
    (adapter, messages, report) => adapter.buildRequest({ model: 'gpt-5.4', maxTokens: 64, messages }, report).input, true],
];

describe('every path that builds a request carries MCP\'s form as it carries membrane\'s', () => {
  async function sentByComplete(formatter: PrefillFormatter, toolMode: 'xml' | 'native', messages: NormalizedMessage[]) {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const adapter = new AnthropicAdapter({ apiKey: 'test-key', cacheKeepalive: { enabled: false } });
    await new Membrane(adapter, { formatter }).complete({ messages, tools: [noop], toolMode, assistantParticipant: 'Claude', config });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    return JSON.parse(fetchMock.mock.calls[0]![1].body as string);
  }

  it.each([
    ['the anthropic-xml formatter, xml tool mode', () => new AnthropicXmlFormatter(), 'xml'],
    ['the anthropic-xml formatter, native tool mode', () => new AnthropicXmlFormatter(), 'native'],
    ['the native formatter', () => new NativeFormatter(), 'native'],
  ] as const)('complete() through %s', async (_name, formatter, toolMode) => {
    const messages = history(mcp);
    const before = structuredClone(messages);
    const sent = await sentByComplete(formatter(), toolMode, messages);
    expect(sent).toEqual(await sentByComplete(formatter(), toolMode, history(ours)));
    expect(JSON.stringify(sent)).toContain(PNG);
    expect(messages).toEqual(before);
  });

  it('the Anthropic adapter\'s request built directly, as the issue\'s reproduction did', () => {
    const adapter = new AnthropicAdapter({ apiKey: 'test', cacheKeepalive: { enabled: false } }) as any;
    const wire = (form: Form) => [
      { role: 'user', content: [text('look'), form('image', PNG, 'image/png')] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'shot', name: 'noop', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'shot', content: [text('here'), form('image', PNG, 'image/png')] }] },
    ];
    const messages = wire(mcp);
    const before = structuredClone(messages);
    const built = adapter.buildRequest({ model: 'claude-sonnet-4-5', maxTokens: 64, messages });
    expect(built.messages).toEqual(adapter.buildRequest({ model: 'claude-sonnet-4-5', maxTokens: 64, messages: wire(ours) }).messages);
    expect(built.messages[2].content[0].content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } });
    expect(messages).toEqual(before);
  });

  it('the Anthropic adapter\'s request built directly reports the block the caller handed in, not the copy it converted', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const adapter = new AnthropicAdapter({ apiKey: 'test', cacheKeepalive: { enabled: false } }) as any;
    const handed = mcp('image', Buffer.from('not an image').toString('base64'), 'image/png');
    const reported: unknown[] = [];
    const built = adapter.buildRequest({ model: 'claude-sonnet-4-5', maxTokens: 64, messages: [
      { role: 'user', content: [text('look'), handed] },
    ] }, (block: unknown) => reported.push(block));
    expect(built.messages[0].content[1]).toMatchObject({ type: 'text' });
    expect(reported).toHaveLength(1);
    expect(reported[0]).toBe(handed);
  });

  it('streamYielding() through the Responses formatter, which sends such an image in a tool_result as it sends membrane\'s', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sent = async (form: Form) => {
      const adapter = new ScriptedResponses();
      const request = { messages: history(form), config, promptCaching: false } as NormalizedRequest;
      await turn('streamYielding', new Membrane(adapter as ProviderAdapter, { formatter: new OpenAIResponsesFormatter() }), request);
      return adapter.sent;
    };
    const handed = await sent(mcp);
    expect(handed).toEqual(await sent(ours));
    const output = handed[0].input.find((item: any) => item.type === 'function_call_output');
    expect(output.output).toContainEqual({ type: 'input_image', image_url: `data:image/png;base64,${PNG}` });
  });

  it.each(DIRECT)('%s\'s request built directly, at the top of a message and in a tool_result', (_name, make, built) => {
    const wire = (form: Form) => [
      { role: 'user', content: [text('look'), form('image', PNG, 'image/png')] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'shot', name: 'noop', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'shot', toolUseId: 'shot', content: [text('here'), form('image', PNG, 'image/png')] }] },
    ];
    const messages = wire(mcp);
    const before = structuredClone(messages);
    const sent = built(make(), messages);
    expect(sent).toEqual(built(make(), wire(ours)));
    expect(JSON.stringify(sent)).toContain(PNG);
    expect(messages).toEqual(before);
  });

  it.each(DIRECT.filter(([, , , reports]) => reports))('%s\'s request built directly reports the block the caller handed in, not the copy it converted', (_name, make, built) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handed = mcp('image', Buffer.from('not an image').toString('base64'), 'image/png');
    const reported: unknown[] = [];
    const sent = built(make(), [{ role: 'user', content: [text('look'), handed] }], (block: unknown) => reported.push(block));
    expect(JSON.stringify(sent)).toContain('its data is not a JPEG, PNG, GIF or WebP image');
    expect(reported).toHaveLength(1);
    expect(reported[0]).toBe(handed);
  });

  it('Bedrock\'s request built directly reports the block the caller handed in for an image with a sourceUrl and for a tool_result', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const notAnImage = Buffer.from('not an image').toString('base64');
    const linked = mcp('image', notAnImage, 'image/png', { sourceUrl: 'https://example.com/a.png' });
    const result = { type: 'tool_result', tool_use_id: 'shot', content: [text('here'), mcp('image', notAnImage, 'image/png')] };
    const reported: unknown[] = [];
    const sent = DIRECT[0]![2](DIRECT[0]![1](), [
      { role: 'user', content: [text('look'), linked] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'shot', name: 'noop', input: {} }] },
      { role: 'user', content: [result] },
    ], (block: unknown) => reported.push(block));
    expect(JSON.stringify(sent)).not.toContain('sourceUrl');
    expect(reported).toHaveLength(2);
    expect(reported[0]).toBe(linked);
    expect(reported[1]).toBe(result);
  });

  it('the Responses adapter in subscription mode sends an image given by image_url, which isn\'t MCP\'s form, as the URL image it reads', () => {
    const linked = { type: 'image', image_url: 'https://example.com/a.png' };
    const sent = JSON.stringify(DIRECT[5]![2](DIRECT[5]![1](), [
      { role: 'user', content: [text('look'), linked] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'shot', name: 'noop', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'shot', content: [text('here'), linked] }] },
    ]));
    expect(sent.split('"type":"input_image","image_url":"https://example.com/a.png"')).toHaveLength(3);
    expect(sent).not.toContain('it came without its data');
  });

  it('the Responses adapter in subscription mode reports a standalone tool_result it was handed, not the copy it converted', () => {
    const handed = { type: 'tool_result', toolUseId: 'shot', isError: true, content: [text('failed'), mcp('image', PNG, 'image/png')] };
    const reported: unknown[] = [];
    const sent = DIRECT[5]![2](DIRECT[5]![1](), [
      { role: 'user', content: [text('go')] },
      { type: 'tool_use', id: 'shot', name: 'noop', input: {} },
      handed,
    ], (block: unknown) => reported.push(block));
    // A function_call_output has no error flag.
    expect(JSON.stringify(sent)).toContain(PNG);
    expect(reported).toEqual([handed]);
    expect(reported[0]).toBe(handed);
  });

  it('the OpenAI image adapter\'s request, which attaches the image for an edit and numbers it in the transcript', async () => {
    const sent = async (form: Form) => {
      const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ created: 1, data: [{ b64_json: PNG }] }), {
        headers: { 'content-type': 'application/json' },
      }));
      vi.stubGlobal('fetch', fetchMock);
      const messages = [{ role: 'user', participant: 'User', content: [text('make it blue'), form('image', PNG, 'image/png')] }];
      const before = structuredClone(messages);
      await new OpenAIResponsesAdapter({ apiKey: 'test', promptFormat: 'transcript' })
        .complete({ model: 'gpt-image-1', maxTokens: 64, messages } as ProviderRequest);
      expect(messages).toEqual(before);
      const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
      // A generation, with no image to edit, goes as JSON; an edit as a form with the image.
      if (!(init.body instanceof FormData)) return { url, prompt: JSON.parse(String(init.body)).prompt, image: null };
      const file = init.body.get('image[]') as File | null;
      return { url, prompt: init.body.get('prompt'), image: file && Buffer.from(await file.arrayBuffer()).toString('base64') };
    };
    const handed = await sent(mcp);
    expect(handed).toEqual(await sent(ours));
    expect(handed.url).toContain('images/edits');
    expect(handed.image).toBe(PNG);
    expect(handed.prompt).toContain('[Image 1]');
  });

  it.each([
    ['the anthropic-xml formatter, xml tool mode', () => new AnthropicXmlFormatter({ unsupportedMedia: 'strip' }), 'xml'],
    ['the anthropic-xml formatter, native tool mode', () => new AnthropicXmlFormatter(), 'native'],
    ['the native formatter', () => new NativeFormatter(), undefined],
    ['the Responses formatter', () => new OpenAIResponsesFormatter(), undefined],
    ['the completions formatter', () => new CompletionsFormatter(), undefined],
  ] as const)('%s called directly builds MCP\'s form as it builds membrane\'s, at the top of a message and in a tool_result', (_name, make, toolMode) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const options = { participantMode: 'simple', assistantParticipant: 'Claude', humanParticipant: 'User', ...(toolMode ? { toolMode, tools: [noop] } : {}) } as any;
    const handed = history(mcp);
    const before = structuredClone(handed);
    const built = make().buildMessages(handed, options);
    expect(JSON.stringify(built)).toBe(JSON.stringify(make().buildMessages(history(ours), options)));
    expect(handed).toEqual(before);
  });

  it('the exported converters toAnthropicContent and transformToChat, at the top of a turn and in a tool_result', () => {
    const turn = (form: Form) => [
      text('look'), form('image', PNG, 'image/png'), form('document', PDF, 'application/pdf'),
      { type: 'tool_result', toolUseId: 'shot', content: [text('here'), form('image', PNG, 'image/png')] },
    ];
    const handed = turn(mcp);
    const before = structuredClone(handed);
    const anthropic = toAnthropicContent(handed as ContentBlock[], { role: 'user' });
    expect(anthropic).toEqual(toAnthropicContent(turn(ours) as ContentBlock[], { role: 'user' }));
    expect(anthropic[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } });
    expect(anthropic[3]).toMatchObject({ type: 'tool_result', content: [text('here'), { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }] });
    const chat = (content: unknown[]) => transformToChat({ messages: [{ participant: 'User', content }], config } as NormalizedRequest);
    expect(chat(handed)).toEqual(chat(turn(ours)));
    expect(chat(handed).messages[0]!.content[1]).toEqual({ type: 'image', source: { type: 'base64', data: PNG, mediaType: 'image/png' } });
    expect(handed).toEqual(before);
  });

  it('the exported xml result renderers, which take an xml tool loop\'s results each round', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const results = (form: Form) => [
      { toolUseId: 'a', toolName: 'noop', content: [text('first'), form('image', PNG, 'image/png')] },
      { toolUseId: 'b', toolName: 'noop', content: [text('second'), form('image', PNG, 'image/png'), form('image', SVG, 'image/svg+xml')] },
    ] as ToolResult[];
    const handed = results(mcp);
    const before = structuredClone(handed);
    expect(formatToolResults(handed)).toBe(formatToolResults(results(ours)));
    expect(formatToolResults(handed)).toContain('[Image: image/png, ~0KB, not shown to you]');
    const split = formatToolResultsForSplitTurn(handed);
    expect(split).toEqual(formatToolResultsForSplitTurn(results(ours)));
    expect(split.images).toEqual([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }]);
    expect(split.afterImageXml).toContain('[Image: image/png, ~0KB, not shown to you]');
    expect(handed).toEqual(before);
  });

  it.each([
    ['stream', 'native'],
    ['stream', 'xml'],
    ['streamYielding', 'native'],
    ['streamYielding', 'xml'],
  ] as const)('%s() in %s tool mode: a tool loop\'s history and its executor\'s results, round by round', async (method, toolMode) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const run = async (form: Form) => {
      const adapter = new ScriptedAnthropic(toolMode, 2);
      const request: NormalizedRequest = { messages: history(form), tools: [noop], toolMode, config, promptCaching: false };
      const before = structuredClone(request.messages);
      const result = await turn(method, new Membrane(adapter), request, (id) => [
        { toolUseId: id, content: [text('shot'), form('image', PNG, 'image/png'), form('image', SVG, 'image/svg+xml')] },
      ]);
      expect(request.messages).toEqual(before);
      return { ...result, sent: adapter.sent };
    };
    const asMcp = await run(mcp);
    const asOurs = await run(ours);
    expect(asMcp.sent).toHaveLength(3);
    expect(asMcp.sent).toEqual(asOurs.sent);
    expect(asMcp.rounds).toEqual(asOurs.rounds);
    expect(asMcp.response.toolResults).toHaveLength(asMcp.given.flat().length);
    expect(asMcp.contexts[1]!.previousResults[0]).toBe(asMcp.given[0]![0]);
    expect((asMcp.given[0]![0]!.content as any[])[1]).toEqual(mcp('image', PNG, 'image/png'));
    if (toolMode === 'native') {
      asMcp.response.toolResults.forEach((result: ToolResult, i: number) => expect(result).toBe(asMcp.given.flat()[i]));
    } else {
      asMcp.response.toolResults.forEach((result: ToolResult, i: number) => expect(result.content).toEqual(asMcp.given.flat()[i]!.content));
    }
  });
});

describe('an image in MCP\'s form with no mimeType is sent as the same image with one, since every request that sends an image decides it by its header', () => {
  const png = (labelled: boolean) => (labelled ? mcp('image', PNG, 'image/png') : { type: 'image', data: PNG });
  const holding = (labelled: boolean): NormalizedMessage[] => [
    { participant: 'User', content: [text('look'), png(labelled)] },
    { participant: 'Claude', content: [{ type: 'tool_use', id: 'shot', name: 'noop', input: {} }] },
    { participant: 'User', content: [{ type: 'tool_result', toolUseId: 'shot', content: [text('here'), png(labelled)] }] },
    { participant: 'User', content: [text('go on')] },
  ] as NormalizedMessage[];

  it.each([
    ['the anthropic-xml formatter, xml tool mode', () => ({ adapter: new ScriptedAnthropic('xml'), formatter: new AnthropicXmlFormatter(), toolMode: 'xml' })],
    ['the anthropic-xml formatter, native tool mode', () => ({ adapter: new ScriptedAnthropic('native'), formatter: new AnthropicXmlFormatter(), toolMode: 'native' })],
    ['the native formatter', () => ({ adapter: new ScriptedAnthropic('native'), formatter: new NativeFormatter(), toolMode: 'native' })],
    ['the Responses formatter', () => ({ adapter: new ScriptedResponses(), formatter: new OpenAIResponsesFormatter(), toolMode: undefined })],
  ] as const)('through %s', async (_name, setup) => {
    const run = async (labelled: boolean) => {
      const { adapter, formatter, toolMode } = setup();
      const request = { messages: holding(labelled), config, promptCaching: false, ...(toolMode ? { toolMode, tools: [noop] } : {}) } as NormalizedRequest;
      const { rounds } = await turn('streamYielding', new Membrane(adapter as ProviderAdapter, { formatter }), request);
      return { rounds, sent: adapter.sent };
    };
    const unlabelled = await run(false);
    expect(unlabelled).toEqual(await run(true));
    expect(JSON.stringify(unlabelled.sent)).toContain(PNG);
  });

  it('the Anthropic adapter\'s request built directly, and the xml result renderers', () => {
    const adapter = new AnthropicAdapter({ apiKey: 'test', cacheKeepalive: { enabled: false } }) as any;
    const built = (labelled: boolean) => adapter.buildRequest({ model: 'claude-sonnet-4-5', maxTokens: 64, messages: [
      { role: 'user', content: [text('look'), png(labelled)] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'shot', name: 'noop', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'shot', content: [text('here'), png(labelled)] }] },
    ] }).messages;
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } };
    expect(built(false)).toEqual(built(true));
    expect(built(false)[0].content[1]).toEqual(image);
    expect(built(false)[2].content[0].content[1]).toEqual(image);
    const results = (labelled: boolean) => [{ toolUseId: 'a', toolName: 'noop', content: [text('shot'), png(labelled)] }] as ToolResult[];
    expect(formatToolResults(results(false))).toBe(formatToolResults(results(true)));
    expect(formatToolResultsForSplitTurn(results(false))).toEqual(formatToolResultsForSplitTurn(results(true)));
    expect(formatToolResultsForSplitTurn(results(false)).images).toEqual([image]);
  });
});

describe('a round with media in MCP\'s form reports what the same round in membrane\'s form reports', () => {
  it.each([
    ['the anthropic-xml formatter, xml tool mode', () => ({ adapter: new ScriptedAnthropic('xml'), formatter: new AnthropicXmlFormatter(), toolMode: 'xml' })],
    ['the anthropic-xml formatter, native tool mode', () => ({ adapter: new ScriptedAnthropic('native'), formatter: new AnthropicXmlFormatter(), toolMode: 'native' })],
    ['the native formatter', () => ({ adapter: new ScriptedAnthropic('native'), formatter: new NativeFormatter(), toolMode: 'native' })],
    ['the Responses formatter', () => ({ adapter: new ScriptedResponses(), formatter: new OpenAIResponsesFormatter(), toolMode: undefined })],
    ['the completions formatter', () => ({ adapter: new Recording(), formatter: new CompletionsFormatter(), toolMode: undefined })],
  ] as const)('%s', async (_name, setup) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const run = async (form: Form) => {
      const { adapter, formatter, toolMode } = setup();
      const request = { messages: history(form, { audioAtTop: toolMode !== 'xml' }), config, promptCaching: false, ...(toolMode ? { toolMode, tools: [noop] } : {}) } as NormalizedRequest;
      const { rounds } = await turn('streamYielding', new Membrane(adapter as ProviderAdapter, { formatter }), request);
      return { rounds, sent: adapter.sent };
    };
    const asMcp = await run(mcp);
    expect(asMcp.rounds).toEqual((await run(ours)).rounds);
    expect(asMcp.rounds).toHaveLength(1);
    expect(asMcp.rounds[0]!.fidelity).toBe('established');
    expect(asMcp.rounds[0]!.altered.messages.length).toBeGreaterThan(0);
  });
});

describe('an image in MCP\'s form with empty data, or none, gets the note the same image in membrane\'s form gets, through each formatter and the Anthropic adapter\'s direct build', () => {
  const NO_DATA = '[system: an image that belongs here was NOT shown to you — it came without its data. You are not seeing this image.]';
  /** Empty data, which the API refuses as an image ("image cannot be empty"), and none. */
  const blank = (form: Form) => [form('image', '', 'image/png'), form('image', undefined as unknown as string, 'image/png')];
  const count = (sent: string, note: string) => sent.split(JSON.stringify(note).slice(1, -1)).length - 1;

  it.each([
    ['the anthropic-xml formatter, xml tool mode', () => ({ adapter: new ScriptedAnthropic('xml'), formatter: new AnthropicXmlFormatter(), toolMode: 'xml' })],
    ['the anthropic-xml formatter, native tool mode', () => ({ adapter: new ScriptedAnthropic('native'), formatter: new AnthropicXmlFormatter(), toolMode: 'native' })],
    ['the native formatter', () => ({ adapter: new ScriptedAnthropic('native'), formatter: new NativeFormatter(), toolMode: 'native' })],
    ['the Responses formatter', () => ({ adapter: new ScriptedResponses(), formatter: new OpenAIResponsesFormatter(), toolMode: undefined })],
  ] as const)('%s', async (_name, setup) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runs = await Promise.all(FORMS.map(async ([, form]) => {
      const { adapter, formatter, toolMode } = setup();
      const messages = [
        { participant: 'User', content: [text('look'), ...blank(form)] },
        { participant: 'Claude', content: [{ type: 'tool_use', id: 'shot', name: 'noop', input: {} }] },
        { participant: 'User', content: [{ type: 'tool_result', toolUseId: 'shot', content: [text('here'), ...blank(form)] }] },
        { participant: 'User', content: [text('go on')] },
      ] as NormalizedMessage[];
      const request = { messages, config, promptCaching: false, ...(toolMode ? { toolMode, tools: [noop] } : {}) } as NormalizedRequest;
      const { rounds } = await turn('streamYielding', new Membrane(adapter as ProviderAdapter, { formatter }), request);
      return { sent: JSON.stringify(adapter.sent), rounds };
    }));
    expect(runs[0]!.sent).toBe(runs[1]!.sent);
    expect(runs[0]!.rounds).toEqual(runs[1]!.rounds);
    expect(count(runs[0]!.sent, NO_DATA)).toBe(4);
    expect(runs[0]!.sent).not.toContain('"data":""');
  });

  it('the Anthropic adapter\'s request built directly, at the top of a message and in a tool_result', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const adapter = new AnthropicAdapter({ apiKey: 'test', cacheKeepalive: { enabled: false } }) as any;
    const wire = (form: Form) => [
      { role: 'user', content: [text('look'), ...blank(form)] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'shot', name: 'noop', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'shot', content: [text('here'), ...blank(form)] }] },
    ];
    const built = adapter.buildRequest({ model: 'claude-sonnet-4-5', maxTokens: 64, messages: wire(mcp) });
    expect(built.messages).toEqual(adapter.buildRequest({ model: 'claude-sonnet-4-5', maxTokens: 64, messages: wire(ours) }).messages);
    expect(built.messages[0].content).toEqual([text('look'), text(NO_DATA), text(NO_DATA)]);
    expect(built.messages[2].content[0].content).toEqual([text('here'), text(NO_DATA), text(NO_DATA)]);
  });
});

describe('a media block with no source object that doesn\'t convert is a source each reader can\'t represent', () => {
  const NO_DATA = '[system: an image that belongs here was NOT shown to you — it came without its data. You are not seeing this image.]';
  const LINK = "[system: an image that belongs here was NOT shown to you — it came as a link (https://example.com/a.png), which tool results here can't carry. You are not seeing this image.]";
  const unconvertible = () => [
    { type: 'audio', data: WAV }, { type: 'audio', data: WAV, mimeType: '' },
    { type: 'audio', mimeType: 'audio/wav' }, { type: 'audio', data: '', mimeType: 'audio/wav' },
  ];
  const holding = (): NormalizedMessage[] => [
    { participant: 'User', content: [text('look'), ...unconvertible()] },
    { participant: 'Claude', content: [{ type: 'tool_use', id: 'shot', name: 'noop', input: {} }] },
    { participant: 'User', content: [{ type: 'tool_result', toolUseId: 'shot', content: [text('here'), ...unconvertible()] }] },
    { participant: 'User', content: [text('go on')] },
  ] as NormalizedMessage[];

  it.each([
    ['the anthropic-xml formatter, xml tool mode', () => ({ adapter: new ScriptedAnthropic('xml'), formatter: new AnthropicXmlFormatter({ unsupportedMedia: 'strip' }), toolMode: 'xml' })],
    ['the anthropic-xml formatter, native tool mode', () => ({ adapter: new ScriptedAnthropic('native'), formatter: new AnthropicXmlFormatter(), toolMode: 'native' })],
    ['the native formatter', () => ({ adapter: new ScriptedAnthropic('native'), formatter: new NativeFormatter(), toolMode: 'native' })],
    ['the Responses formatter', () => ({ adapter: new ScriptedResponses(), formatter: new OpenAIResponsesFormatter(), toolMode: undefined })],
  ] as const)('%s: builds, leaves them out, and reports both messages', async (_name, setup) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { adapter, formatter, toolMode } = setup();
    const request = { messages: holding(), config, promptCaching: false, ...(toolMode ? { toolMode, tools: [noop] } : {}) } as NormalizedRequest;
    const { rounds } = await turn('streamYielding', new Membrane(adapter as ProviderAdapter, { formatter }), request);
    expect(rounds[0]!.fidelity).toBe('established');
    expect(rounds[0]!.altered.messages).toEqual([0, 2]);
    const sent = JSON.stringify(adapter.sent);
    expect(sent).not.toContain(JSON.stringify(NO_DATA).slice(1, -1));
    expect(sent).not.toMatch(/"type":"(image|audio)","(data|mimeType)"/);
    expect(sent).not.toMatch(/"type":"(image|audio)"\}/);
    expect(sent).not.toContain('"data":""');
  });

  it('a formatter called directly takes an image with no source object and neither of MCP\'s fields, someone else\'s shape, at the top of a message as such a source', () => {
    const messages = [{ participant: 'User', content: [text('look'), { type: 'image' }] }] as NormalizedMessage[];
    for (const formatter of [new AnthropicXmlFormatter(), new NativeFormatter(), new OpenAIResponsesFormatter()]) {
      const sent = JSON.stringify(formatter.buildMessages(messages, { participantMode: 'simple', assistantParticipant: 'Claude', humanParticipant: 'User' } as any).messages);
      expect(sent).toContain('look');
      expect(sent).not.toMatch(/"type":"(image|input_image|image_url)"/);
    }
  });

  it('the Anthropic adapter built directly leaves them out, at the top of a message and in a tool_result, and reports each block it was handed', () => {
    const adapter = new AnthropicAdapter({ apiKey: 'test', cacheKeepalive: { enabled: false } }) as any;
    const top = unconvertible();
    const result = { type: 'tool_result', tool_use_id: 'shot', content: [text('here'), mcp('image', PNG, 'image/png'), ...unconvertible()] };
    const reported: unknown[] = [];
    const built = adapter.buildRequest({ model: 'claude-sonnet-4-5', maxTokens: 64, messages: [
      { role: 'user', content: [text('look'), ...top] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'shot', name: 'noop', input: {} }] },
      { role: 'user', content: [result] },
    ] }, (block: unknown) => reported.push(block));
    expect(built.messages[0].content).toEqual([text('look')]);
    expect(built.messages[2].content[0].content).toEqual([
      text('here'), { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
    ]);
    expect(reported).toHaveLength(top.length + 1);
    top.forEach((block, i) => expect(reported[i]).toBe(block));
    expect(reported[top.length]).toBe(result);
  });

  it('Bedrock built directly leaves them out, at the top of a message and in a tool_result, and reports each block it was handed', () => {
    const adapter = new BedrockAdapter({ accessKeyId: 'x', secretAccessKey: 'y', region: 'us-east-1' }) as any;
    const top = unconvertible();
    const result = { type: 'tool_result', tool_use_id: 'shot', content: [text('here'), mcp('image', PNG, 'image/png'), ...unconvertible()] };
    const reported: unknown[] = [];
    const built = adapter.buildRequest({ model: 'claude-sonnet-4-5', maxTokens: 64, messages: [
      { role: 'user', content: [text('look'), ...top, mcp('image', PNG, 'image/png')] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'shot', name: 'noop', input: {} }] },
      { role: 'user', content: [result] },
    ] }, undefined, (block: unknown) => reported.push(block));
    const image = { type: 'image', source: { type: 'base64', data: PNG, media_type: 'image/png' } };
    expect(built.messages[0].content).toEqual([text('look'), image]);
    expect(built.messages[2].content[0].content).toEqual([text('here'), image]);
    expect(reported).toHaveLength(top.length + 1);
    top.forEach((block, i) => expect(reported[i]).toBe(block));
    expect(reported[top.length]).toBe(result);
  });

  it('the exported converters leave out an image with no source object and neither of MCP\'s fields, where they threw, at the top of a turn and in a tool_result', () => {
    const others = [{ type: 'image' }, { type: 'image', image_url: 'https://example.com/a.png' }];
    const content = [text('look'), ...others, { type: 'tool_result', toolUseId: 'shot', content: [text('here'), ...others] }] as ContentBlock[];
    expect(toAnthropicContent(content, { role: 'user' })).toEqual([
      text('look'), { type: 'tool_result', tool_use_id: 'shot', content: [text('here')], is_error: undefined },
    ]);
    const chat = transformToChat({ messages: [{ participant: 'User', content }], config } as NormalizedRequest);
    expect(chat.messages[0]!.content.map((part) => part.type)).toEqual(['text', 'tool_result']);
  });

  it('toAnthropicContent leaves out a document that doesn\'t convert, where it threw, and audio that doesn\'t meets the error audio meets in membrane\'s form', () => {
    const documents = [{ type: 'document', data: PDF }, { type: 'document', mimeType: 'application/pdf' }];
    const content = [
      text('look'), ...documents,
      { type: 'tool_result', toolUseId: 'shot', content: [text('here'), ...documents, ...unconvertible()] },
    ] as ContentBlock[];
    expect(toAnthropicContent(content, { role: 'user' })).toEqual([
      text('look'), { type: 'tool_result', tool_use_id: 'shot', content: [text('here')], is_error: undefined },
    ]);
    // No Anthropic block carries audio, in either form.
    const refusal = (block: unknown) => {
      try {
        toAnthropicContent([text('look'), block] as ContentBlock[], { role: 'user' });
      } catch (error) {
        return (error as Error).message;
      }
      return 'no error';
    };
    for (const block of unconvertible()) expect(refusal(block)).toBe(refusal(ours('audio', WAV, 'audio/wav')));
    expect(refusal(ours('audio', WAV, 'audio/wav'))).toContain('Anthropic has no representation for a "audio" content block');
  });

  it.each([
    ['the Anthropic adapter', (messages: unknown[], report: (block: unknown) => void) =>
      (new AnthropicAdapter({ apiKey: 'test', cacheKeepalive: { enabled: false } }) as any)
        .buildRequest({ model: 'claude-sonnet-4-5', maxTokens: 64, messages }, report)],
    ['Bedrock', (messages: unknown[], report: (block: unknown) => void) =>
      (new BedrockAdapter({ accessKeyId: 'x', secretAccessKey: 'y', region: 'us-east-1' }) as any)
        .buildRequest({ model: 'claude-sonnet-4-5', maxTokens: 64, messages }, undefined, report)],
  ])('%s built directly drops a message it left empty, and refuses when that message was the last, since the final role would change', (_name, build) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lone = { type: 'audio', data: WAV };
    const reported: unknown[] = [];
    const built = build([
      { role: 'user', content: [lone] },
      { role: 'assistant', content: [text('ok')] },
      { role: 'user', content: [text('next')] },
    ], (block: unknown) => reported.push(block));
    expect(built.messages).toEqual([{ role: 'assistant', content: [text('ok')] }, { role: 'user', content: [text('next')] }]);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toBe(lone);
    expect(() => build([
      { role: 'user', content: [text('look')] },
      { role: 'assistant', content: [text('ok')] },
      { role: 'user', content: [{ type: 'audio', data: WAV }] },
    ], () => {})).toThrow("Removing empty final user content would change the request's final role to assistant.");
  });

  const unshowable = { toolUseId: 't', content: [
    text('here'), { type: 'image' },
    { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
    { type: 'image', source: { type: 'base64', mediaType: 'image/png' } },
    { type: 'image', source: { type: 'base64', data: '', mediaType: 'image/png' } },
  ] } as ToolResult;
  const shown = { toolUseId: 's', content: [text('shot'), ours('image', PNG, 'image/png')] } as ToolResult;
  const count = (xml: string, note: string) => xml.split(note).length - 1;
  it.each([
    ['formatToolResults', () => formatToolResults([unshowable])],
    ['formatToolResultsForSplitTurn', () => formatToolResultsForSplitTurn([unshowable]).beforeImageXml],
    ['formatToolResultsForSplitTurn, after the split', () => formatToolResultsForSplitTurn([shown, unshowable]).afterImageXml],
  ] as const)('%s, which takes an xml tool loop\'s results, notes them, and any other image it has no data for', (_name, render) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const xml = render();
    expect(count(xml, NO_DATA)).toBe(3);
    expect(count(xml, LINK)).toBe(1);
  });
});

describe('the note for an image that came without its data', () => {
  it('says so, in a tool result, where it gave the note for data that is no accepted image; one with data and no type is decided by its header', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = new NativeFormatter().buildMessages([
      { participant: 'User', content: [text('shoot')] },
      { participant: 'Claude', content: [{ type: 'tool_use', id: 'shot', name: 'noop', input: {} }] },
      { participant: 'User', content: [{ type: 'tool_result', toolUseId: 'shot', content: [{ type: 'image' }, { type: 'image', data: PNG }] }] },
    ] as NormalizedMessage[], { participantMode: 'simple', assistantParticipant: 'Claude', humanParticipant: 'User' } as any);
    const nested = (result.messages as any[])[2].content[0].content;
    expect(nested[0]).toEqual({ type: 'text', text: '[system: an image that belongs here was NOT shown to you — it came without its data. You are not seeing this image.]' });
    expect(nested[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } });
    expect(warn.mock.calls.map((call) => call[0])).toEqual(['[membrane] image block stripped: no data']);
  });

  it('and one that came as a link, which an xml result can\'t send, says that and gives an http link, cut when long, where the split gave the note for data that is no accepted image', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const link = (url: unknown) => ({ type: 'image', source: { type: 'url', url } }) as any;
    const long = `https://example.com/${'a'.repeat(3000)}`;
    const NOTED_LINK_CHARS = 2048;
    const astride = `https://example.com/${'a'.repeat(NOTED_LINK_CHARS - 'https://example.com/'.length - 1)}\u{1F600}${'b'.repeat(10)}`;
    const halved = 'https://example.com/a\uD83Db.png';
    const xml = formatToolResultsForSplitTurn([{ toolUseId: 'u', content: [
      link('https://example.com/a.png'), link('ftp://example.com/a.png'), link(undefined), link(long), link(astride), link(halved),
    ] }]).beforeImageXml;
    const notes = xml.match(/\[system: an image that belongs here was NOT shown to you[^\]]*\]/g);
    expect(notes).toEqual([
      "[system: an image that belongs here was NOT shown to you — it came as a link (https://example.com/a.png), which tool results here can't carry. You are not seeing this image.]",
      "[system: an image that belongs here was NOT shown to you — it came as a link, which tool results here can't carry. You are not seeing this image.]",
      "[system: an image that belongs here was NOT shown to you — it came as a link, which tool results here can't carry. You are not seeing this image.]",
      `[system: an image that belongs here was NOT shown to you — it came as a link (${long.slice(0, 2048)}…), which tool results here can't carry. You are not seeing this image.]`,
      // Cut between code points: the API refuses a request's JSON holding half a pair.
      `[system: an image that belongs here was NOT shown to you — it came as a link (${astride.slice(0, NOTED_LINK_CHARS - 1)}…), which tool results here can't carry. You are not seeing this image.]`,
      "[system: an image that belongs here was NOT shown to you — it came as a link, which tool results here can't carry. You are not seeing this image.]",
    ]);
    expect(warn.mock.calls.map((call) => call[0])).toEqual(Array(6).fill("[membrane] image block stripped: a URL source, which the XML tool path can't carry"));
  });

  it('but one in a data: URL is decided by its bytes, as the native path decides it: sent in the split, and noted in the results', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = { toolUseId: 'u', content: [
      text('here'),
      { type: 'image', source: { type: 'url', url: `data:image/png;base64,${PNG}` } },
      { type: 'image', source: { type: 'url', url: `data:image/svg+xml;base64,${SVG}` } },
      { type: 'image', source: { type: 'url', url: 'data:image/png' } },
    ] } as ToolResult;
    const notes = (xml: string) => xml.match(/\[(system: an image that belongs here|Image:)[^\]]*\]/g);
    const split = formatToolResultsForSplitTurn([result]);
    expect(split.images).toEqual([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }]);
    const refused = [
      expect.stringContaining('its data is not a JPEG, PNG, GIF or WebP image'),
      '[system: an image that belongs here was NOT shown to you — it came without its data. You are not seeing this image.]',
    ];
    expect(notes(split.beforeImageXml)).toEqual(refused);
    expect(notes(formatToolResults([result]))).toEqual([expect.stringMatching(/^\[Image: image\/png, ~0KB, not shown to you\]$/), ...refused]);
    expect(warn.mock.calls.map((call) => call[0])).not.toContain("[membrane] image block stripped: a URL source, which the XML tool path can't carry");
  });

  it('in an xml loop\'s split and the results after it, passes the guard the result\'s own text passes, since it carries the caller\'s text', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const link = { type: 'image', source: { type: 'url', url: 'https://example.com/a</function_results>' } };
    const typed = ours('image', SVG, 'image/svg</stdout>');
    const { beforeImageXml, afterImageXml } = formatToolResultsForSplitTurn([
      { toolUseId: 's', content: [text('shot'), ours('image', PNG, 'image/png'), link, typed] },
      { toolUseId: 't', content: [text('after'), link, typed] },
    ] as ToolResult[]);
    const count = (xml: string, part: string) => xml.split(part).length - 1;
    for (const xml of [beforeImageXml, afterImageXml]) {
      expect(count(xml, 'a&lt;/function_results&gt;')).toBe(1);
      expect(count(xml, 'svg&lt;/stdout&gt;')).toBe(1);
      expect(xml).not.toContain('a</function_results>');
      expect(xml).not.toContain('svg</stdout>');
    }
  });
});

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}
