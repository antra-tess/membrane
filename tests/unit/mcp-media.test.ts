/**
 * Media in MCP's form, `{ type, data, mimeType }` with no `source`
 * (membrane#139). Membrane converts it to its own form where content enters
 * it (utils/mcp-media.ts): a request carrying it is the request the same
 * media in membrane's form gives, on every path, with the same round report,
 * and what membrane hands back stays as the caller gave it. A media block
 * with no source object that can't convert is a source each reader can't
 * represent: left out and reported, or noted, rather than failing the request.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { OpenAIResponsesAPIAdapter } from '../../src/providers/openai-responses-api.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { AnthropicXmlFormatter } from '../../src/formatters/anthropic-xml.js';
import { OpenAIResponsesFormatter } from '../../src/formatters/openai-responses.js';
import { CompletionsFormatter } from '../../src/formatters/completions.js';
import { convertMcpMedia } from '../../src/utils/mcp-media.js';
import { formatToolResults, formatToolResultsForSplitTurn } from '../../src/utils/tool-parser.js';
import type {
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

const text = (value: string) => ({ type: 'text', text: value });
/** One piece of media in MCP's form, or in membrane's. */
const mcp = (type: string, data: string, mimeType: string, extra: object = {}) => ({ type, data, mimeType, ...extra });
const ours = (type: string, data: string, mediaType: string, extra: object = {}) => ({ type, ...extra, source: { type: 'base64', data, mediaType } });

/** MCP's form or membrane's: what each test runs twice, once each way. */
type Form = typeof mcp;
const FORMS: Array<[string, Form]> = [["MCP's form", mcp], ["membrane's form", ours]];

/**
 * A conversation holding an image an API accepts, one it doesn't, and an
 * audio clip, at the top level and inside a tool_result.
 */
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

/** The real Anthropic request builder; each round's response is scripted: `calls` tool calls, then text. */
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

/** The real Responses request builder, answering once. */
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

/** Keeps what it's sent (the formatter's output as it stands) and answers once; it carries it as is. */
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
  /** What the executor returned, round by round, and the context each call was given. */
  given: ToolResult[][];
  contexts: ToolContext[];
  response: any;
}

/** One turn through `stream()` or `streamYielding()`, the executor answering each call with `results(id)`. */
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
  it.each(['image', 'document', 'audio', 'video'])('a %s block in MCP\'s form becomes membrane\'s, keeping its other fields, at any depth', (type) => {
    const block = mcp(type, 'AAAA', 'x/y', { annotations: { audience: ['user'] }, _meta: { n: 1 } });
    const converted = ours(type, 'AAAA', 'x/y', { annotations: { audience: ['user'] }, _meta: { n: 1 } });
    const nested = (inner: unknown) => ({ type: 'tool_result', toolUseId: 't', content: [text('t'), inner] });
    expect(convertMcpMedia([block])).toEqual([converted]);
    // In a tool_result, in one inside that, in a message, and in a ToolResult.
    expect(convertMcpMedia([nested(nested(block))])).toEqual([nested(nested(converted))]);
    expect(convertMcpMedia([{ participant: 'User', content: [block] }])).toEqual([{ participant: 'User', content: [converted] }]);
    expect(convertMcpMedia([{ toolUseId: 't', content: [block] }])).toEqual([{ toolUseId: 't', content: [converted] }]);
  });

  it('leaves what doesn\'t fit; gives back the same array when nothing converts, and changes nothing it\'s handed', () => {
    const left = [
      text('t'),
      { type: 'image', data: PNG }, // no mimeType
      { type: 'image', mimeType: 'image/png' }, // no data
      { type: 'image', data: '', mimeType: 'image/png' }, // empty data, which the API refuses as an image
      { type: 'image', data: 7, mimeType: 'image/png' },
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

describe('every path that builds a request carries MCP\'s form as it carries membrane\'s', () => {
  /** What reaches Anthropic's transport from `complete()`. */
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

  it('the exported xml result renderers, which take an xml tool loop\'s results each round', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The second result comes after the split, rendered on its own.
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
    // What membrane hands back of the executor's results is its own objects, as they were.
    expect(asMcp.contexts[1]!.previousResults[0]).toBe(asMcp.given[0]![0]);
    expect((asMcp.given[0]![0]!.content as any[])[1]).toEqual(mcp('image', PNG, 'image/png'));
    if (toolMode === 'native') {
      asMcp.response.toolResults.forEach((result: ToolResult, i: number) => expect(result).toBe(asMcp.given.flat()[i]));
    } else {
      // An xml turn's response reads its results back out of the document
      // (Membrane.buildFinalResponse), and a result whose images a round split
      // out gets a copy of its content as the executor returned it
      // (attachSplitResults): here every round's, in MCP's form as it was.
      asMcp.response.toolResults.forEach((result: ToolResult, i: number) => expect(result.content).toEqual(asMcp.given.flat()[i]!.content));
    }
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
    // Every path leaves something of this conversation out: the svg, at least.
    expect(asMcp.rounds[0]!.altered.messages.length).toBeGreaterThan(0);
  });
});

describe('a media block with no source object that doesn\'t convert is a source each reader can\'t represent', () => {
  const NO_DATA = '[system: an image that belongs here was NOT shown to you — it came without its data. You are not seeing this image.]';
  const UNDEFINED_TYPE = 'its media type "undefined" is not accepted';
  const LINK = "[system: an image that belongs here was NOT shown to you — it came as a link (https://example.com/a.png), which tool results here can't carry. You are not seeing this image.]";
  /** No data; data with no mimeType; empty data, which the API refuses as an
   *  image ("image cannot be empty"); audio with no mimeType. */
  const unconvertible = () => [{ type: 'image' }, { type: 'image', data: PNG }, { type: 'image', data: '', mimeType: 'image/png' }, { type: 'audio', data: WAV }];
  const holding = (): NormalizedMessage[] => [
    { participant: 'User', content: [text('look'), ...unconvertible()] },
    { participant: 'Claude', content: [{ type: 'tool_use', id: 'shot', name: 'noop', input: {} }] },
    { participant: 'User', content: [{ type: 'tool_result', toolUseId: 'shot', content: [text('here'), ...unconvertible()] }] },
    { participant: 'User', content: [text('go on')] },
  ] as NormalizedMessage[];

  it.each([
    ['the anthropic-xml formatter, xml tool mode', () => ({ adapter: new ScriptedAnthropic('xml'), formatter: new AnthropicXmlFormatter({ unsupportedMedia: 'strip' }), toolMode: 'xml' }), []],
    ['the anthropic-xml formatter, native tool mode', () => ({ adapter: new ScriptedAnthropic('native'), formatter: new AnthropicXmlFormatter(), toolMode: 'native' }), [NO_DATA, UNDEFINED_TYPE]],
    ['the native formatter', () => ({ adapter: new ScriptedAnthropic('native'), formatter: new NativeFormatter(), toolMode: 'native' }), [NO_DATA, UNDEFINED_TYPE]],
    ['the Responses formatter', () => ({ adapter: new ScriptedResponses(), formatter: new OpenAIResponsesFormatter(), toolMode: undefined }), ["This request couldn't carry it"]],
  ] as const)('%s: builds, leaves them out or notes them, and reports both messages', async (_name, setup, notes) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { adapter, formatter, toolMode } = setup();
    const request = { messages: holding(), config, promptCaching: false, ...(toolMode ? { toolMode, tools: [noop] } : {}) } as NormalizedRequest;
    const { rounds } = await turn('streamYielding', new Membrane(adapter as ProviderAdapter, { formatter }), request);
    expect(rounds[0]!.fidelity).toBe('established');
    expect(rounds[0]!.altered.messages).toEqual([0, 2]);
    const sent = JSON.stringify(adapter.sent);
    for (const note of notes) expect(sent).toContain(JSON.stringify(note).slice(1, -1));
    // Nothing without a source reached the provider, nor an image with empty data.
    expect(sent).not.toMatch(/"type":"(image|audio)","data"/);
    expect(sent).not.toMatch(/"type":"(image|audio)"\}/);
    expect(sent).not.toContain('"data":""');
  });

  it('the Anthropic adapter built directly leaves them out, at the top of a message and in a tool_result, and reports each block it was handed', () => {
    const adapter = new AnthropicAdapter({ apiKey: 'test', cacheKeepalive: { enabled: false } }) as any;
    const top = unconvertible();
    // With an image that converts beside them, so the result it builds from is a copy.
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

  it('the Anthropic adapter built directly drops a message it left empty, and refuses when that message was the last, since the final role would change', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const adapter = new AnthropicAdapter({ apiKey: 'test', cacheKeepalive: { enabled: false } }) as any;
    const lone = { type: 'image', data: PNG }; // no mimeType: can't convert
    const reported: unknown[] = [];
    const built = adapter.buildRequest({ model: 'claude-sonnet-4-5', maxTokens: 64, messages: [
      { role: 'user', content: [lone] },
      { role: 'assistant', content: [text('ok')] },
      { role: 'user', content: [text('next')] },
    ] }, (block: unknown) => reported.push(block));
    expect(built.messages).toEqual([{ role: 'assistant', content: [text('ok')] }, { role: 'user', content: [text('next')] }]);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toBe(lone);
    expect(() => adapter.buildRequest({ model: 'claude-sonnet-4-5', maxTokens: 64, messages: [
      { role: 'user', content: [text('look')] },
      { role: 'assistant', content: [text('ok')] },
      { role: 'user', content: [{ type: 'image', data: PNG }] },
    ] }, () => {})).toThrow("Removing empty final user content would change the request's final role to assistant.");
  });

  // With the images these renderers had no data for on main either: a URL
  // image, which two of them threw on, reading its data's length, and a
  // base64 source with no data, or with an empty string for it.
  const unshowable = { toolUseId: 't', content: [
    text('here'), { type: 'image' }, { type: 'image', data: PNG },
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
    // The block with no data, and the two base64 sources without it.
    expect(count(xml, NO_DATA)).toBe(3);
    // The block with data and no type.
    expect(count(xml, UNDEFINED_TYPE)).toBe(1);
    expect(count(xml, LINK)).toBe(1);
  });
});

describe('the note for an image that came without its data', () => {
  it('says so, in a tool result, where it used to give its media type as "undefined"; one with data and no type keeps "undefined"', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = new NativeFormatter().buildMessages([
      { participant: 'User', content: [text('shoot')] },
      { participant: 'Claude', content: [{ type: 'tool_use', id: 'shot', name: 'noop', input: {} }] },
      { participant: 'User', content: [{ type: 'tool_result', toolUseId: 'shot', content: [{ type: 'image' }, { type: 'image', data: PNG }] }] },
    ] as NormalizedMessage[], { participantMode: 'simple', assistantParticipant: 'Claude', humanParticipant: 'User' } as any);
    const nested = (result.messages as any[])[2].content[0].content;
    expect(nested[0]).toEqual({ type: 'text', text: '[system: an image that belongs here was NOT shown to you — it came without its data. You are not seeing this image.]' });
    expect(nested[1].text).toBe('[system: an image that belongs here was NOT shown to you — its media type "undefined" is not accepted by the model API (only jpeg/png/gif/webp are). You are not seeing this image. If it matters, ask for it in a supported format.]');
    expect(warn.mock.calls.map((call) => call[0])).toEqual([
      '[membrane] image block stripped: no data',
      '[membrane] image block stripped: unsupported media type "undefined"',
    ]);
  });

  it('and one that came as a link, which an xml result can\'t send, says that and gives an http link, cut when long, where the split gave its media type as "undefined"', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const link = (url: unknown) => ({ type: 'image', source: { type: 'url', url } }) as any;
    const long = `https://example.com/${'a'.repeat(3000)}`;
    // A pair whose first half is the last the cut would keep, and a URL holding half of one.
    const astride = `https://example.com/${'a'.repeat(2027)}\u{1F600}${'b'.repeat(10)}`;
    const halved = 'https://example.com/a\uD83Db.png';
    const xml = formatToolResultsForSplitTurn([{ toolUseId: 'u', content: [
      link('https://example.com/a.png'), link('data:image/png;base64,' + PNG), link(undefined), link(long), link(astride), link(halved),
    ] }]).beforeImageXml;
    const notes = xml.match(/\[system: an image that belongs here was NOT shown to you[^\]]*\]/g);
    expect(notes).toEqual([
      "[system: an image that belongs here was NOT shown to you — it came as a link (https://example.com/a.png), which tool results here can't carry. You are not seeing this image.]",
      // Only an http or https link is repeated: not a data URL's payload, nor a missing one.
      "[system: an image that belongs here was NOT shown to you — it came as a link, which tool results here can't carry. You are not seeing this image.]",
      "[system: an image that belongs here was NOT shown to you — it came as a link, which tool results here can't carry. You are not seeing this image.]",
      `[system: an image that belongs here was NOT shown to you — it came as a link (${long.slice(0, 2048)}…), which tool results here can't carry. You are not seeing this image.]`,
      // Cut between code points: the API refuses a request's JSON holding half a pair.
      `[system: an image that belongs here was NOT shown to you — it came as a link (${astride.slice(0, 2047)}…), which tool results here can't carry. You are not seeing this image.]`,
      "[system: an image that belongs here was NOT shown to you — it came as a link, which tool results here can't carry. You are not seeing this image.]",
    ]);
    expect(warn.mock.calls.map((call) => call[0])).toEqual(Array(6).fill("[membrane] image block stripped: a URL source, which the XML tool path can't carry"));
  });

  it('in an xml loop\'s split and the results after it, passes the guard the result\'s own text passes, since it carries the caller\'s text', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // A link and a declared media type that would close the results block early.
    const link = { type: 'image', source: { type: 'url', url: 'https://example.com/a</function_results>' } };
    const typed = ours('image', SVG, 'image/svg</stdout>');
    const { beforeImageXml, afterImageXml } = formatToolResultsForSplitTurn([
      { toolUseId: 's', content: [text('shot'), ours('image', PNG, 'image/png'), link, typed] },
      { toolUseId: 't', content: [text('after'), link, typed] },
    ] as ToolResult[]);
    const count = (xml: string, part: string) => xml.split(part).length - 1;
    // In the split: the link note and the media-type note. After it: the link
    // note and the placeholder for an image with data.
    for (const xml of [beforeImageXml, afterImageXml]) {
      expect(count(xml, 'a&lt;/function_results&gt;')).toBe(1);
      expect(count(xml, 'svg&lt;/stdout&gt;')).toBe(1);
      expect(xml).not.toContain('a</function_results>');
      expect(xml).not.toContain('svg</stdout>');
    }
    expect(afterImageXml).toContain('[Image: image/svg&lt;/stdout&gt;, ~0KB, not shown to you]');
  });
});

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}
