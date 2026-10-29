/**
 * emitToolInputDeltas: a native tool call's argument JSON streams as 'tokens'
 * events (meta.type 'tool_call', toolCallPart 'input') while the model writes
 * it, for consumers that act on a call before it completes (speech).
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
          if (i < events.length) return { value: events[i++], done: false };
          return { value: undefined, done: true };
        },
      };
    },
  };
}

function scriptedAnthropic(rounds: unknown[][]) {
  const adapter = new AnthropicAdapter({ apiKey: 'zz-key', cacheKeepalive: { enabled: false } });
  let call = 0;
  (adapter as any).client = {
    withOptions() { return this; },
    messages: {
      stream: async () => {
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

function request(stopSequences?: string[]): NormalizedRequest {
  return {
    messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz go' }] }],
    config: { model: MODEL, maxTokens: 64 },
    ...(stopSequences ? { stopSequences } : {}),
    toolMode: 'native',
    tools: [{ name: 'channel_publish', description: 'zz', inputSchema: { type: 'object', properties: { channelId: { type: 'string' }, content: { type: 'string' } } } }],
  };
}

const answer = (calls: ToolCall[]): ToolResult[] => calls.map((c) => ({ toolUseId: c.id, content: 'ok', isError: false }));

async function run(options: YieldingStreamOptions, stopSequences?: string[], script: unknown[][] = rounds()) {
  const stream = new Membrane(scriptedAnthropic(script), { formatter: new NativeFormatter() })
    .streamYielding(request(stopSequences), options);
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
    expect((events[toolCalls] as any).calls[0].input).toEqual({ channelId: 'bosun:meeting:1', content: 'Hello there.\nYes' });
    // Visible text is unchanged.
    expect(events.filter((e) => e.type === 'tokens' && e.meta.type === 'text').map((e: any) => e.content).join('')).toBe('zz prezz done');
  });

  it('is off by default', async () => {
    expect(toolTokens(await run({}))).toEqual([]);
  });

  it('needs emitTokens', async () => {
    expect(toolTokens(await run({ emitToolInputDeltas: true, emitTokens: false }))).toEqual([]);
  });

  it('streams through local stop-sequence handling, which holds block starts', async () => {
    const events = await run({ emitToolInputDeltas: true }, ['ZZSTOP']);
    const tokens = toolTokens(events);
    expect(tokens.map((t) => t.content)).toEqual(FRAGMENTS);
    expect(tokens[0].meta).toMatchObject({ toolId: 'toolu_zz_1', toolName: 'channel_publish' });
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
