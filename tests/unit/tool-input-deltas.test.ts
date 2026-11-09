/**
 * emitToolInputDeltas: a native tool call's argument JSON streams as 'tokens'
 * events (meta.type 'tool_call', toolCallPart 'input') as the API sends it,
 * for consumers that act on a call before it completes (speech).
 */
import { describe, it, expect } from 'vitest';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { Membrane } from '../../src/membrane.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import type { NormalizedRequest, StreamEvent, ToolCall, ToolResult, YieldingStreamOptions } from '../../src/types/index.js';

const MODEL = 'claude-zz-1';

function fakeAnthropicStream(events: unknown[]) {
  return {
    controller: { abort() { } },
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          while (i < events.length && (events[i] as { gate?: Promise<void> }).gate) await (events[i++] as { gate: Promise<void> }).gate;
          if (i < events.length) return { value: events[i++], done: false };
          return { value: undefined, done: true };
        },
      };
    },
  };
}

function scriptedAnthropic(rounds: unknown[][], sent: any[] = [], headers: unknown[] = []) {
  const adapter = new AnthropicAdapter({ apiKey: 'zz-key', cacheKeepalive: { enabled: false } });
  let call = 0;
  (adapter as any).client = {
    withOptions() { return this; },
    messages: {
      stream: async (params: unknown, options?: { headers?: unknown }) => {
        sent.push(params);
        headers.push(options?.headers ?? null);
        const round = rounds[call++];
        if (!round) throw new Error(`unscripted provider call ${call}`);
        return fakeAnthropicStream(round);
      },
    },
  };
  return adapter;
}

const messageStart = (id: string) => ({
  type: 'message_start',
  message: {
    id, type: 'message', role: 'assistant', model: MODEL, content: [],
    stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 },
  },
});
const textBlock = (index: number, text: string) => [
  { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index, delta: { type: 'text_delta', text } },
  { type: 'content_block_stop', index },
];
const toolBlock = (index: number, id: string, name: string, fragments: string[]) => [
  { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } },
  ...fragments.map((partial_json) => ({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } })),
  { type: 'content_block_stop', index },
];
const end = (stop_reason: string) => ({ type: 'message_delta', delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: 5 } });

const FRAGMENTS = ['{"channelId": "bosun:me', 'eting:1", "con', 'tent": "Hello', ' there.\\nYes"}'];

function rounds(): unknown[][] {
  return [
    [messageStart('msg_zz_1'), ...textBlock(0, 'zz pre'), ...toolBlock(1, 'toolu_zz_1', 'channel_publish', FRAGMENTS), end('tool_use')],
    [messageStart('msg_zz_2'), ...textBlock(0, 'zz done'), end('end_turn')],
  ];
}

function request(stopSequences?: string[], toolName = 'channel_publish'): NormalizedRequest {
  return {
    messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz go' }] }],
    config: { model: MODEL, maxTokens: 64 },
    ...(stopSequences ? { stopSequences } : {}),
    toolMode: 'native',
    tools: [{ name: toolName, description: 'zz', inputSchema: { type: 'object', properties: { channelId: { type: 'string' }, content: { type: 'string' } } } }],
  };
}

const answer = (calls: ToolCall[]): ToolResult[] => calls.map((c) => ({ toolUseId: c.id, content: 'ok', isError: false }));

async function run(
  options: YieldingStreamOptions,
  stopSequences?: string[],
  script: unknown[][] = rounds(),
  toolName?: string,
  sent: unknown[] = [],
  headers: unknown[] = [],
) {
  const stream = new Membrane(scriptedAnthropic(script, sent, headers), { formatter: new NativeFormatter() })
    .streamYielding(request(stopSequences, toolName), options);
  const events: StreamEvent[] = [];
  for await (const event of stream as AsyncIterable<StreamEvent>) {
    events.push(event);
    if (event.type === 'tool-calls') stream.provideToolResults(answer(event.calls));
    else if (event.type === 'complete') break;
    else if (event.type === 'error' || event.type === 'aborted') throw new Error(`stream ended with ${event.type}`);
  }
  return events;
}

const toolTokens = (events: StreamEvent[]) =>
  events.filter((e): e is Extract<StreamEvent, { type: 'tokens' }> => e.type === 'tokens' && e.meta.type === 'tool_call');
const toolCallsEvents = (events: StreamEvent[]) =>
  events.filter((e): e is Extract<StreamEvent, { type: 'tool-calls' }> => e.type === 'tool-calls');
const completed = (events: StreamEvent[]) =>
  events.find((e): e is Extract<StreamEvent, { type: 'complete' }> => e.type === 'complete')!;
const PUBLISHED = { channelId: 'bosun:meeting:1', content: 'Hello there.\nYes' };

describe('emitToolInputDeltas', () => {
  it('streams each argument fragment, in order, with the call id and name, before the tool-calls event', async () => {
    const events = await run({ emitToolInputDeltas: true });
    const tokens = toolTokens(events);
    expect(tokens.map((t) => t.content)).toEqual(FRAGMENTS);
    for (const t of tokens) {
      expect(t.meta).toMatchObject({ type: 'tool_call', visible: false, toolCallPart: 'input', toolId: 'toolu_zz_1', toolName: 'channel_publish', blockIndex: 1 });
    }
    const lastDelta = events.lastIndexOf(tokens[tokens.length - 1]);
    const toolCalls = events.findIndex((e) => e.type === 'tool-calls');
    expect(lastDelta).toBeLessThan(toolCalls);
    expect((events[toolCalls] as any).calls[0].input).toEqual(PUBLISHED);
    // Visible text is unchanged.
    expect(events.filter((e) => e.type === 'tokens' && e.meta.type === 'text').map((e: any) => e.content).join('')).toBe('zz prezz done');
  });

  it('streams each fragment while its block is still open', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tool = toolBlock(1, 'toolu_zz_1', 'channel_publish', FRAGMENTS);
    const script = rounds();
    script[0] = [messageStart('msg_zz_1'), ...textBlock(0, 'zz pre'), ...tool.slice(0, -1), { gate }, tool[tool.length - 1], end('tool_use')];
    const stream = new Membrane(scriptedAnthropic(script), { formatter: new NativeFormatter() })
      .streamYielding(request(), { emitToolInputDeltas: true });
    const seen: string[] = [];
    for await (const event of stream as AsyncIterable<StreamEvent>) {
      if (event.type === 'tokens' && event.meta.type === 'tool_call') {
        seen.push(event.content);
        if (seen.length === FRAGMENTS.length) release();
      } else if (event.type === 'tool-calls') stream.provideToolResults(answer(event.calls));
      else if (event.type === 'complete') break;
      else if (event.type === 'error' || event.type === 'aborted') throw new Error(`stream ended with ${event.type}`);
    }
    expect(seen).toEqual(FRAGMENTS);
  }, 2_000);

  it('changes no request: the requests and their headers are the same with it off and on', async () => {
    for (const stops of [undefined, ['ZZSTOP']]) {
      const [offSent, offHeaders, onSent, onHeaders]: unknown[][] = [[], [], [], []];
      await run({}, stops, rounds(), undefined, offSent, offHeaders);
      await run({ emitToolInputDeltas: true }, stops, rounds(), undefined, onSent, onHeaders);
      expect(offSent).toHaveLength(2);
      expect(JSON.stringify(onSent)).toBe(JSON.stringify(offSent));
      expect(JSON.stringify(onHeaders)).toBe(JSON.stringify(offHeaders));
    }
  });

  it('is off by default', async () => {
    const events = await run({});
    expect(toolTokens(events)).toEqual([]);
    expect(toolCallsEvents(events).map((e) => e.calls[0].input)).toEqual([PUBLISHED]);
  });

  it('needs emitTokens', async () => {
    const events = await run({ emitToolInputDeltas: true, emitTokens: false });
    expect(toolTokens(events)).toEqual([]);
    expect(toolCallsEvents(events).map((e) => e.calls[0].input)).toEqual([PUBLISHED]);
  });

  it('streams through local stop-sequence handling, which holds block starts', async () => {
    const events = await run({ emitToolInputDeltas: true }, ['ZZSTOP']);
    const tokens = toolTokens(events);
    expect(tokens.map((t) => t.content)).toEqual(FRAGMENTS);
    expect(tokens[0].meta).toMatchObject({ toolId: 'toolu_zz_1', toolName: 'channel_publish' });
  });

  it('streams none of a tool call that a local stop in the text before it cuts off', async () => {
    const script = [[messageStart('msg_zz_1'), ...textBlock(0, 'zz pre ZZSTOP after'), ...toolBlock(1, 'toolu_zz_1', 'channel_publish', FRAGMENTS), end('tool_use')]];
    const events = await run({ emitToolInputDeltas: true }, ['ZZSTOP'], script);
    expect(events.filter((e) => e.type === 'tokens').map((e: any) => e.content).join('')).toBe('zz pre ');
    expect(toolCallsEvents(events)).toEqual([]);
    expect(completed(events).response.stopReason).toBe('stop_sequence');
  });

  it('matches no stop inside the arguments: the fragments and the call arrive whole', async () => {
    const fragments = ['{"channelId": "bosun:meeting:1", "content": "say ZZ', 'STOP now"}'];
    const script = rounds();
    script[0] = [messageStart('msg_zz_1'), ...textBlock(0, 'zz pre'), ...toolBlock(1, 'toolu_zz_1', 'channel_publish', fragments), end('tool_use')];
    const events = await run({ emitToolInputDeltas: true }, ['ZZSTOP'], script);
    expect(toolTokens(events).map((t) => t.content)).toEqual(fragments);
    expect(toolCallsEvents(events).map((e) => e.calls[0].input)).toEqual([{ channelId: 'bosun:meeting:1', content: 'say ZZSTOP now' }]);
  });

  it('streams the fragments of a call that max_tokens cuts off, and that call never reaches tool-calls', async () => {
    const script = [[
      messageStart('msg_zz_1'),
      ...textBlock(0, 'zz pre'),
      ...toolBlock(1, 'toolu_zz_1', 'channel_publish', FRAGMENTS.slice(0, 2)).slice(0, -1),
      end('max_tokens'),
    ]];
    const events = await run({ emitToolInputDeltas: true }, undefined, script);
    expect(toolTokens(events).map((t) => t.content)).toEqual(FRAGMENTS.slice(0, 2));
    expect(toolCallsEvents(events)).toEqual([]);
    expect(completed(events).response.stopReason).toBe('max_tokens');
  });

  it("streams a refused attempt's fragments, then retrying, then the next attempt's under its own id", async () => {
    const script = [
      [messageStart('msg_zz_1'), ...toolBlock(0, 'toolu_zz_a', 'channel_publish', ['{"content": "Fir', 'st"}']), end('refusal')],
      [messageStart('msg_zz_2'), ...toolBlock(0, 'toolu_zz_b', 'channel_publish', ['{"content": "Sec', 'ond"}']), end('tool_use')],
      [messageStart('msg_zz_3'), ...textBlock(0, 'zz done'), end('end_turn')],
    ];
    const events = await run({ emitToolInputDeltas: true, refusalRetries: 1 }, undefined, script);
    const seen = events.flatMap((e) =>
      e.type === 'retrying' ? ['retrying'] : e.type === 'tokens' && e.meta.type === 'tool_call' ? [`${e.meta.toolId}:${e.content}`] : []);
    expect(seen).toEqual(['toolu_zz_a:{"content": "Fir', 'toolu_zz_a:st"}', 'retrying', 'toolu_zz_b:{"content": "Sec', 'toolu_zz_b:ond"}']);
    expect(toolCallsEvents(events).map((e) => e.calls.map((c) => c.id))).toEqual([['toolu_zz_b']]);
  });

  it("names the caller's tool, not the name it was sent under", async () => {
    const script = rounds();
    script[0] = [messageStart('msg_zz_1'), ...toolBlock(0, 'toolu_zz_1', 'channel__publish', FRAGMENTS), end('tool_use')];
    const events = await run({ emitToolInputDeltas: true }, undefined, script, 'channel:publish');
    const tokens = toolTokens(events);
    expect(tokens.map((t) => t.content)).toEqual(FRAGMENTS);
    expect(tokens.every((t) => t.meta.toolName === 'channel:publish')).toBe(true);
    expect(toolCallsEvents(events)[0].calls[0].name).toBe('channel:publish');
  });

  it('reports no fragment that arrives inside a text block, and the stream goes on', async () => {
    const seen: Array<[number, string]> = [];
    const chunks: string[] = [];
    const res: any = await scriptedAnthropic([[
      messageStart('msg_zz_1'),
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'zz pre' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"content": "zz"}' } },
      { type: 'content_block_stop', index: 0 },
      end('end_turn'),
    ]]).stream(
      { model: MODEL, maxTokens: 64, messages: [{ role: 'user', content: [{ type: 'text', text: 'zz go' }] }] } as any,
      {
        onChunk: (chunk: string) => { chunks.push(chunk); },
        onToolInputDelta: (index: number, fragment: string) => { seen.push([index, fragment]); },
      } as any,
    );
    expect(seen).toEqual([]);
    expect(chunks).toEqual(['zz pre']);
    expect(res.stopReason).toBe('end_turn');
    expect(res.content).toEqual([{ type: 'text', text: 'zz pre' }]);
  });

  it("keeps a turn's tool calls when a block of a type membrane doesn't know carries an argument delta, and reports none of it", async () => {
    const unknownBlock = [
      { type: 'content_block_start', index: 0, content_block: { type: 'zz_future_tool_use', id: 'zz_1' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"zz": 1}' } },
      { type: 'content_block_stop', index: 0 },
    ];
    const script = () => [
      [messageStart('msg_zz_1'), ...unknownBlock, ...toolBlock(1, 'toolu_zz_1', 'channel_publish', FRAGMENTS), end('tool_use')],
      [messageStart('msg_zz_2'), ...textBlock(0, 'zz done'), end('end_turn')],
    ];
    for (const options of [{}, { emitToolInputDeltas: true }]) {
      const events = await run(options, undefined, script());
      const calls = toolCallsEvents(events);
      expect(calls).toHaveLength(1);
      expect(calls[0].calls.map((c) => [c.id, c.input])).toEqual([['toolu_zz_1', PUBLISHED]]);
      expect(toolTokens(events).map((t) => t.content)).toEqual(options.emitToolInputDeltas ? FRAGMENTS : []);
    }
  });

  it('reports each non-empty fragment of a tool_use, server_tool_use or mcp_tool_use block to onToolInputDelta, and none of a block of an unknown type', async () => {
    const seen: Array<[number, string]> = [];
    const block = (index: number, content_block: unknown, fragments: string[]) => [
      { type: 'content_block_start', index, content_block },
      ...fragments.map((partial_json) => ({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } })),
      { type: 'content_block_stop', index },
    ];
    await scriptedAnthropic([[
      messageStart('msg_zz_1'),
      ...block(0, { type: 'zz_future_tool_use', id: 'zz_1' }, ['{"zz": 1}']),
      ...block(1, { type: 'server_tool_use', id: 'srvtoolu_zz_1', name: 'web_search', input: {} }, ['{"query": "zz"}']),
      ...block(2, { type: 'mcp_tool_use', id: 'mcptoolu_zz_1', name: 'zz_lookup', server_name: 'zz', input: {} }, ['{"id": 1}']),
      ...block(3, { type: 'tool_use', id: 'toolu_zz_1', name: 'channel_publish', input: {} }, ['', ...FRAGMENTS]),
      end('tool_use'),
    ]]).stream(
      { model: MODEL, maxTokens: 64, messages: [{ role: 'user', content: [{ type: 'text', text: 'zz go' }] }] } as any,
      {
        onChunk: () => {},
        onToolInputDelta: (index: number, fragment: string) => { seen.push([index, fragment]); },
      } as any,
    );
    expect(seen).toEqual([[1, '{"query": "zz"}'], [2, '{"id": 1}'], ...FRAGMENTS.map((fragment) => [3, fragment])]);
  });

  it("leaves a server tool's streamed input out: only the caller's own tool calls stream", async () => {
    const serverTool = [
      { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srvtoolu_zz_1', name: 'web_search', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query": "zz' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: ' weather"}' } },
      { type: 'content_block_stop', index: 0 },
    ];
    const script = rounds();
    script[0] = [messageStart('msg_zz_1'), ...serverTool, ...toolBlock(1, 'toolu_zz_1', 'channel_publish', FRAGMENTS), end('tool_use')];
    const tokens = toolTokens(await run({ emitToolInputDeltas: true }, undefined, script));
    expect(tokens.map((t) => t.content)).toEqual(FRAGMENTS);
    expect(tokens.every((t) => t.meta.toolId === 'toolu_zz_1')).toBe(true);
  });
});
