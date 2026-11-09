/**
 * A tool call's arguments keep an integer the model wrote past Number.MAX_SAFE_INTEGER as its digits, a string,
 * wherever membrane parses them from text, so a long id written unquoted (a Discord snowflake) reaches the tool as
 * written instead of rounded.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { toolUseInputFromText } from '../../src/providers/utils.js';
import { keepLongIntegers } from '../../src/utils/long-integers.js';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { BedrockAdapter } from '../../src/providers/bedrock.js';
import { fromOpenAIContent } from '../../src/providers/openai.js';
import { parseToolCalls } from '../../src/utils/tool-parser.js';
import { Membrane } from '../../src/membrane.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import type { NormalizedRequest, StreamEvent, ToolCall } from '../../src/types/index.js';

const SNOWFLAKE = '1437820485836259419';

describe('toolUseInputFromText keeps an unsafe integer as its digits', () => {
  it('keeps a positive and a negative one, at any depth', () => {
    expect(toolUseInputFromText(`{"id": ${SNOWFLAKE}}`)).toStrictEqual({ input: { id: SNOWFLAKE } });
    expect(toolUseInputFromText(`{"id": -${SNOWFLAKE}}`)).toStrictEqual({ input: { id: `-${SNOWFLAKE}` } });
    expect(toolUseInputFromText(`{"a": {"b": [${SNOWFLAKE}, 5]}}`)).toStrictEqual({ input: { a: { b: [SNOWFLAKE, 5] } } });
  });

  it('keeps the boundary: the largest safe integer stays a number, the next unsafe one becomes text', () => {
    expect(toolUseInputFromText('{"n": 9007199254740991}')).toStrictEqual({ input: { n: 9007199254740991 } });
    expect(toolUseInputFromText('{"n": 9007199254740992}')).toStrictEqual({ input: { n: '9007199254740992' } });
    expect(toolUseInputFromText('{"n": 9007199254740993}')).toStrictEqual({ input: { n: '9007199254740993' } });
    expect(toolUseInputFromText('{"n": -9007199254740993}')).toStrictEqual({ input: { n: '-9007199254740993' } });
  });

  it('leaves every other value as JSON.parse gives it', () => {
    expect(toolUseInputFromText('{"a": 1e20, "b": 1.5, "c": 12345678901234567890.5, "d": 42}'))
      .toStrictEqual({ input: { a: 1e20, b: 1.5, c: 12345678901234567890.5, d: 42 } });
    expect(toolUseInputFromText(`{"id": "${SNOWFLAKE}"}`)).toStrictEqual({ input: { id: SNOWFLAKE } });
    expect(toolUseInputFromText('{"a": 1E400, "b": 12345678901234567890.0, "c": 9007199254740993e0, "d": -0}'))
      .toStrictEqual({ input: { a: Infinity, b: 12345678901234567890.0, c: 9007199254740993e0, d: -0 } });
  });

  it('on a runtime that gives the reviver no source text, every value is as JSON.parse gives it', () => {
    for (const value of [1.5, 1e20, Number(SNOWFLAKE), 42]) expect(keepLongIntegers('', value)).toBe(value);
  });
});

function scriptedAnthropic(events: unknown[]) {
  const adapter = new AnthropicAdapter({ apiKey: 'zz-key', cacheKeepalive: { enabled: false } });
  (adapter as any).client = {
    withOptions() { return this; },
    messages: {
      stream: async () => ({
        controller: { abort() { } },
        [Symbol.asyncIterator]() {
          let i = 0;
          return { async next() { return i < events.length ? { value: events[i++], done: false } : { value: undefined, done: true }; } };
        },
      }),
    },
  };
  return adapter;
}

describe('each route a tool call takes keeps the digits', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('Anthropic, streamed: the integer split across two input_json_delta fragments', async () => {
    const events = [
      { type: 'message_start', message: { id: 'msg_zz', type: 'message', role: 'assistant', model: 'claude-zz-1', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_zz', name: 'open', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"channelId": 14378204' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '85836259419}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } },
    ];
    const request: NormalizedRequest = {
      messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz go' }] }],
      config: { model: 'claude-zz-1', maxTokens: 64 },
      toolMode: 'native',
      tools: [{ name: 'open', description: 'zz', inputSchema: { type: 'object', properties: { channelId: { type: 'string' } } } }],
    };
    const stream = new Membrane(scriptedAnthropic(events), { formatter: new NativeFormatter() }).streamYielding(request, {});
    let calls: ToolCall[] = [];
    for await (const event of stream as AsyncIterable<StreamEvent>) {
      if (event.type === 'tool-calls') { calls = event.calls; break; }
      if (event.type === 'complete' || event.type === 'error' || event.type === 'aborted') break;
    }
    expect(calls.map((c) => c.input)).toStrictEqual([{ channelId: SNOWFLAKE }]);
  });

  it('OpenAI-style: the arguments string', () => {
    const blocks = fromOpenAIContent({ role: 'assistant', content: null, tool_calls: [{ id: 'call_zz', type: 'function', function: { name: 'open', arguments: `{"channelId": ${SNOWFLAKE}}` } }] } as any);
    expect(blocks).toStrictEqual([{ type: 'tool_use', id: 'call_zz', name: 'open', input: { channelId: SNOWFLAKE } }]);
  });

  it('Bedrock, not streamed: the response body', async () => {
    const body = `{"id":"msg_zz","type":"message","role":"assistant","model":"zz","content":[{"type":"tool_use","id":"toolu_zz","name":"open","input":{"channelId":${SNOWFLAKE}}}],"stop_reason":"tool_use","usage":{"input_tokens":1,"output_tokens":1}}`;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body })));
    const adapter = new BedrockAdapter({ accessKeyId: 'test-key', secretAccessKey: 'test-secret', region: 'us-west-2' });
    const result = await adapter.complete({ model: 'us.anthropic.claude-sonnet-4-20250514-v1:0', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 } as any);
    expect(result.content).toStrictEqual([{ type: 'tool_use', id: 'toolu_zz', name: 'open', input: { channelId: SNOWFLAKE } }]);
  });

  it('Bedrock, streamed: a block start that carries the arguments itself', async () => {
    const events = [
      '{"type":"message_start","message":{"usage":{"input_tokens":1}}}',
      `{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_zz","name":"open","input":{"channelId":${SNOWFLAKE}}}}`,
      '{"type":"content_block_stop","index":0}',
      '{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":2}}',
      '{"type":"message_stop"}',
    ];
    const frames = events.map(bedrockChunk);
    const body = new ReadableStream<Uint8Array>({ start(c) { for (const f of frames) c.enqueue(f); c.close(); } });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, body })));
    const adapter = new BedrockAdapter({ accessKeyId: 'test-key', secretAccessKey: 'test-secret', region: 'us-west-2' });
    const result = await adapter.stream({ model: 'us.anthropic.claude-sonnet-4-20250514-v1:0', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 } as any, { onChunk: () => {} });
    expect(result.content).toStrictEqual([{ type: 'tool_use', id: 'toolu_zz', name: 'open', input: { channelId: SNOWFLAKE } }]);
  });
});

/** One event-stream frame of Bedrock's response stream, carrying `json` as written, so an unquoted long integer survives. */
function bedrockChunk(json: string): Uint8Array {
  const encode = (s: string) => new TextEncoder().encode(s);
  const name = encode(':event-type');
  const value = encode('chunk');
  const headers = new Uint8Array(1 + name.length + 1 + 2 + value.length);
  headers[0] = name.length;
  headers.set(name, 1);
  headers[1 + name.length] = 7;
  new DataView(headers.buffer).setUint16(2 + name.length, value.length, false);
  headers.set(value, 4 + name.length);
  const payload = encode(JSON.stringify({ bytes: Buffer.from(encode(json)).toString('base64') }));
  const frame = new Uint8Array(12 + headers.length + payload.length + 4);
  const view = new DataView(frame.buffer);
  view.setUint32(0, frame.length, false);
  view.setUint32(4, headers.length, false);
  frame.set(headers, 12);
  frame.set(payload, 12 + headers.length);
  return frame;
}

describe('XML mode keeps the digits at both of its parses', () => {
  const xml = `<function_calls>
<invoke name="open">
<parameter name="target">{"channelId": ${SNOWFLAKE}}</parameter>
<parameter name="id">-${SNOWFLAKE}</parameter>
</invoke>
</function_calls>`;

  it('a parameter with no declaration: a nested one and a negative one', () => {
    expect(parseToolCalls(xml)?.calls[0]?.input).toStrictEqual({ target: { channelId: SNOWFLAKE }, id: `-${SNOWFLAKE}` });
  });

  it('a parameter declared an object, an integer or a number: a nested one and a negative one, with no type warning', () => {
    const tools = [{ name: 'open', description: 'zz', inputSchema: { type: 'object' as const, properties: { target: { type: 'object' }, id: { type: 'integer' }, n: { type: 'number' } } } }];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const withN = xml.replace('</invoke>', `<parameter name="n">-${SNOWFLAKE}</parameter>\n</invoke>`);
      expect(parseToolCalls(withN, { tools })?.calls[0]?.input).toStrictEqual({ target: { channelId: SNOWFLAKE }, id: `-${SNOWFLAKE}`, n: `-${SNOWFLAKE}` });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('a negative long id for another declared type is passed through as text, with the same warning as a positive one', () => {
    const tools = [{ name: 'open', description: 'zz', inputSchema: { type: 'object' as const, properties: { flag: { type: 'boolean' } } } }];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const call = `<function_calls>\n<invoke name="open">\n<parameter name="flag">-${SNOWFLAKE}</parameter>\n</invoke>\n</function_calls>`;
      expect(parseToolCalls(call, { tools })?.calls[0]?.input).toStrictEqual({ flag: `-${SNOWFLAKE}` });
      expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([expect.stringContaining('too large to represent exactly')]);
    } finally {
      warn.mockRestore();
    }
  });
});
