/**
 * Anthropic can answer with a single complete tool_use block and
 * `stop_reason: "end_turn"`, with `stop_details` null and message_delta
 * received.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { Membrane } from '../../src/membrane.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { AnthropicXmlFormatter } from '../../src/formatters/anthropic-xml.js';
import { OpenAICompatibleAdapter } from '../../src/providers/openai-compatible.js';
import { BedrockAdapter } from '../../src/providers/bedrock.js';
import { sseResponse } from '../helpers/sse-fixtures.js';
import { chunkFrame, streamBody } from '../helpers/bedrock-event-stream.js';
import type {
  NormalizedRequest,
  ProviderAdapter,
  ProviderRequest,
  ProviderResponse,
  StreamCallbacks,
  StreamEvent,
  ToolCall,
  ToolResult,
} from '../../src/types/index.js';

/** The SDK's MessageStream records the request id on connect. */
function fakeAnthropicStream(events: unknown[], requestId?: string) {
  return {
    controller: { abort() { } },
    ...(requestId ? { request_id: requestId } : {}),
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i < events.length) return { value: events[i++], done: false };
          return { value: undefined, done: true };
        },
      };
    },
  };
}

const MODEL = 'claude-zz-1';

function messageStart(id: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'message_start',
    message: {
      id, type: 'message', role: 'assistant', model: MODEL, content: [],
      stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
      ...extra,
    },
  };
}

function completeToolCall(index: number, id: string, args: string) {
  return [
    { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name: 'zz_lookup', input: {} } },
    { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: args } },
    { type: 'content_block_stop', index },
  ];
}

function unstoppedToolCall(index: number, id: string, args?: string) {
  return [
    { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name: 'zz_lookup', input: {} } },
    ...(args === undefined ? [] : [{ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: args } }]),
  ];
}

const endTurnDelta = { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null, stop_details: null }, usage: { output_tokens: 5 } };
const toolUseEnd = { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } };
const toolStart = (index: number, id: string) => ({ type: 'content_block_start', index, content_block: { type: 'tool_use', id, name: 'zz_lookup', input: {} } });
const argsDelta = (index: number, partial_json: string) => ({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } });
const blockStop = (index: number) => ({ type: 'content_block_stop', index });
const textDelta = (index: number, text: string) => ({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } });

const serverCalls: Array<[string, Record<string, unknown>]> = [
  ['server_tool_use', { type: 'server_tool_use', id: 'srvtoolu_zz_t', name: 'web_search', input: {} }],
  ['mcp_tool_use', { type: 'mcp_tool_use', id: 'mcptoolu_zz_t', name: 'zz_tool', server_name: 'zz_server', input: {} }],
];
/** The API always sends input in a server tool call's start; this one carries none. */
const serverCallWithoutInput = { type: 'server_tool_use', id: 'srvtoolu_zz_t', name: 'web_search' };

/**
 * The SDK's MessageStream parses every tool block's argument buffer as it
 * grows, so a fragment that left one invalid throws there, before the
 * adapter. The three streams it doesn't deliver are marked; Bedrock reads its
 * stream itself.
 */
const outOfOrder: Array<[name: string, events: unknown[], markedCalls: Array<{ id: string; unparseableInput: string }>, eventsKeptFromBreak: number, bedrockReportedCalls: string[]]> = [
  ['a start while a block is open',
    [toolStart(0, 'toolu_zz_a'), argsDelta(0, '{"query":"a"}'), toolStart(1, 'toolu_zz_b'), argsDelta(1, '{"query":"b"}'), blockStop(1)],
    [{ id: 'toolu_zz_a', unparseableInput: '{"query":"a"}' }], 3, ['toolu_zz_a']],
  ['a stop for a block other than the open one',
    [toolStart(0, 'toolu_zz_a'), argsDelta(0, '{"query":"a"}'), blockStop(0), toolStart(1, 'toolu_zz_b'), argsDelta(1, '{"query":"b"}'), blockStop(0), blockStop(1)],
    [{ id: 'toolu_zz_a', unparseableInput: '{"query":"a"}' }, { id: 'toolu_zz_b', unparseableInput: '{"query":"b"}' }], 2, ['toolu_zz_a', 'toolu_zz_a', 'toolu_zz_b']],
  ['a second stop for a block, and a call after it',
    [toolStart(0, 'toolu_zz_a'), argsDelta(0, '{"query":"a"}'), blockStop(0), blockStop(0), toolStart(1, 'toolu_zz_b'), argsDelta(1, '{"query":"b"}'), blockStop(1)],
    [{ id: 'toolu_zz_a', unparseableInput: '{"query":"a"}' }], 4, ['toolu_zz_a', 'toolu_zz_a']],
  ["arguments after a call's stop",
    [toolStart(0, 'toolu_zz_a'), blockStop(0), argsDelta(0, '{"query":"a"}')],
    [{ id: 'toolu_zz_a', unparseableInput: '{}' }], 1, ['toolu_zz_a', 'toolu_zz_a']],
  ["arguments at index -1 after a call's stop",
    [toolStart(0, 'toolu_zz_a'), blockStop(0), argsDelta(-1, '{"query":"a"}')],
    [{ id: 'toolu_zz_a', unparseableInput: '{}' }], 1, ['toolu_zz_a', 'toolu_zz_a']],
  ["a stop at index -1 after a call's stop",
    [toolStart(0, 'toolu_zz_a'), argsDelta(0, '{"query":"a"}'), blockStop(0), blockStop(-1)],
    [{ id: 'toolu_zz_a', unparseableInput: '{"query":"a"}' }], 1, ['toolu_zz_a', 'toolu_zz_a']],
  ['a delta for a block other than the open one',
    [toolStart(0, 'toolu_zz_a'), argsDelta(0, '{"query":"a"}'), argsDelta(1, '{"query":"b"}'), blockStop(0)],
    [{ id: 'toolu_zz_a', unparseableInput: '{"query":"a"}' }], 2, ['toolu_zz_a']],
  ["a second start for the open block's index",
    [toolStart(0, 'toolu_zz_a'), toolStart(0, 'toolu_zz_b'), argsDelta(0, '{"query":"b"}'), blockStop(0)],
    [{ id: 'toolu_zz_a', unparseableInput: '' }], 3, ['toolu_zz_a']],
  ["a second start for a finished block's index",
    [toolStart(0, 'toolu_zz_a'), argsDelta(0, '{"query":"a"}'), blockStop(0), toolStart(0, 'toolu_zz_b'), blockStop(0)],
    [{ id: 'toolu_zz_a', unparseableInput: '{"query":"a"}' }], 2, ['toolu_zz_a', 'toolu_zz_a']],
  ['a stop for a block never started, and a call after it',
    [toolStart(0, 'toolu_zz_a'), argsDelta(0, '{"query":"a"}'), blockStop(0), blockStop(1), toolStart(1, 'toolu_zz_b'), argsDelta(1, '{"query":"b"}'), blockStop(1)],
    [{ id: 'toolu_zz_a', unparseableInput: '{"query":"a"}' }], 4, ['toolu_zz_a', 'toolu_zz_a']],
  // A tool call's deltas carry only its arguments, as an input_json_delta whose partial_json is a string.
  ['a text delta in a tool call',
    [toolStart(0, 'toolu_zz_a'), textDelta(0, '{"query":"x"}'), blockStop(0)],
    [{ id: 'toolu_zz_a', unparseableInput: '' }], 2, ['toolu_zz_a']],
  ['arguments as a partial_json that is a number',
    [toolStart(0, 'toolu_zz_a'), { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 5 } }, blockStop(0)],
    [{ id: 'toolu_zz_a', unparseableInput: '' }], 2, ['toolu_zz_a']],
  ['a delta of another type carrying partial_json',
    [toolStart(0, 'toolu_zz_a'), { type: 'content_block_delta', index: 0, delta: { type: 'zz_delta', partial_json: '{"query":"x"}' } }, blockStop(0)],
    [{ id: 'toolu_zz_a', unparseableInput: '' }], 2, ['toolu_zz_a']],
  // The SDK doesn't deliver these two: it parses the call's buffer and throws.
  ['an input_json_delta with no partial_json',
    [toolStart(0, 'toolu_zz_a'), { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta' } }, blockStop(0)],
    [{ id: 'toolu_zz_a', unparseableInput: '' }], 2, ['toolu_zz_a']],
  ['arguments under another key',
    [toolStart(0, 'toolu_zz_a'), { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', json: '{"query":"x"}' } }, blockStop(0)],
    [{ id: 'toolu_zz_a', unparseableInput: '' }], 2, ['toolu_zz_a']],
  // Nor this one: it reads the delta's type first.
  ['a delta event with no delta',
    [toolStart(0, 'toolu_zz_a'), { type: 'content_block_delta', index: 0 }, blockStop(0)],
    [{ id: 'toolu_zz_a', unparseableInput: '' }], 2, ['toolu_zz_a']],
];

function finalText(id: string) {
  return [
    messageStart(id),
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'zz done' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } },
  ];
}

function toolCallStoppedWithEndTurn(id: string) {
  return [
    messageStart(id),
    ...completeToolCall(0, 'toolu_zz_end1', '{"query":"zz"}'),
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null, stop_details: null }, usage: { output_tokens: 20 } },
  ];
}

function scriptedAnthropic(rounds: Array<{ events: unknown[]; requestId?: string }>) {
  const adapter = new AnthropicAdapter({ apiKey: 'zz-key', cacheKeepalive: { enabled: false } });
  let call = 0;
  (adapter as any).client = {
    withOptions() { return this; },
    messages: {
      stream: async () => {
        const round = rounds[call++];
        if (!round) throw new Error(`unscripted provider call ${call}`);
        return fakeAnthropicStream(round.events, round.requestId);
      },
    },
  };
  return { adapter, calls: () => call };
}

function request(): NormalizedRequest {
  return {
    messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz go' }] }],
    config: { model: MODEL, maxTokens: 64 },
    toolMode: 'native',
    tools: [{ name: 'zz_lookup', description: 'zz', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }],
  };
}

const answer = (calls: ToolCall[]): ToolResult[] =>
  calls.map((c) => ({ toolUseId: c.id, content: 'zz result', isError: false }));

let warn: ReturnType<typeof vi.spyOn> | undefined;
function captureWarnings(): string[] {
  const lines: string[] = [];
  warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  return lines;
}
afterEach(() => { warn?.mockRestore(); warn = undefined; vi.unstubAllGlobals(); });

class TokenlessAdapter implements ProviderAdapter {
  readonly name = 'zz-tokenless';
  constructor(private readonly response: Pick<ProviderResponse, 'content' | 'stopReason' | 'stopSequence'>) {}
  supportsModel(): boolean { return true; }
  async complete(): Promise<ProviderResponse> { throw new Error('not used'); }
  async stream(_request: ProviderRequest, callbacks: StreamCallbacks): Promise<ProviderResponse> {
    (this.response.content as unknown[]).forEach((block, index) => callbacks.onContentBlock?.(index, block as any));
    return { ...this.response, usage: { inputTokens: 10, outputTokens: 10 }, raw: {} };
  }
}

const onceToolCalls = () => vi.fn(async (toolCalls: ToolCall[]) => answer(toolCalls));

describe('tool calls the provider stopped with end_turn', () => {
  it('stream(): complete calls run as a tool_use round, and the turn continues', async () => {
    const warnings = captureWarnings();
    const { adapter, calls } = scriptedAnthropic([
      { events: toolCallStoppedWithEndTurn('msg_zz_1'), requestId: 'req_zz_1' },
      { events: finalText('msg_zz_2'), requestId: 'req_zz_2' },
    ]);
    const ran: ToolCall[] = [];
    const response = await new Membrane(adapter, { formatter: new NativeFormatter() }).stream(request(), {
      onToolCalls: async (toolCalls) => { ran.push(...toolCalls); return answer(toolCalls); },
    });

    expect(ran.map((c) => [c.id, c.name, c.input])).toEqual([['toolu_zz_end1', 'zz_lookup', { query: 'zz' }]]);
    expect(calls()).toBe(2);
    expect(response.stopReason).toBe('end_turn');
    expect(response.details.anomalies).toEqual([{
      kind: 'tool_use_with_end_turn',
      round: 0,
      providerStopReason: 'end_turn',
      toolNames: ['zz_lookup'],
      toolUseIds: ['toolu_zz_end1'],
      treatedAsToolUse: true,
      model: MODEL,
      messageId: 'msg_zz_1',
      requestId: 'req_zz_1',
    }]);
    const line = warnings.find((w) => w.includes('tool call'));
    expect(line).toContain('msg_zz_1');
    expect(line).toContain('req_zz_1');
  });

  it('streamYielding(): the round yields tool-calls and the turn continues', async () => {
    captureWarnings();
    const { adapter, calls } = scriptedAnthropic([
      { events: toolCallStoppedWithEndTurn('msg_zz_3'), requestId: 'req_zz_3' },
      { events: finalText('msg_zz_4') },
    ]);
    const stream = new Membrane(adapter, { formatter: new NativeFormatter() }).streamYielding(request());
    const toolRounds: ToolCall[][] = [];
    const actedOnStops: unknown[] = [];
    let complete: any;
    for await (const event of stream as AsyncIterable<StreamEvent>) {
      if (event.type === 'tool-calls') {
        toolRounds.push(event.calls);
        stream.provideToolResults(answer(event.calls));
      } else if (event.type === 'usage') {
        actedOnStops.push((event as any).round?.stopReason);
      } else if (event.type === 'complete') {
        complete = event.response;
        break;
      } else if (event.type === 'error' || event.type === 'aborted') {
        throw new Error(`stream ended with ${event.type}`);
      }
    }

    expect(toolRounds.map((r) => r.map((c) => c.id))).toEqual([['toolu_zz_end1']]);
    expect(calls()).toBe(2);
    expect(complete.stopReason).toBe('end_turn');
    expect(complete.details.anomalies).toHaveLength(1);
    expect(complete.details.anomalies[0]).toMatchObject({ round: 0, treatedAsToolUse: true, messageId: 'msg_zz_3', requestId: 'req_zz_3' });
    expect(actedOnStops).toEqual(['tool_use', 'end_turn']);
  });

  it('a call cut off before its block stopped runs nothing; the round stays end_turn, recorded untreated', async () => {
    const warnings = captureWarnings();
    const { adapter, calls } = scriptedAnthropic([{
      events: [
        messageStart('msg_zz_5'),
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_zz_cut', name: 'zz_lookup', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"z' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
      ],
    }]);
    const onToolCalls = vi.fn(async (toolCalls: ToolCall[]) => answer(toolCalls));
    const response = await new Membrane(adapter, { formatter: new NativeFormatter() }).stream(request(), { onToolCalls });

    expect(onToolCalls).not.toHaveBeenCalled();
    expect(calls()).toBe(1);
    expect(response.stopReason).toBe('end_turn');
    expect(response.details.anomalies?.[0]).toMatchObject({ treatedAsToolUse: false, toolUseIds: ['toolu_zz_cut'] });
    expect(warnings.filter((w) => w.includes('msg_zz_5'))).toHaveLength(1);
  });

  it.each([
    ['max_tokens', { stop_reason: 'max_tokens' }],
    ['refusal', { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } }],
    ['stop_sequence', { stop_reason: 'stop_sequence', stop_sequence: 'ZZ' }],
    ['pause_turn', { stop_reason: 'pause_turn' }],
  ])('a %s stop with a tool call runs nothing and records no anomaly', async (_name, delta) => {
    captureWarnings();
    const { adapter, calls } = scriptedAnthropic([{
      events: [
        messageStart('msg_zz_6'),
        ...completeToolCall(0, 'toolu_zz_stop', '{"query":"zz"}'),
        { type: 'message_delta', delta, usage: { output_tokens: 5 } },
      ],
    }]);
    const onToolCalls = vi.fn(async (toolCalls: ToolCall[]) => answer(toolCalls));
    const response = await new Membrane(adapter, { formatter: new NativeFormatter() }).stream(request(), { onToolCalls });

    expect(onToolCalls).not.toHaveBeenCalled();
    expect(calls()).toBe(1);
    expect(response.stopReason).toBe(delta.stop_reason);
    expect(response.details.anomalies).toBeUndefined();
  });

  it('a provider token membrane doesn\'t map is not read as end_turn: nothing runs', async () => {
    captureWarnings();
    const { adapter } = scriptedAnthropic([{
      events: [
        messageStart('msg_zz_7'),
        ...completeToolCall(0, 'toolu_zz_new', '{"query":"zz"}'),
        { type: 'message_delta', delta: { stop_reason: 'zz_new_reason' }, usage: { output_tokens: 5 } },
      ],
    }]);
    const onToolCalls = vi.fn(async (toolCalls: ToolCall[]) => answer(toolCalls));
    const response = await new Membrane(adapter, { formatter: new NativeFormatter() }).stream(request(), { onToolCalls });

    expect(onToolCalls).not.toHaveBeenCalled();
    expect(response.details.anomalies).toBeUndefined();
  });

  it('complete(): the response comes back as a tool_use stop, recorded', async () => {
    captureWarnings();
    const adapter = new AnthropicAdapter({ apiKey: 'zz-key', cacheKeepalive: { enabled: false } });
    const message = {
      id: 'msg_zz_8', type: 'message', role: 'assistant', model: MODEL,
      content: [{ type: 'tool_use', id: 'toolu_zz_c', name: 'zz_lookup', input: { query: 'zz' } }],
      stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 20 },
    };
    Object.defineProperty(message, '_request_id', { value: 'req_zz_8', enumerable: false });
    (adapter as any).client = { withOptions() { return this; }, messages: { create: async () => message } };

    const response = await new Membrane(adapter, { formatter: new NativeFormatter() }).complete(request());

    expect(response.stopReason).toBe('tool_use');
    expect(response.details.stop.providerReason).toBe('end_turn');
    expect(response.details.anomalies).toEqual([{
      kind: 'tool_use_with_end_turn', round: 0, providerStopReason: 'end_turn',
      toolNames: ['zz_lookup'], toolUseIds: ['toolu_zz_c'], treatedAsToolUse: true,
      model: MODEL, messageId: 'msg_zz_8', requestId: 'req_zz_8',
    }]);
  });

  it('complete(): a call whose input is not an object keeps the end_turn stop, recorded untreated', async () => {
    captureWarnings();
    const adapter = new AnthropicAdapter({ apiKey: 'zz-key', cacheKeepalive: { enabled: false } });
    const message = {
      id: 'msg_zz_13', type: 'message', role: 'assistant', model: MODEL,
      content: [{ type: 'tool_use', id: 'toolu_zz_bad', name: 'zz_lookup', input: 'zz' }],
      stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 20 },
    };
    (adapter as any).client = { withOptions() { return this; }, messages: { create: async () => message } };

    const response = await new Membrane(adapter, { formatter: new NativeFormatter() }).complete(request());

    expect(response.stopReason).toBe('end_turn');
    expect(response.details.anomalies).toEqual([expect.objectContaining({ treatedAsToolUse: false, toolUseIds: ['toolu_zz_bad'] })]);
  });

  it('complete() in XML tool mode leaves the stop as the provider gave it', async () => {
    captureWarnings();
    const adapter = new AnthropicAdapter({ apiKey: 'zz-key', cacheKeepalive: { enabled: false } });
    const message = {
      id: 'msg_zz_14', type: 'message', role: 'assistant', model: MODEL,
      content: [{ type: 'tool_use', id: 'toolu_zz_xml', name: 'zz_lookup', input: { query: 'zz' } }],
      stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 20 },
    };
    (adapter as any).client = { withOptions() { return this; }, messages: { create: async () => message } };

    const response = await new Membrane(adapter, { formatter: new AnthropicXmlFormatter() }).complete({ ...request(), toolMode: 'xml' });

    expect(response.stopReason).toBe('end_turn');
    expect(response.details.anomalies).toBeUndefined();
  });

  it('streamYielding(): a cut-off call yields no tool-calls; the turn completes as end_turn, recorded untreated', async () => {
    captureWarnings();
    const { adapter, calls } = scriptedAnthropic([{
      events: [messageStart('msg_zz_15'), ...unstoppedToolCall(0, 'toolu_zz_cut3', '{"query":"z'), endTurnDelta],
    }]);
    const stream = new Membrane(adapter, { formatter: new NativeFormatter() }).streamYielding(request());
    const seen: string[] = [];
    let complete: any;
    for await (const event of stream as AsyncIterable<StreamEvent>) {
      seen.push(event.type);
      if (event.type === 'tool-calls') {
        stream.provideToolResults(answer(event.calls));
      } else if (event.type === 'complete') {
        complete = event.response;
        break;
      } else if (event.type === 'error' || event.type === 'aborted') {
        throw new Error(`stream ended with ${event.type}`);
      }
    }

    expect(seen).not.toContain('tool-calls');
    expect(calls()).toBe(1);
    expect(complete.stopReason).toBe('end_turn');
    expect(complete.details.anomalies[0]).toMatchObject({ treatedAsToolUse: false, toolUseIds: ['toolu_zz_cut3'] });
  });

  it.each([
    ['whole arguments', '{"query":"zz"}'],
    ['no arguments at all', undefined],
  ])('a call whose block never stopped counts as cut off, even with %s', async (_name, args) => {
    captureWarnings();
    const { adapter } = scriptedAnthropic([{
      events: [messageStart('msg_zz_16'), ...unstoppedToolCall(0, 'toolu_zz_open', args), endTurnDelta],
    }]);
    const onToolCalls = onceToolCalls();
    const response = await new Membrane(adapter, { formatter: new NativeFormatter() }).stream(request(), { onToolCalls });

    expect(onToolCalls).not.toHaveBeenCalled();
    expect(response.details.anomalies?.[0]).toMatchObject({ treatedAsToolUse: false, toolUseIds: ['toolu_zz_open'] });
  });

  it('a tool block left open when the next block starts counts as cut off: nothing runs', async () => {
    captureWarnings();
    const { adapter } = scriptedAnthropic([{
      events: [
        messageStart('msg_zz_17'),
        ...unstoppedToolCall(0, 'toolu_zz_left', '{"query":"zz"}'),
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'zz after' } },
        { type: 'content_block_stop', index: 1 },
        endTurnDelta,
      ],
    }]);
    const onToolCalls = onceToolCalls();
    const response = await new Membrane(adapter, { formatter: new NativeFormatter() }).stream(request(), { onToolCalls });

    expect(onToolCalls).not.toHaveBeenCalled();
    expect(response.details.anomalies?.[0]).toMatchObject({ treatedAsToolUse: false, toolUseIds: ['toolu_zz_left'] });
    expect(response.content.find((b: any) => b.type === 'tool_use')).toMatchObject({ unparseableInput: '{"query":"zz"}' });
  });

  async function anthropicStream(events: unknown[]) {
    const { adapter } = scriptedAnthropic([{ events }]);
    const reported: number[] = [];
    const reportedIds: unknown[] = [];
    const chunks: string[] = [];
    const res: any = await adapter.stream(
      { model: MODEL, maxTokens: 64, messages: [{ role: 'user', content: [{ type: 'text', text: 'zz' }] }] } as any,
      {
        onChunk: (chunk: string) => { chunks.push(chunk); },
        onContentBlock: (index: number, block: any) => { reported.push(index); reportedIds.push(block?.id); },
      } as any,
    );
    return { res, reported, reportedIds, chunks };
  }

  it('a stream in order marks nothing and keeps no block event as unread', async () => {
    const { res } = await anthropicStream([
      messageStart('msg_zz_70'), ...completeToolCall(0, 'toolu_zz_p', '{"query":"a"}'), ...completeToolCall(1, 'toolu_zz_q', '{"query":"b"}'), toolUseEnd,
    ]);
    expect(res.content).toMatchObject([{ id: 'toolu_zz_p', input: { query: 'a' } }, { id: 'toolu_zz_q', input: { query: 'b' } }]);
    expect(res.content.map((b: any) => b.unparseableInput)).toEqual([undefined, undefined]);
    expect(res.raw.provider_events.unhandled).toBeUndefined();
  });

  it('a block left open when a max_tokens stop ends the stream is cut off alone: that stream is in order', async () => {
    const { res } = await anthropicStream([
      messageStart('msg_zz_71'), ...completeToolCall(0, 'toolu_zz_r', '{"query":"a"}'), ...unstoppedToolCall(1, 'toolu_zz_s', '{"query":'),
      { type: 'message_delta', delta: { stop_reason: 'max_tokens', stop_sequence: null }, usage: { output_tokens: 64 } },
    ]);
    expect(res.content).toMatchObject([{ id: 'toolu_zz_r', input: { query: 'a' } }, { id: 'toolu_zz_s', input: {}, unparseableInput: '{"query":' }]);
    expect(res.content[0].unparseableInput).toBeUndefined();
    expect(res.raw.provider_events.unhandled).toBeUndefined();
  });

  it.each(outOfOrder)('%s breaks block order: every call is marked with its own arguments, and the events from the break on are kept, not applied, with one warning', async (_name, events, expected, kept) => {
    const warnings = captureWarnings();
    const { res, reportedIds, chunks } = await anthropicStream([messageStart('msg_zz_72'), ...events, toolUseEnd]);
    expect(chunks).toEqual([]);
    expect(res.content).toHaveLength(expected.length);
    expect(res.content).toMatchObject(expected.map((call) => ({ type: 'tool_use', ...call })));
    expect(res.content.map((b: any) => b.input)).toEqual(expected.map(() => ({})));
    expect(res.raw.provider_events.unhandled).toEqual(events.slice(-kept));
    expect(reportedIds).toEqual(expected.flatMap(({ id }) => [id, id]));
    expect(warnings.filter((w) => w.includes('every tool_use block in the response is marked'))).toHaveLength(1);
  });

  // In the API's order, a block starts only at the next index.
  it.each([
    ['skips an index', 2],
    ['is negative', -1],
    ['is a string', '1'],
  ])('a start whose index %s breaks block order: the call before it is marked, and nothing throws', async (_name, index) => {
    const warnings = captureWarnings();
    const later = completeToolCall(index as number, 'toolu_zz_b', '{"query":"b"}');
    const { res, chunks } = await anthropicStream([messageStart('msg_zz_76'), ...completeToolCall(0, 'toolu_zz_a', '{"query":"a"}'), ...later, endTurnDelta]);
    expect(res.content).toEqual([{ type: 'tool_use', id: 'toolu_zz_a', name: 'zz_lookup', input: {}, unparseableInput: '{"query":"a"}' }]);
    expect(res.raw.provider_events.unhandled).toEqual(later);
    expect(chunks).toEqual([]);
    expect(warnings.filter((w) => w.includes('every tool_use block in the response is marked'))).toHaveLength(1);
  });

  it.each(serverCalls)('a text delta in a server tool call (%s) breaks block order too: the call, still open, is marked as cut off, and nothing is streamed', async (_name, block) => {
    const warnings = captureWarnings();
    const { res, chunks } = await anthropicStream([
      messageStart('msg_zz_75'),
      { type: 'content_block_start', index: 0, content_block: block },
      textDelta(0, 'zz text'), blockStop(0),
      endTurnDelta,
    ]);
    expect(res.content).toEqual([{ ...block, unparseableInput: '' }]);
    expect(chunks).toEqual([]);
    expect(warnings.filter((w) => w.includes('every tool_use block in the response is marked'))).toHaveLength(1);
  });

  it('a text delta in a server tool call whose start carried no input breaks block order: nothing is streamed', async () => {
    const warnings = captureWarnings();
    const { res, chunks } = await anthropicStream([
      messageStart('msg_zz_78'),
      { type: 'content_block_start', index: 0, content_block: serverCallWithoutInput },
      textDelta(0, 'zz text'), blockStop(0),
      endTurnDelta,
    ]);
    expect(res.content).toHaveLength(1);
    expect(chunks).toEqual([]);
    expect(warnings.filter((w) => w.includes('every tool_use block in the response is marked'))).toHaveLength(1);
  });

  it('a stop after message_delta is never read: the call still open there is marked as cut off, as in Bedrock, with no warning', async () => {
    const warnings = captureWarnings();
    const { res } = await anthropicStream([messageStart('msg_zz_77'), toolStart(0, 'toolu_zz_l'), argsDelta(0, '{"query":"a"}'), endTurnDelta, blockStop(0)]);
    expect(res.content).toEqual([{ type: 'tool_use', id: 'toolu_zz_l', name: 'zz_lookup', input: {}, unparseableInput: '{"query":"a"}' }]);
    expect(warnings.filter((w) => w.includes('block order'))).toEqual([]);
  });

  it('a server tool call that finished before a break keeps its input: it ran on the API\'s side; the tool_use call beside it is marked', async () => {
    captureWarnings();
    const { res } = await anthropicStream([
      messageStart('msg_zz_74'),
      { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srvtoolu_zz_a', name: 'web_search', input: {} } },
      argsDelta(0, '{"query":"a"}'), blockStop(0),
      ...completeToolCall(1, 'toolu_zz_b', '{"query":"b"}'), blockStop(1),
      toolUseEnd,
    ]);
    expect(res.content).toEqual([
      { type: 'server_tool_use', id: 'srvtoolu_zz_a', name: 'web_search', input: { query: 'a' } },
      { type: 'tool_use', id: 'toolu_zz_b', name: 'zz_lookup', input: {}, unparseableInput: '{"query":"b"}' },
    ]);
  });

  it('after a break, a text block keeps what it had, and nothing more is streamed or reported', async () => {
    const { res, reported, chunks } = await anthropicStream([
      messageStart('msg_zz_73'),
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'zz first' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'zz next' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'zz late' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: ' zz after' } },
      { type: 'content_block_stop', index: 1 },
      endTurnDelta,
    ]);
    expect(res.content).toMatchObject([{ type: 'text', text: 'zz first' }, { type: 'text', text: 'zz next' }]);
    expect(chunks).toEqual(['zz first', 'zz next']);
    expect(reported).toEqual([0, 0, 1, 1]);
    expect(res.raw.provider_events.unhandled).toHaveLength(3);
  });

  it('a round holding a complete call and a cut-off one runs neither', async () => {
    captureWarnings();
    const { adapter } = scriptedAnthropic([{
      events: [
        messageStart('msg_zz_18'),
        ...completeToolCall(0, 'toolu_zz_whole', '{"query":"zz"}'),
        ...unstoppedToolCall(1, 'toolu_zz_cut2', '{"query":"z'),
        endTurnDelta,
      ],
    }]);
    const onToolCalls = onceToolCalls();
    const response = await new Membrane(adapter, { formatter: new NativeFormatter() }).stream(request(), { onToolCalls });

    expect(onToolCalls).not.toHaveBeenCalled();
    expect(response.details.anomalies).toEqual([expect.objectContaining({
      treatedAsToolUse: false, toolUseIds: ['toolu_zz_whole', 'toolu_zz_cut2'],
    })]);
  });

  it('a stop membrane maps to stop_sequence runs nothing, even with no provider token', async () => {
    captureWarnings();
    const adapter = new TokenlessAdapter({
      content: [{ type: 'tool_use', id: 'toolu_zz_seq', name: 'zz_lookup', input: { query: 'zz' } }],
      stopReason: 'stop_sequence',
      stopSequence: 'ZZ',
    });
    const onToolCalls = onceToolCalls();
    const response = await new Membrane(adapter, { formatter: new NativeFormatter() }).stream(request(), { onToolCalls });

    expect(onToolCalls).not.toHaveBeenCalled();
    expect(response.details.anomalies).toBeUndefined();
  });

  it('a round with no stop reason at all (an OpenAI-family server sending no finish_reason) runs nothing: only a literal end_turn qualifies', async () => {
    const warnings = captureWarnings();
    const chunk = (delta: unknown, finishReason?: string) => JSON.stringify({
      id: 'zz-id', model: 'zz-model-1',
      choices: [{ index: 0, delta, ...(finishReason ? { finish_reason: finishReason } : {}) }],
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sseResponse([
        chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_zz_1', type: 'function', function: { name: 'zz_lookup', arguments: '{"query":"zz"}' } }] }),
        '[DONE]',
      ]))
      .mockResolvedValueOnce(sseResponse([chunk({ role: 'assistant', content: 'zz done' }, 'stop'), '[DONE]']));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new OpenAICompatibleAdapter({ baseURL: 'http://zz-host.invalid/v1', apiKey: 'zz-key' });
    const ran: ToolCall[] = [];
    const response = await new Membrane(adapter, { formatter: new NativeFormatter() }).stream(
      { ...request(), config: { model: 'zz-model-1', maxTokens: 64 } },
      { onToolCalls: async (toolCalls) => { ran.push(...toolCalls); return answer(toolCalls); } },
    );

    expect(ran).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.stopReason).toBe('end_turn');
    expect(response.details.anomalies).toBeUndefined();
    expect(warnings.filter((w) => w.includes('tool call(s)'))).toEqual([]);
  });

  it('an end_turn with no provider token runs nothing on stream() or complete(), and records nothing', async () => {
    const warnings = captureWarnings();
    const blocks = [{ type: 'tool_use', id: 'toolu_zz_tokenless', name: 'zz_lookup', input: { query: 'zz' } }];
    const streamed = new TokenlessAdapter({ content: blocks as ProviderResponse['content'], stopReason: 'end_turn' });
    const onToolCalls = onceToolCalls();
    const response = await new Membrane(streamed, { formatter: new NativeFormatter() }).stream(request(), { onToolCalls });

    expect(onToolCalls).not.toHaveBeenCalled();
    expect(response.stopReason).toBe('end_turn');
    expect(response.details.anomalies).toBeUndefined();

    class TokenlessCompleteAdapter extends TokenlessAdapter {
      override async complete(): Promise<ProviderResponse> {
        return { content: blocks as ProviderResponse['content'], stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 10 }, raw: {} };
      }
    }
    const completed = await new Membrane(
      new TokenlessCompleteAdapter({ content: [], stopReason: 'end_turn' }),
      { formatter: new NativeFormatter() },
    ).complete(request());

    expect(completed.stopReason).toBe('end_turn');
    expect(completed.details.anomalies).toBeUndefined();
    expect(warnings.filter((w) => w.includes('tool call(s)'))).toEqual([]);
  });

  it('anomalies in later rounds keep their round index and accumulate in order, one warning each', async () => {
    const warnings = captureWarnings();
    const { adapter } = scriptedAnthropic([
      { events: [
        messageStart('msg_zz_40'),
        ...completeToolCall(0, 'toolu_zz_r0', '{"query":"a"}'),
        { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } },
      ] },
      { events: toolCallStoppedWithEndTurn('msg_zz_41') },
      { events: [messageStart('msg_zz_42'), ...completeToolCall(0, 'toolu_zz_r2', '{"query":"b"}'), endTurnDelta] },
      { events: finalText('msg_zz_43') },
    ]);
    const response = await new Membrane(adapter, { formatter: new NativeFormatter() }).stream(request(), {
      onToolCalls: async (toolCalls) => answer(toolCalls),
    });

    expect(response.details.anomalies?.map((a) => [a.round, a.messageId])).toEqual([[1, 'msg_zz_41'], [2, 'msg_zz_42']]);
    for (const id of ['msg_zz_41', 'msg_zz_42']) expect(warnings.filter((w) => w.includes(id))).toHaveLength(1);
  });

  it("details.stop describes the final round, while the anomaly keeps its own round's token", async () => {
    captureWarnings();
    const { adapter } = scriptedAnthropic([
      { events: toolCallStoppedWithEndTurn('msg_zz_44') },
      { events: [
        messageStart('msg_zz_45'),
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'zz cut' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'max_tokens', stop_sequence: null }, usage: { output_tokens: 64 } },
      ] },
    ]);
    const response = await new Membrane(adapter, { formatter: new NativeFormatter() }).stream(request(), {
      onToolCalls: async (toolCalls) => answer(toolCalls),
    });

    expect(response.details.stop.providerReason).toBe('max_tokens');
    expect(response.details.anomalies?.[0]?.providerStopReason).toBe('end_turn');
  });

  it('the warning goes to the configured logger when one is set', async () => {
    const consoleLines = captureWarnings();
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { adapter } = scriptedAnthropic([
      { events: toolCallStoppedWithEndTurn('msg_zz_46'), requestId: 'req_zz_46' },
      { events: finalText('msg_zz_47') },
    ]);
    await new Membrane(adapter, { formatter: new NativeFormatter(), logger }).stream(request(), {
      onToolCalls: async (toolCalls) => answer(toolCalls),
    });

    const lines = logger.warn.mock.calls.map((args: unknown[]) => String(args[0]));
    const anomalyLines = lines.filter((l: string) => l.includes('treating the round as tool_use'));
    expect(anomalyLines).toHaveLength(1);
    expect(anomalyLines[0]).toContain('req_zz_46');
    expect(consoleLines.some((l) => l.includes('treating the round as tool_use'))).toBe(false);
  });
});

describe('the Bedrock adapter: block events out of order', () => {
  /** One Bedrock stream of these events (message_start as Bedrock sends it). */
  async function bedrockStream(events: any[], callbacks: Record<string, unknown> = {}): Promise<any> {
    const frames = events.map((e) => chunkFrame(e.type === 'message_start' ? { type: 'message_start', message: { usage: { input_tokens: 10 } } } : e));
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, body: streamBody([...frames, chunkFrame({ type: 'message_stop' })]) })));
    return new BedrockAdapter({ accessKeyId: 'zz-key', secretAccessKey: 'zz-secret', region: 'us-west-2' }).stream(
      { model: 'anthropic.claude-zz-v1:0', messages: [{ role: 'user', content: 'zz prompt' }], maxTokens: 64 } as any,
      { onChunk: () => {}, ...callbacks } as any,
    );
  }

  it('a stream in order marks nothing', async () => {
    const warnings = captureWarnings();
    const res = await bedrockStream([
      messageStart('msg_zz_80'), ...completeToolCall(0, 'toolu_zz_p', '{"query":"a"}'), ...completeToolCall(1, 'toolu_zz_q', '{"query":"b"}'), toolUseEnd,
    ]);
    expect(res.content).toMatchObject([{ id: 'toolu_zz_p', input: { query: 'a' } }, { id: 'toolu_zz_q', input: { query: 'b' } }]);
    expect(res.content.map((b: any) => b.unparseableInput)).toEqual([undefined, undefined]);
    expect(warnings).toEqual([]);
  });

  it('a block left open when a max_tokens stop ends the stream is marked alone', async () => {
    captureWarnings();
    const res = await bedrockStream([
      messageStart('msg_zz_81'), ...completeToolCall(0, 'toolu_zz_r', '{"query":"a"}'), ...unstoppedToolCall(1, 'toolu_zz_s', '{"query":'),
      { type: 'message_delta', delta: { stop_reason: 'max_tokens', stop_sequence: null }, usage: { output_tokens: 64 } },
    ]);
    expect(res.content).toMatchObject([{ id: 'toolu_zz_r', input: { query: 'a' } }, { id: 'toolu_zz_s', input: {}, unparseableInput: '{"query":' }]);
    expect(res.content[0].unparseableInput).toBeUndefined();
  });

  it.each(outOfOrder)('%s breaks block order: every call is marked with its own arguments, with one warning', async (_name, events, expected, _kept, bedrockReports) => {
    const warnings = captureWarnings();
    const reported: unknown[] = [];
    const res = await bedrockStream([messageStart('msg_zz_82'), ...events, toolUseEnd], { onContentBlock: (_index: number, block: any) => { reported.push(block?.id); } });
    expect(res.content).toHaveLength(expected.length);
    expect(res.content).toMatchObject(expected.map((call) => ({ type: 'tool_use', ...call })));
    expect(res.content.map((b: any) => b.input)).toEqual(expected.map(() => ({})));
    expect(reported).toEqual(bedrockReports);
    expect(warnings.filter((w) => w.includes('every tool_use block in the response is marked'))).toHaveLength(1);
  });

  it.each([
    ['a stop', [toolStart(0, 'toolu_zz_l'), argsDelta(0, '{"query":"a"}'), endTurnDelta, blockStop(0)],
      [{ type: 'tool_use', id: 'toolu_zz_l', name: 'zz_lookup', input: {}, unparseableInput: '{"query":"a"}' }]],
    ['a start, its arguments and its stop', [...completeToolCall(0, 'toolu_zz_l', '{"query":"a"}'), endTurnDelta, ...completeToolCall(1, 'toolu_zz_m', '{"query":"b"}')],
      [{ type: 'tool_use', id: 'toolu_zz_l', name: 'zz_lookup', input: { query: 'a' } }]],
    ['the rest of the open call\'s arguments, and its stop', [toolStart(0, 'toolu_zz_l'), argsDelta(0, '{"query":'), endTurnDelta, argsDelta(0, '"a"}'), blockStop(0)],
      [{ type: 'tool_use', id: 'toolu_zz_l', name: 'zz_lookup', input: {}, unparseableInput: '{"query":' }]],
  ])('%s after message_delta: not read, so a call still open there is marked as cut off, with no warning', async (_name, events, expected) => {
    const warnings = captureWarnings();
    const res = await bedrockStream([messageStart('msg_zz_84'), ...events]);
    expect(res.content).toEqual(expected);
    expect(warnings.filter((w) => w.includes('block order') || w.includes('every tool_use block'))).toEqual([]);
  });

  it.each([
    ['a second message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 9 } }],
    ['an error event', { type: 'error', error: { type: 'overloaded_error', message: 'zz overloaded' } }],
    ['a message_start', { type: 'message_start', message: { usage: { input_tokens: 99 } } }],
  ])('%s after message_delta, in the same chunk, is not read, and the body is let go while it is still open', async (_name, late) => {
    captureWarnings();
    let cancelled = false;
    const frames = [{ type: 'message_start', message: { usage: { input_tokens: 10 } } }, ...completeToolCall(0, 'toolu_zz_l', '{"query":"a"}')].map(chunkFrame);
    const ending = [endTurnDelta, late].map(chunkFrame);
    const chunk = new Uint8Array(ending.reduce((length, frame) => length + frame.length, 0));
    ending.reduce((at, frame) => { chunk.set(frame, at); return at + frame.length; }, 0);
    const body = new ReadableStream<Uint8Array>({
      start(controller) { for (const frame of frames) controller.enqueue(frame); controller.enqueue(chunk); },
      cancel() { cancelled = true; },
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, body })));
    const res: any = await new BedrockAdapter({ accessKeyId: 'zz-key', secretAccessKey: 'zz-secret', region: 'us-west-2' }).stream(
      { model: 'anthropic.claude-zz-v1:0', messages: [{ role: 'user', content: 'zz prompt' }], maxTokens: 64 } as any,
      { onChunk: () => {} } as any,
    );
    expect(res.stopReason).toBe('end_turn');
    expect(res.usage).toMatchObject({ inputTokens: 10, outputTokens: 5 });
    expect(res.content).toEqual([{ type: 'tool_use', id: 'toolu_zz_l', name: 'zz_lookup', input: { query: 'a' } }]);
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });

  it('a start below the next index, in a slot an earlier start skipped, breaks block order, and the call fails over the block the message lost', async () => {
    captureWarnings();
    const error = await bedrockStream([
      messageStart('msg_zz_88'), ...completeToolCall(0, 'toolu_zz_a', '{"query":"a"}'), ...completeToolCall(2, 'toolu_zz_c', '{"query":"c"}'),
      ...completeToolCall(1, 'toolu_zz_b', '{"query":"b"}'), toolUseEnd,
    ]).then(() => undefined, (e: unknown) => e);
    expect(error).toMatchObject({ type: 'network', retryable: true });
    expect((error as Error).message).toContain('lost content block 1');
  });

  it.each([...serverCalls, ['server_tool_use, its start without input', serverCallWithoutInput] as [string, Record<string, unknown>]])('a text delta in a server tool call (%s) breaks block order: the call before it is marked, and nothing is streamed', async (_name, block) => {
    const warnings = captureWarnings();
    const chunks: string[] = [];
    const res = await bedrockStream([
      messageStart('msg_zz_89'), ...completeToolCall(0, 'toolu_zz_a', '{"query":"a"}'),
      { type: 'content_block_start', index: 1, content_block: block }, textDelta(1, 'zz text'), blockStop(1), endTurnDelta,
    ], { onChunk: (chunk: string) => { chunks.push(chunk); } });
    expect(res.content).toEqual([{ type: 'tool_use', id: 'toolu_zz_a', name: 'zz_lookup', input: {}, unparseableInput: '{"query":"a"}' }]);
    expect(chunks).toEqual([]);
    expect(warnings.filter((w) => w.includes('every tool_use block in the response is marked'))).toHaveLength(1);
  });

  it.each([
    ['whose block is a number', { type: 'content_block_start', index: 1, content_block: 5 }],
    ['whose index names no slot', { type: 'content_block_start', index: false, content_block: { type: 'text', text: '' } }],
  ])('a start that names no block (%s), while a call is open, and a call after it breaks block order: the open call is marked with its own arguments, with one warning', async (_name, nameless) => {
    const warnings = captureWarnings();
    const res = await bedrockStream([
      messageStart('msg_zz_83'), toolStart(0, 'toolu_zz_a'), argsDelta(0, '{"query":"a"}'),
      nameless, blockStop(0),
      toolStart(1, 'toolu_zz_b'), argsDelta(1, '{"query":"b"}'), blockStop(1), toolUseEnd,
    ]);
    expect(res.content).toHaveLength(1);
    expect(res.content).toMatchObject([{ type: 'tool_use', id: 'toolu_zz_a', unparseableInput: '{"query":"a"}' }]);
    expect(res.content.map((b: any) => b.input)).toEqual([{}]);
    expect(warnings.filter((w) => w.includes('every tool_use block in the response is marked'))).toHaveLength(1);
  });

  it('a start that names no block, at an index already used, breaks block order: the finished call is marked, and a call after it is not applied', async () => {
    const warnings = captureWarnings();
    const res = await bedrockStream([
      messageStart('msg_zz_86'), ...completeToolCall(0, 'toolu_zz_a', '{"query":"a"}'),
      { type: 'content_block_start', index: 0, content_block: 5 }, ...completeToolCall(1, 'toolu_zz_b', '{"query":"b"}'), toolUseEnd,
    ]);
    expect(res.content).toHaveLength(1);
    expect(res.content).toMatchObject([{ type: 'tool_use', id: 'toolu_zz_a', unparseableInput: '{"query":"a"}' }]);
    expect(res.content[0].input).toEqual({});
    expect(warnings.filter((w) => w.includes('every tool_use block in the response is marked'))).toHaveLength(1);
  });

  it('after a start that names no block, a valid start ends the exemption: a delta for another block then breaks block order', async () => {
    const warnings = captureWarnings();
    const res = await bedrockStream([
      messageStart('msg_zz_85'), { type: 'content_block_start', index: 0, content_block: 5 },
      toolStart(0, 'toolu_zz_c'), argsDelta(1, '{"query":"b"}'), blockStop(0), toolUseEnd,
    ]);
    expect(res.content).toHaveLength(1);
    expect(res.content).toMatchObject([{ type: 'tool_use', id: 'toolu_zz_c', unparseableInput: '' }]);
    expect(res.content[0].input).toEqual({});
    expect(warnings.filter((w) => w.includes('every tool_use block in the response is marked'))).toHaveLength(1);
  });

  it('after a start that names no block, a stop for a finished block joins no block: the block is not reported again', async () => {
    captureWarnings();
    const onContentBlock = vi.fn();
    const res = await bedrockStream([
      messageStart('msg_zz_84'), ...completeToolCall(0, 'toolu_zz_h', '{"query":"a"}'),
      { type: 'content_block_start', index: 1, content_block: 5 }, blockStop(0), toolUseEnd,
    ], { onContentBlock });
    expect(res.content).toMatchObject([{ type: 'tool_use', id: 'toolu_zz_h', input: { query: 'a' } }]);
    expect(res.content[0].unparseableInput).toBeUndefined();
    expect(onContentBlock.mock.calls.filter(([index]) => index === 0)).toHaveLength(2);
  });
});

describe('Anthropic response diagnostics on raw', () => {
  it('stream: keeps the message id, request id, message_start (without content), message_delta, and events it does not read', async () => {
    captureWarnings();
    const { adapter } = scriptedAnthropic([{
      requestId: 'req_zz_9',
      events: [
        messageStart('msg_zz_9', { zz_new_start_field: { a: 1 } }),
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'zz text' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'zz_new_delta', payload: 'zz' } },
        { type: 'content_block_stop', index: 0, zz_stop_field: true },
        // The SDK (0.52) yields only the event types it knows, so a new one reaches the adapter only through a later SDK.
        { type: 'zz_new_event', detail: 'zz' },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null, stop_details: null, zz_new_delta_field: 'zz' },
          usage: { output_tokens: 7 },
          zz_new_top_field: 1,
        },
      ],
    }]);
    const res: any = await adapter.stream(
      { model: MODEL, maxTokens: 64, messages: [{ role: 'user', content: [{ type: 'text', text: 'zz' }] }] } as any,
      { onChunk: () => {} } as any,
    );

    expect(res.responseId).toBe('msg_zz_9');
    expect(res.requestId).toBe('req_zz_9');
    expect(res.raw.id).toBe('msg_zz_9');
    expect(res.raw.request_id).toBe('req_zz_9');
    const events = res.raw.provider_events;
    expect(events.message_start.message.zz_new_start_field).toEqual({ a: 1 });
    expect(events.message_start.message.id).toBe('msg_zz_9');
    expect('content' in events.message_start.message).toBe(false);
    expect(events.message_delta).toEqual({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null, stop_details: null, zz_new_delta_field: 'zz' },
      usage: { output_tokens: 7 },
      zz_new_top_field: 1,
    });
    expect(events.unhandled).toEqual([
      { type: 'content_block_delta', index: 0, delta: { type: 'zz_new_delta', payload: 'zz' } },
      { type: 'content_block_stop', index: 0, zz_stop_field: true },
      { type: 'zz_new_event', detail: 'zz' },
    ]);
    expect(res.raw.stop_reason).toBe('end_turn');
    expect(res.raw.content).toEqual([{ type: 'text', text: 'zz text' }]);
    expect(JSON.stringify(events)).not.toContain('zz text');
  });

  it('stream: unhandled events are capped, the rest counted, and an oversized one truncated', async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ type: 'zz_noise', i }));
    const big = { type: 'zz_big', blob: 'z'.repeat(10_000) };
    const { adapter } = scriptedAnthropic([{
      events: [
        messageStart('msg_zz_10'),
        big,
        ...many,
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
      ],
    }]);
    const res: any = await adapter.stream(
      { model: MODEL, maxTokens: 64, messages: [{ role: 'user', content: [{ type: 'text', text: 'zz' }] }] } as any,
      { onChunk: () => {} } as any,
    );
    const events = res.raw.provider_events;
    expect(events.unhandled).toHaveLength(20);
    expect(events.unhandled_omitted).toBe(6);
    expect(events.unhandled[0]).toMatchObject({ type: 'zz_big', truncated: true });
    expect(events.unhandled[0].json.length).toBe(4096);
  });

  it('stream: the cap keeps the first 20 unread deltas, in order', async () => {
    const deltas = Array.from({ length: 25 }, (_, i) => ({ type: 'content_block_delta', index: 0, delta: { type: 'zz_new_delta', i } }));
    const { adapter } = scriptedAnthropic([{
      events: [
        messageStart('msg_zz_48'),
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        ...deltas,
        { type: 'content_block_stop', index: 0 },
        endTurnDelta,
      ],
    }]);
    const res: any = await adapter.stream(
      { model: MODEL, maxTokens: 64, messages: [{ role: 'user', content: [{ type: 'text', text: 'zz' }] }] } as any,
      { onChunk: () => {} } as any,
    );
    const events = res.raw.provider_events;
    expect(events.unhandled.map((e: any) => e.delta.i)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(events.unhandled_omitted).toBe(5);
  });

  it('stream: an oversized message_start or message_delta is bounded like the rest, keeping the head of its JSON', async () => {
    const bigDelta = {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null, zz_blob: 'd'.repeat(5000) },
      usage: { output_tokens: 1 },
    };
    const { adapter } = scriptedAnthropic([{ events: [messageStart('msg_zz_49', { zz_blob: 's'.repeat(5000) }), bigDelta] }]);
    const res: any = await adapter.stream(
      { model: MODEL, maxTokens: 64, messages: [{ role: 'user', content: [{ type: 'text', text: 'zz' }] }] } as any,
      { onChunk: () => {} } as any,
    );
    const events = res.raw.provider_events;
    expect(events.message_delta).toEqual({ type: 'message_delta', truncated: true, json: JSON.stringify(bigDelta).slice(0, 4096) });
    expect(events.message_start).toMatchObject({ type: 'message_start', truncated: true });
    expect(events.message_start.json.startsWith('{"type":"message_start","message":{"id":"msg_zz_49"')).toBe(true);
  });

  it('stream: an ordinary content_block_stop is not kept as unread', async () => {
    const { adapter } = scriptedAnthropic([{ events: finalText('msg_zz_50') }]);
    const res: any = await adapter.stream(
      { model: MODEL, maxTokens: 64, messages: [{ role: 'user', content: [{ type: 'text', text: 'zz' }] }] } as any,
      { onChunk: () => {} } as any,
    );
    expect(res.raw.provider_events.unhandled).toBeUndefined();
  });

  it('stream without a request id (a transport that exposes none) leaves it out', async () => {
    const { adapter } = scriptedAnthropic([{ events: finalText('msg_zz_11') }]);
    const res: any = await adapter.stream(
      { model: MODEL, maxTokens: 64, messages: [{ role: 'user', content: [{ type: 'text', text: 'zz' }] }] } as any,
      { onChunk: () => {} } as any,
    );
    expect(res.raw.id).toBe('msg_zz_11');
    expect('request_id' in res.raw).toBe(false);
    expect(res.requestId).toBeUndefined();
  });

  it('complete: the SDK\'s non-enumerable request id reaches the serialized raw response', async () => {
    const adapter = new AnthropicAdapter({ apiKey: 'zz-key', cacheKeepalive: { enabled: false } });
    const message = {
      id: 'msg_zz_12', type: 'message', role: 'assistant', model: MODEL,
      content: [{ type: 'text', text: 'zz' }],
      stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
    };
    Object.defineProperty(message, '_request_id', { value: 'req_zz_12', enumerable: false });
    (adapter as any).client = { withOptions() { return this; }, messages: { create: async () => message } };

    const res: any = await adapter.complete(
      { model: MODEL, maxTokens: 64, messages: [{ role: 'user', content: [{ type: 'text', text: 'zz' }] }] } as any,
    );
    expect(res.responseId).toBe('msg_zz_12');
    expect(res.requestId).toBe('req_zz_12');
    const serialized = JSON.parse(JSON.stringify(res.raw));
    expect(serialized.id).toBe('msg_zz_12');
    expect(serialized.request_id).toBe('req_zz_12');
  });
});
