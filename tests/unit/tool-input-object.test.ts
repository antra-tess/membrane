/**
 * A tool_use block's `input` is always a plain object, and arguments that
 * weren't a JSON object are marked with `unparseableInput`.
 *
 * `ToolUseContent` types `input` as `Record<string, unknown>`, and stores and
 * callers downstream rely on it. Every adapter but Anthropic's put what it got
 * there unchecked: the OpenAI-family adapters stored whatever `JSON.parse`
 * returned (`null`, a number, a string or an array when a model's arguments
 * were one), Gemini copied `functionCall.args` as it came, and Anthropic's and
 * Bedrock's stream assemblies kept a parse that wasn't an object. Where the
 * text didn't parse, the OpenAI-family adapters and Bedrock kept `{}` with
 * nothing to tell it from a real no-argument call, which Anthropic's adapter
 * already marks (`unparseableInput`). Now every adapter gives `{}` for
 * arguments that aren't an object and keeps what came in `unparseableInput`.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { toolUseInputFromText, toolUseInputFromValue } from '../../src/providers/utils.js';
import { OpenAIAdapter, fromOpenAIContent } from '../../src/providers/openai.js';
import { OpenAICompatibleAdapter, fromOpenAIMessage } from '../../src/providers/openai-compatible.js';
import { fromOpenRouterMessage } from '../../src/providers/openrouter.js';
import { OpenAIResponsesAPIAdapter } from '../../src/providers/openai-responses-api.js';
import { GeminiAdapter, fromGeminiParts } from '../../src/providers/gemini.js';
import { AnthropicAdapter, fromAnthropicContent } from '../../src/providers/anthropic.js';
import { BedrockAdapter } from '../../src/providers/bedrock.js';
import { Membrane } from '../../src/membrane.js';
import type { ProviderAdapter, ProviderResponse } from '../../src/types/provider.js';
import type { ToolCall, ToolResult } from '../../src/types/tools.js';
import { stubFetchWithSseLines } from '../helpers/sse-fixtures.js';
import { chunkFrame, streamBody } from '../helpers/bedrock-event-stream.js';

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Argument texts that parse, but not to an object. */
const notObjects = ['null', '42', '"zz"', 'true', '[1,2]'];
const malformed = '{"path":"/zz/fld1.ts","n';

function stubFetchWithJson(body: unknown): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })));
}

const toolUseOf = (content: any[]) => content.find((b) => b.type === 'tool_use');
const openAICall = (args: string) => ({
  role: 'assistant' as const,
  content: null,
  tool_calls: [{ id: 'call_zz', type: 'function' as const, function: { name: 'zz_tool', arguments: args } }],
});

// The helper tests compare with toStrictEqual: a marker key set to undefined
// is a defect too.
describe('toolUseInputFromText', () => {
  it('keeps arguments that are a JSON object, unmarked', () => {
    expect(toolUseInputFromText('{"a":1}')).toStrictEqual({ input: { a: 1 } });
  });

  it('reads no text, empty text or whitespace as a call with no arguments, without a warning', () => {
    for (const text of [undefined, '', '  ', '\n\t']) expect(toolUseInputFromText(text)).toStrictEqual({ input: {} });
    expect(console.warn).not.toHaveBeenCalled();
  });

  it.each(notObjects)('gives {} and keeps %s, which parses to something other than an object', (text) => {
    expect(toolUseInputFromText(text)).toStrictEqual({ input: {}, unparseableInput: text });
  });

  it('gives {} and keeps text that does not parse, and logs none of it', () => {
    expect(toolUseInputFromText(malformed)).toStrictEqual({ input: {}, unparseableInput: malformed });
    expect(toolUseInputFromText('zz-secret')).toStrictEqual({ input: {}, unparseableInput: 'zz-secret' });
    const logged = vi.mocked(console.warn).mock.calls.flat().map(String).join('\n');
    expect(vi.mocked(console.warn)).toHaveBeenCalledTimes(2);
    expect(logged).not.toContain('zz-secret');
    expect(logged).not.toContain('fld1');
  });

  it('reads whitespace JSON does not allow as text that does not parse', () => {
    expect(toolUseInputFromText('\u00a0')).toStrictEqual({ input: {}, unparseableInput: '\u00a0' });
  });

  it('reads arguments that are not text as a value, and a null field as no arguments', () => {
    expect(toolUseInputFromText(null)).toStrictEqual({ input: {} });
    expect(toolUseInputFromText({ a: 1 })).toStrictEqual({ input: { a: 1 } });
    expect(toolUseInputFromText(42)).toStrictEqual({ input: {}, unparseableInput: '42' });
    expect(toolUseInputFromText([1, 2])).toStrictEqual({ input: {}, unparseableInput: '[1,2]' });
  });
});

describe('toolUseInputFromValue', () => {
  it('keeps an object, and reads no value as no arguments', () => {
    expect(toolUseInputFromValue({ a: 1 })).toStrictEqual({ input: { a: 1 } });
    expect(toolUseInputFromValue(undefined)).toStrictEqual({ input: {} });
    expect(console.warn).not.toHaveBeenCalled();
  });

  it.each([null, 42, 'zz', true, [1, 2]])('gives {} and keeps %j as JSON', (value) => {
    expect(toolUseInputFromValue(value)).toStrictEqual({ input: {}, unparseableInput: JSON.stringify(value) });
  });
});

describe('OpenAI-family converters', () => {
  const converters: Array<[string, (args: string) => any[]]> = [
    ['openai fromOpenAIContent', (args) => fromOpenAIContent(openAICall(args) as any)],
    ['openai-compatible fromOpenAIMessage', (args) => fromOpenAIMessage(openAICall(args) as any)],
    ['openrouter fromOpenRouterMessage', (args) => fromOpenRouterMessage(openAICall(args) as any)],
  ];

  describe.each(converters)('%s', (_name, convert) => {
    it.each([...notObjects, malformed])('marks arguments %s and gives {}', (args) => {
      expect(toolUseOf(convert(args))).toMatchObject({ id: 'call_zz', name: 'zz_tool', input: {}, unparseableInput: args });
    });

    it('keeps an object unmarked, and empty arguments as {}', () => {
      expect(toolUseOf(convert('{"a":1}'))).toEqual({ type: 'tool_use', id: 'call_zz', name: 'zz_tool', input: { a: 1 } });
      expect(toolUseOf(convert(''))).toEqual({ type: 'tool_use', id: 'call_zz', name: 'zz_tool', input: {} });
    });
  });

  it('marks a completion\'s call whose arguments are a number (openai-compatible)', async () => {
    stubFetchWithJson({
      id: 'zz-id',
      model: 'zz-model-1',
      choices: [{ index: 0, message: openAICall('42'), finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
    });
    const res: any = await new OpenAICompatibleAdapter({ baseURL: 'http://localhost:9/v1', apiKey: 'zz-key' }).complete(
      { model: 'zz-model-1', maxTokens: 64, messages: [{ role: 'user', content: 'zz prompt' }] } as any,
    );
    expect(toolUseOf(res.content)).toMatchObject({ id: 'call_zz', input: {}, unparseableInput: '42' });
  });

  it.each([
    [null, {}],
    [{ a: 1 }, { a: 1 }],
  ])('reads a completion\'s arguments field %j, which is not text, as a value (openai-compatible)', async (args, input) => {
    stubFetchWithJson({
      id: 'zz-id',
      model: 'zz-model-1',
      choices: [{ index: 0, message: openAICall(args as any), finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
    });
    const res: any = await new OpenAICompatibleAdapter({ baseURL: 'http://localhost:9/v1', apiKey: 'zz-key' }).complete(
      { model: 'zz-model-1', maxTokens: 64, messages: [{ role: 'user', content: 'zz prompt' }] } as any,
    );
    expect(toolUseOf(res.content)).toEqual({ type: 'tool_use', id: 'call_zz', name: 'zz_tool', input });
  });

  it('marks a streamed call whose arguments are null', async () => {
    stubFetchWithSseLines([
      '{"choices":[{"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_zz","type":"function","function":{"name":"zz_tool","arguments":""}}]}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"null"}}]}}]}',
      '{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      '[DONE]',
    ]);
    const res: any = await new OpenAIAdapter({ apiKey: 'zz-key' }).stream(
      { model: 'zz-model-1', maxTokens: 64, messages: [{ role: 'user', content: 'zz prompt' }] } as any,
      { onChunk: () => {} } as any,
    );
    expect(toolUseOf(res.content)).toMatchObject({ input: {}, unparseableInput: 'null' });
  });
});

describe('OpenAI Responses API', () => {
  it('marks a function call whose arguments are an array', async () => {
    stubFetchWithJson({
      status: 'completed',
      output: [{ type: 'function_call', id: 'fc_zz', call_id: 'call_zz', name: 'zz_tool', arguments: '[1,2]' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const res: any = await new OpenAIResponsesAPIAdapter({ apiKey: 'zz-key' }).complete(
      { model: 'gpt-zz', maxTokens: 64, messages: [{ role: 'user', content: 'zz prompt' }] } as any,
    );
    expect(toolUseOf(res.content)).toMatchObject({ id: 'call_zz', input: {}, unparseableInput: '[1,2]' });
  });

  it.each([
    [{ a: 1 }, { a: 1 }, undefined],
    [42, {}, '42'],
  ])('reads a function call whose arguments field %j is not text as a value', async (args, input, marker) => {
    stubFetchWithJson({
      status: 'completed',
      output: [{ type: 'function_call', id: 'fc_zz', call_id: 'call_zz', name: 'zz_tool', arguments: args }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const res: any = await new OpenAIResponsesAPIAdapter({ apiKey: 'zz-key' }).complete(
      { model: 'gpt-zz', maxTokens: 64, messages: [{ role: 'user', content: 'zz prompt' }] } as any,
    );
    const toolUse = toolUseOf(res.content);
    expect(toolUse.input).toStrictEqual(input);
    expect(toolUse.unparseableInput).toBe(marker);
    expect('unparseableInput' in toolUse).toBe(marker !== undefined);
  });
});

describe('Gemini', () => {
  it('gives a call without args {}, unmarked, in a completion', async () => {
    stubFetchWithJson({
      candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'zz_tool' } }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    });
    const res: any = await new GeminiAdapter({ apiKey: 'zz-key' }).complete(
      { model: 'gemini-zz', maxTokens: 64, messages: [{ role: 'user', parts: [{ text: 'zz prompt' }] }] } as any,
    );
    const toolUse = toolUseOf(res.content);
    expect(toolUse.input).toEqual({});
    expect(toolUse).not.toHaveProperty('unparseableInput');
  });

  it('fromGeminiParts marks args that are not an object, and reads null args as unset', () => {
    const toolUse = toolUseOf(fromGeminiParts([{ functionCall: { name: 'zz_tool', args: [1, 2] as any } }]));
    expect(toolUse).toMatchObject({ name: 'zz_tool', input: {}, unparseableInput: '[1,2]' });
    const unset = toolUseOf(fromGeminiParts([{ functionCall: { name: 'zz_tool', args: null as any } }]));
    expect(unset.input).toStrictEqual({});
    expect(unset).not.toHaveProperty('unparseableInput');
  });

  it.each([
    ['zz', { input: {}, unparseableInput: '"zz"' }],
    [null, { input: {} }],
  ])('gives a completion\'s call with args %j its input and marker', async (args, expected) => {
    stubFetchWithJson({
      candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'zz_tool', args } }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    });
    const res: any = await new GeminiAdapter({ apiKey: 'zz-key' }).complete(
      { model: 'gemini-zz', maxTokens: 64, messages: [{ role: 'user', parts: [{ text: 'zz prompt' }] }] } as any,
    );
    expect(toolUseOf(res.content)).toStrictEqual({ type: 'tool_use', id: expect.any(String), name: 'zz_tool', ...expected });
  });
});

function fakeAnthropicStream(events: unknown[]) {
  return {
    controller: { abort() { /* noop */ } },
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          return i < events.length ? { value: events[i++], done: false } : { value: undefined, done: true };
        },
      };
    },
  };
}

describe('Anthropic stream', () => {
  it('marks a call whose accumulated arguments parse to null, keeping content_block_start\'s {}', async () => {
    const adapter = new AnthropicAdapter({ apiKey: 'zz-key' });
    (adapter as any).client = {
      withOptions() { return this; },
      messages: {
        stream: async () => fakeAnthropicStream([
          { type: 'message_start', message: { model: 'claude-zz-1', usage: { input_tokens: 10 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_zz', name: 'zz_tool', input: {} } },
          { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'null' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
        ]),
      },
    };
    const res: any = await adapter.stream(
      { model: 'claude-zz-1', maxTokens: 64, messages: [{ role: 'user', content: [{ type: 'text', text: 'zz prompt' }] }] } as any,
      { onChunk: () => {} } as any,
    );
    expect(toolUseOf(res.content)).toMatchObject({ id: 'toolu_zz', input: {}, unparseableInput: 'null' });
  });

  it.each([
    ['zz', '"zz"'],
    [null, 'null'],
  ])('fromAnthropicContent gives an input %j that is not an object as {}, marked', (input, marker) => {
    const toolUse = toolUseOf(fromAnthropicContent([{ type: 'tool_use', id: 'toolu_zz', name: 'zz_tool', input } as any]));
    expect(toolUse).toStrictEqual({ type: 'tool_use', id: 'toolu_zz', name: 'zz_tool', input: {}, unparseableInput: marker });
  });
});

describe('Bedrock stream', () => {
  /** One tool call: `partialJson` undefined sends no input_json_delta at all. */
  async function streamToolCall(partialJson: string | undefined, opts: { stop?: boolean } = {}): Promise<{ res: any; completed: any[] }> {
    const frames = [
      chunkFrame({ type: 'message_start', message: { usage: { input_tokens: 10 } } }),
      chunkFrame({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_zz', name: 'zz_tool', input: {} } }),
      ...(partialJson === undefined ? [] : [
        chunkFrame({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: partialJson } }),
      ]),
      ...(opts.stop === false ? [] : [chunkFrame({ type: 'content_block_stop', index: 0 })]),
      // A call max_tokens cuts gets no content_block_stop.
      chunkFrame({ type: 'message_delta', delta: { stop_reason: opts.stop === false ? 'max_tokens' : 'tool_use' }, usage: { output_tokens: 5 } }),
      chunkFrame({ type: 'message_stop' }),
    ];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, body: streamBody(frames) })));
    const completed: any[] = [];
    const adapter = new BedrockAdapter({ accessKeyId: 'zz-key', secretAccessKey: 'zz-secret', region: 'us-west-2' });
    const res: any = await adapter.stream(
      { model: 'anthropic.claude-zz-v1:0', messages: [{ role: 'user', content: 'zz prompt' }], maxTokens: 64 } as any,
      { onChunk: () => {}, onContentBlock: (_i: number, block: any) => { if (block?.type === 'tool_use') completed.push({ ...block }); } } as any,
    );
    return { res, completed };
  }

  it('keeps arguments that parse to an object', async () => {
    const { res } = await streamToolCall('{"a":1}');
    expect(toolUseOf(res.content)).toEqual({ type: 'tool_use', id: 'toolu_zz', name: 'zz_tool', input: { a: 1 } });
  });

  it.each(['null', malformed])('marks arguments %s, in the response and at content_block_stop', async (args) => {
    const { res, completed } = await streamToolCall(args);
    expect(toolUseOf(res.content)).toMatchObject({ input: {}, unparseableInput: args });
    expect(completed.at(-1)).toMatchObject({ unparseableInput: args });
  });

  it('keeps a stopped call with no arguments as {}, unmarked', async () => {
    const { res } = await streamToolCall(undefined);
    expect(toolUseOf(res.content)).toEqual({ type: 'tool_use', id: 'toolu_zz', name: 'zz_tool', input: {} });
  });

  // As in the Anthropic adapter: a block the stream left open keeps
  // content_block_start's input, and whatever arguments arrived mark it.
  it.each([
    ['did not parse', malformed],
    ['parse to an object', '{"a":1}'],
  ])('marks a block the stream left open whose arguments %s', async (_kind, args) => {
    const { res } = await streamToolCall(args, { stop: false });
    expect(toolUseOf(res.content)).toEqual({ type: 'tool_use', id: 'toolu_zz', name: 'zz_tool', input: {}, unparseableInput: args });
  });

  it('marks a block the stream left open before any arguments arrived with ""', async () => {
    const { res } = await streamToolCall(undefined, { stop: false });
    expect(toolUseOf(res.content)).toEqual({ type: 'tool_use', id: 'toolu_zz', name: 'zz_tool', input: {}, unparseableInput: '' });
  });

  it('tells a stopped call from one the stream left open by its index, in one response', async () => {
    const frames = [
      chunkFrame({ type: 'message_start', message: { usage: { input_tokens: 10 } } }),
      chunkFrame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      chunkFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'zz text' } }),
      chunkFrame({ type: 'content_block_stop', index: 0 }),
      chunkFrame({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_zz1', name: 'zz_tool', input: {} } }),
      chunkFrame({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"a":1}' } }),
      chunkFrame({ type: 'content_block_stop', index: 1 }),
      chunkFrame({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_zz2', name: 'zz_tool', input: {} } }),
      chunkFrame({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"b":' } }),
      chunkFrame({ type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 5 } }),
      chunkFrame({ type: 'message_stop' }),
    ];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, body: streamBody(frames) })));
    const adapter = new BedrockAdapter({ accessKeyId: 'zz-key', secretAccessKey: 'zz-secret', region: 'us-west-2' });
    const res: any = await adapter.stream(
      { model: 'anthropic.claude-zz-v1:0', messages: [{ role: 'user', content: 'zz prompt' }], maxTokens: 64 } as any,
      { onChunk: () => {} } as any,
    );
    expect(res.content.filter((b: any) => b.type === 'tool_use')).toStrictEqual([
      { type: 'tool_use', id: 'toolu_zz1', name: 'zz_tool', input: { a: 1 } },
      { type: 'tool_use', id: 'toolu_zz2', name: 'zz_tool', input: {}, unparseableInput: '{"b":' },
    ]);
  });

  it('gives a completion\'s input that is not an object as {}, marked', async () => {
    stubFetchWithJson({
      id: 'msg_zz', type: 'message', role: 'assistant', model: 'anthropic.claude-zz-v1:0', stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'toolu_zz', name: 'zz_tool', input: [1] }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const adapter = new BedrockAdapter({ accessKeyId: 'zz-key', secretAccessKey: 'zz-secret', region: 'us-west-2' });
    const res: any = await adapter.complete(
      { model: 'anthropic.claude-zz-v1:0', messages: [{ role: 'user', content: 'zz prompt' }], maxTokens: 64 } as any,
    );
    expect(toolUseOf(res.content)).toStrictEqual({ type: 'tool_use', id: 'toolu_zz', name: 'zz_tool', input: {}, unparseableInput: '[1]' });
  });
});

/** An adapter that answers with these tool_use blocks (id call_zz and name
 *  zz_tool unless given), and then with text. */
function adapterAnsweringAll(blocks: Record<string, unknown>[]): ProviderAdapter {
  let calls = 0;
  const response = (): ProviderResponse => ({
    ...(calls++ === 0
      ? { content: blocks.map((block) => ({ type: 'tool_use', id: 'call_zz', name: 'zz_tool', ...block })), stopReason: 'tool_use' }
      : { content: [{ type: 'text', text: 'zz done' }], stopReason: 'end_turn' }),
    stopSequence: undefined,
    usage: { inputTokens: 1, outputTokens: 1 },
    model: 'zz-model-1',
    raw: {},
  } as unknown as ProviderResponse);
  return {
    name: 'zz-fake',
    supportsModel: () => true,
    async complete(): Promise<ProviderResponse> { return response(); },
    async stream(_request: unknown, callbacks: { onChunk?: (c: string) => void }): Promise<ProviderResponse> {
      callbacks.onChunk?.('');
      return response();
    },
  } as unknown as ProviderAdapter;
}

const adapterAnswering = (block: Record<string, unknown>): ProviderAdapter => adapterAnsweringAll([block]);

const membraneRequest = {
  messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz prompt' }] }],
  toolMode: 'native',
  tools: [{ name: 'zz_tool', description: 'zz', inputSchema: { type: 'object', properties: {} } }],
  config: { model: 'zz-model-1', maxTokens: 64 },
} as any;

describe('Membrane', () => {
  it('complete carries the adapter\'s unparseableInput to the response', async () => {
    const res = await new Membrane(adapterAnswering({ input: {}, unparseableInput: 'null' })).complete(membraneRequest);
    expect(res.content.find((b) => b.type === 'tool_use')).toMatchObject({ input: {}, unparseableInput: 'null' });
  });

  it.each([
    ['zz', '"zz"'],
    [null, 'null'],
  ])('complete gives an adapter\'s input %j that is not an object as {}, marked, in content and toolCalls', async (input, marker) => {
    const res: any = await new Membrane(adapterAnswering({ input })).complete(membraneRequest);
    expect(res.content.find((b: any) => b.type === 'tool_use')).toMatchObject({ input: {}, unparseableInput: marker });
    expect(res.toolCalls).toStrictEqual([{ id: 'call_zz', name: 'zz_tool', input: {}, unparseableInput: marker }]);
  });

  it('keeps the adapter\'s own marker over the JSON of an input that is not an object', async () => {
    const block = { input: [1], unparseableInput: '[1, zz-raw' };
    const done: any = await new Membrane(adapterAnswering(block)).complete(membraneRequest);
    const streamed: any = await new Membrane(adapterAnswering(block)).stream(membraneRequest, { onChunk: () => {} });
    for (const res of [done, streamed]) {
      expect(res.content.find((b: any) => b.type === 'tool_use')).toMatchObject({ input: {}, unparseableInput: '[1, zz-raw' });
    }
  });

  it('stream gives an adapter\'s input that is not an object as {}, marked', async () => {
    const res: any = await new Membrane(adapterAnswering({ input: [1] })).stream(membraneRequest, { onChunk: () => {} });
    expect(res.content.find((b: any) => b.type === 'tool_use')).toMatchObject({ input: {}, unparseableInput: '[1]' });
  });
});

describe('ToolCall carries the marker to whoever runs the call', () => {
  const marked = { input: {}, unparseableInput: '{"path":' };
  const markedCall: ToolCall = { id: 'call_zz', name: 'zz_tool', input: {}, unparseableInput: '{"path":' };
  const refuse = (calls: ToolCall[]): ToolResult[] =>
    calls.map((c) => ({ toolUseId: c.id, content: 'zz arguments did not parse', isError: true }));

  it('in the calls stream() hands onToolCalls', async () => {
    const seen: ToolCall[] = [];
    await new Membrane(adapterAnswering(marked)).stream(membraneRequest, {
      onToolCalls: async (calls) => { seen.push(...calls); return refuse(calls); },
    });
    expect(seen).toEqual([markedCall]);
  });

  it('in the yielding stream\'s tool-calls event', async () => {
    const stream = new Membrane(adapterAnswering(marked)).streamYielding(membraneRequest);
    const seen: ToolCall[] = [];
    for await (const event of stream) {
      if (event.type === 'tool-calls') {
        seen.push(...event.calls);
        stream.provideToolResults(refuse(event.calls));
      }
    }
    expect(seen).toEqual([markedCall]);
  });

  it('in complete()\'s toolCalls, and not on a call whose arguments were an object', async () => {
    expect((await new Membrane(adapterAnswering(marked)).complete(membraneRequest)).toolCalls).toEqual([markedCall]);
    expect((await new Membrane(adapterAnswering({ input: { a: 1 } })).complete(membraneRequest)).toolCalls)
      .toEqual([{ id: 'call_zz', name: 'zz_tool', input: { a: 1 } }]);
  });

  it('keeps the empty marker of a call cut before any arguments arrived', async () => {
    const cut = { input: {}, unparseableInput: '' };
    const cutCall = { id: 'call_zz', name: 'zz_tool', input: {}, unparseableInput: '' };
    const seen: ToolCall[] = [];
    await new Membrane(adapterAnswering(cut)).stream(membraneRequest, {
      onToolCalls: async (calls) => { seen.push(...calls); return refuse(calls); },
    });
    expect(seen).toStrictEqual([cutCall]);
    expect((await new Membrane(adapterAnswering(cut)).complete(membraneRequest)).toolCalls).toStrictEqual([cutCall]);
  });

  it('marks only the call whose block is marked, in a round of two', async () => {
    const blocks = [{ id: 'call_zz1', input: { a: 1 } }, { id: 'call_zz2', input: {}, unparseableInput: '{"b":' }];
    const expected = [
      { id: 'call_zz1', name: 'zz_tool', input: { a: 1 } },
      { id: 'call_zz2', name: 'zz_tool', input: {}, unparseableInput: '{"b":' },
    ];
    const seen: ToolCall[] = [];
    await new Membrane(adapterAnsweringAll(blocks)).stream(membraneRequest, {
      onToolCalls: async (calls) => { seen.push(...calls); return refuse(calls); },
    });
    expect(seen).toStrictEqual(expected);
    const stream = new Membrane(adapterAnsweringAll(blocks)).streamYielding(membraneRequest);
    const yielded: ToolCall[] = [];
    for await (const event of stream) {
      if (event.type === 'tool-calls') {
        yielded.push(...event.calls);
        stream.provideToolResults(refuse(event.calls));
      }
    }
    expect(yielded).toStrictEqual(expected);
  });
});
