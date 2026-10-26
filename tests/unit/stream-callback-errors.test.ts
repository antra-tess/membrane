import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { BedrockAdapter } from '../../src/providers/bedrock.js';
import { GeminiAdapter } from '../../src/providers/gemini.js';
import { OpenAIAdapter } from '../../src/providers/openai.js';
import { OpenAICompatibleAdapter } from '../../src/providers/openai-compatible.js';
import { OpenAICompletionsAdapter } from '../../src/providers/openai-completions.js';
import { OpenAIResponsesAPIAdapter } from '../../src/providers/openai-responses-api.js';
import { OpenRouterAdapter } from '../../src/providers/openrouter.js';
import { MembraneError, type NormalizedRequest, type ProviderAdapter, type ProviderRequest } from '../../src/types/index.js';
import { Membrane } from '../../src/membrane.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { chunkFrame, stringHeader } from '../helpers/bedrock-event-stream.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const wire: ProviderRequest = { model: 'zz-review-model', messages: [{ role: 'user', content: 'go' }], maxTokens: 16 };
const bedrockWire = { ...wire, model: 'anthropic.claude-3-5-sonnet-20241022-v2:0' } as ProviderRequest;

function body(pieces: Uint8Array[], open = false): { stream: ReadableStream<Uint8Array>; cancelled: () => boolean } {
  let cancelled = false;
  const queue = [...pieces];
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = queue.shift();
      if (next) controller.enqueue(next);
      else if (!open) controller.close();
      else return new Promise(() => {});
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  return { stream, cancelled: () => cancelled };
}

const sseLines = (frames: unknown[]): Uint8Array[] =>
  frames.map(frame => new TextEncoder().encode('data: ' + (typeof frame === 'string' ? frame : JSON.stringify(frame)) + '\n\n'));

const sseResponse = (frames: unknown[], open = false) => {
  const b = body(sseLines(frames), open);
  return { response: new Response(b.stream, { headers: { 'content-type': 'text/event-stream' } }), cancelled: b.cancelled };
};

const chat = (content: string, finish?: string) => ({ choices: [{ delta: { content }, ...(finish ? { finish_reason: finish } : {}) }] });
const completion = (text: string, finish?: string) => ({ choices: [{ text, ...(finish ? { finish_reason: finish } : {}) }] });

const bedrockEvents = (text: string) => [
  { type: 'message_start', message: { usage: { input_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' more' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
  { type: 'message_stop' },
];
const MESSAGE_DELTA_INDEX = bedrockEvents('').findIndex((event) => event.type === 'message_delta');
const bedrockResponse = (frames: Uint8Array[], open = false) => {
  const b = body(frames, open);
  return { response: { ok: true, status: 200, body: b.stream } as unknown as Response, cancelled: b.cancelled };
};
const bedrock = () => new BedrockAdapter({ accessKeyId: 'zz-key', secretAccessKey: 'zz-secret', region: 'us-east-1' });

interface Case { name: string; make: () => ProviderAdapter; request: ProviderRequest; respond: (open?: boolean) => { response: Response; cancelled: () => boolean } }

const formerlySwallowing: Case[] = [
  { name: 'openai', make: () => new OpenAIAdapter({ apiKey: 'zz-key' }), request: wire, respond: open => sseResponse([chat('hello'), chat(' world', 'stop'), '[DONE]'], open) },
  { name: 'openai-compatible', make: () => new OpenAICompatibleAdapter({ apiKey: 'zz-key', baseURL: 'https://review.invalid/v1' }), request: wire, respond: open => sseResponse([chat('hello'), chat(' world', 'stop'), '[DONE]'], open) },
  { name: 'openai-completions', make: () => new OpenAICompletionsAdapter({ apiKey: 'zz-key', baseURL: 'https://review.invalid/v1' }), request: wire, respond: open => sseResponse([completion('hello'), completion(' world', 'stop'), '[DONE]'], open) },
  { name: 'openrouter', make: () => new OpenRouterAdapter({ apiKey: 'zz-key' }), request: wire, respond: open => sseResponse([chat('hello'), chat(' world', 'stop'), '[DONE]'], open) },
  { name: 'bedrock', make: bedrock, request: bedrockWire, respond: open => bedrockResponse(bedrockEvents('hello').map(chunkFrame), open) },
];

const surfaced: Case[] = [
  {
    name: 'anthropic',
    make: () => new AnthropicAdapter({ apiKey: 'zz-key', cacheKeepalive: { enabled: false } } as never),
    request: wire,
    respond: () => {
      const events = [
        { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-zz', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ];
      const b = body(events.map(e => new TextEncoder().encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)));
      return { response: new Response(b.stream, { headers: { 'content-type': 'text/event-stream' } }), cancelled: b.cancelled };
    },
  },
  {
    name: 'gemini',
    make: () => new GeminiAdapter({ apiKey: 'zz-key' }),
    request: wire,
    respond: (open?: boolean) => sseResponse([
      { candidates: [{ content: { parts: [{ text: 'hello' }] } }] },
      { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } },
    ], open),
  },
  {
    name: 'openai-responses-api',
    make: () => new OpenAIResponsesAPIAdapter({ apiKey: 'zz-key' }),
    request: wire,
    respond: () => sseResponse([
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'in_progress', content: [] } },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'msg_1', delta: 'hello' },
      '[DONE]',
    ]),
  },
];

const settle = (promise: Promise<unknown>) => promise.then(() => undefined, (e: unknown) => e);

function expectFailed(error: unknown, thrown: Error): void {
  expect(error).toBeInstanceOf(MembraneError);
  expect(error).toMatchObject({ type: 'unknown', retryable: false, message: thrown.message });
}

describe("a stream callback's error fails the stream", () => {
  for (const { name, make, request, respond } of [...formerlySwallowing, ...surfaced]) {
    it(`${name}: onChunk's error reaches the caller, after one call`, async () => {
      vi.stubGlobal('fetch', vi.fn(async () => respond().response));
      const thrown = new Error('zz-callback-failure');
      let calls = 0;
      const error = await settle(make().stream(request, { onChunk: () => { calls++; throw thrown; } }));
      expectFailed(error, thrown);
      expect(calls).toBe(1);
    });
  }

  for (const { name, make, request, respond } of [...formerlySwallowing, ...surfaced.filter(c => c.name === 'gemini')]) {
    it(`${name}: the provider's body is cancelled, not left unread`, async () => {
      const { response, cancelled } = respond(true);
      vi.stubGlobal('fetch', vi.fn(async () => response));
      const thrown = new Error('zz-callback-failure');
      let calls = 0;
      const error = await settle(make().stream(request, { onChunk: () => { calls++; throw thrown; } }));
      expectFailed(error, thrown);
      expect(calls).toBe(1);
      expect(cancelled()).toBe(true);
    });
  }

  for (const { name, make, request, respond } of formerlySwallowing) {
    it(`${name}: a callback error with code EPIPE is typed network, and retryable`, async () => {
      vi.stubGlobal('fetch', vi.fn(async () => respond().response));
      const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
      const error = await settle(make().stream(request, { onChunk: () => { throw epipe; } }));
      expect(error).toMatchObject({ type: 'network', retryable: true });
    });
  }

  it('a plain Error is typed by its message: one that reads as a rate limit is rate_limit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([chat('hello'), chat(' world', 'stop'), '[DONE]']).response));
    const error = await settle(new OpenAIAdapter({ apiKey: 'zz-key' }).stream(wire, { onChunk: () => { throw new Error('zz 429 rate limit'); } }));
    expect(error).toMatchObject({ type: 'rate_limit', retryable: true });
  });

  it('openai-completions: a callback that fails on the end-of-turn frame fails the stream, and the body is cancelled', async () => {
    const { response, cancelled } = sseResponse([completion('hello<|eot|>zz-tail')], true);
    vi.stubGlobal('fetch', vi.fn(async () => response));
    const thrown = new Error('zz-callback-failure');
    let calls = 0;
    const error = await settle(new OpenAICompletionsAdapter({ apiKey: 'zz-key', baseURL: 'https://review.invalid/v1' }).stream(wire, { onChunk: () => { calls++; throw thrown; } }));
    expectFailed(error, thrown);
    expect(calls).toBe(1);
    expect(cancelled()).toBe(true);
  });

  const chatFamily: Array<{ name: string; make: () => ProviderAdapter }> = [
    { name: 'openai', make: () => new OpenAIAdapter({ apiKey: 'zz-key' }) },
    { name: 'openai-compatible', make: () => new OpenAICompatibleAdapter({ apiKey: 'zz-key', baseURL: 'https://review.invalid/v1' }) },
    { name: 'openai-completions', make: () => new OpenAICompletionsAdapter({ apiKey: 'zz-key', baseURL: 'https://review.invalid/v1' }) },
    { name: 'openrouter', make: () => new OpenRouterAdapter({ apiKey: 'zz-key' }) },
  ];
  for (const { name, make } of chatFamily) {
    it(`${name}: an error frame ends the read early, and the body is cancelled`, async () => {
      const { response, cancelled } = sseResponse([{ error: { message: 'zz upstream failure', code: 500 } }], true);
      vi.stubGlobal('fetch', vi.fn(async () => response));
      const error = await settle(make().stream(wire, { onChunk() {} }));
      expect(error).toBeInstanceOf(MembraneError);
      expect(cancelled()).toBe(true);
    });
  }

  it("openrouter: onContentBlock's error reaches the caller", async () => {
    const image = { choices: [{ delta: { images: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }] } }] };
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([image, chat('', 'stop'), '[DONE]']).response));
    const thrown = new Error('zz-block-failure');
    const error = await settle(new OpenRouterAdapter({ apiKey: 'zz-key' }).stream(wire, { onChunk() {}, onContentBlock: () => { throw thrown; } }));
    expectFailed(error, thrown);
  });

  it("bedrock: onContentBlock's error reaches the caller", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => bedrockResponse(bedrockEvents('hello').map(chunkFrame)).response));
    const thrown = new Error('zz-block-failure');
    const error = await settle(bedrock().stream(bedrockWire, { onChunk() {}, onContentBlock: () => { throw thrown; } }));
    expectFailed(error, thrown);
  });

  it("bedrock: onContentBlock's error at a block's stop reaches the caller", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => bedrockResponse(bedrockEvents('hello').map(chunkFrame)).response));
    const thrown = new Error('zz-block-failure');
    let calls = 0;
    const error = await settle(bedrock().stream(bedrockWire, { onChunk() {}, onContentBlock: () => { calls++; if (calls === 2) throw thrown; } }));
    expectFailed(error, thrown);
    expect(calls).toBe(2);
  });
});

describe('an end-of-turn stop', () => {
  it("openai-completions: returns without waiting on the body's cancel", async () => {
    let cancelled = false;
    const pieces = sseLines([completion('hello<|eot|>zz-tail')]);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = pieces.shift();
        if (next) controller.enqueue(next);
        else return new Promise(() => {});
      },
      cancel() { cancelled = true; return new Promise(() => {}); },
    }, { highWaterMark: 0 });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } })));
    const response = await new OpenAICompletionsAdapter({ apiKey: 'zz-key', baseURL: 'https://review.invalid/v1' }).stream(wire, { onChunk() {} }) as any;
    expect(response.stopReason).toBe('end_turn');
    expect(cancelled).toBe(true);
  });
});

describe('a frame the handler cannot read is still dropped', () => {
  const chatAdapters: Array<{ name: string; make: () => ProviderAdapter; frame: (text: string, finish?: string) => unknown; tools: boolean }> = [
    { name: 'openai', make: () => new OpenAIAdapter({ apiKey: 'zz-key' }), frame: chat, tools: true },
    { name: 'openai-compatible', make: () => new OpenAICompatibleAdapter({ apiKey: 'zz-key', baseURL: 'https://review.invalid/v1' }), frame: chat, tools: true },
    { name: 'openai-completions', make: () => new OpenAICompletionsAdapter({ apiKey: 'zz-key', baseURL: 'https://review.invalid/v1' }), frame: completion, tools: false },
    { name: 'openrouter', make: () => new OpenRouterAdapter({ apiKey: 'zz-key' }), frame: chat, tools: true },
  ];
  for (const { name, make, frame, tools } of chatAdapters) {
    const frames: Array<[string, unknown]> = [
      ['a data line that isn\'t JSON', 'not json {'],
      ['data: null', 'null'],
      ['a data line that is a number', '5'],
      ['a data line that is a string', '"zz"'],
      ['a data line that is an array', '[]'],
      ['a data line that is a boolean', 'true'],
    ];
    if (tools) {
      frames.push(['a tool_calls entry that is null', { choices: [{ delta: { tool_calls: [null] } }] }]);
      frames.push(['a tool_calls entry that is a number', { choices: [{ delta: { tool_calls: [5] } }] }]);
      frames.push(['a tool_calls entry that is an array', { choices: [{ delta: { tool_calls: [[{ index: 0 }]] } }] }]);
      frames.push(['a tool_calls entry whose index is a name', { choices: [{ delta: { tool_calls: [{ index: 'length', function: { name: 'zz_tool', arguments: '{}' } }] } }] }]);
      frames.push(['a tool_calls entry whose index is negative', { choices: [{ delta: { tool_calls: [{ index: -1, function: { name: 'zz_tool', arguments: '{}' } }] } }] }]);
      // Values that aren't an array index. Number() reads false, "", " ", [] and "00" as 0, true, "0x1"
      // and "01" as 1, and "1e1" as 10; 1.5, 2^32 - 1 and its string are numbers no array index takes.
      for (const [what, index] of [['false', false], ['""', ''], ['" "', ' '], ['[]', []], ['true', true], ['"0x1"', '0x1'], ['"1e1"', '1e1'], ['"00"', '00'], ['"01"', '01'], ['1.5', 1.5], ['2^32 - 1', 2 ** 32 - 1], ['"4294967295"', '4294967295']] as Array<[string, unknown]>) {
        frames.push([`a tool_calls entry whose index is ${what}`, { choices: [{ delta: { tool_calls: [{ index, function: { name: 'zz_tool', arguments: '{}' } }] } }] }]);
      }
      frames.push(['a tool_calls that isn\'t an array', { choices: [{ delta: { tool_calls: { index: 0 } } }] }]);
    }
    for (const [label, bad] of frames) {
      it(`${name}: ${label}`, async () => {
        vi.stubGlobal('fetch', vi.fn(async () => sseResponse([bad, frame('hello', 'stop'), '[DONE]']).response));
        const chunks: string[] = [];
        const response = await make().stream(wire, { onChunk: chunk => { chunks.push(chunk); } }) as any;
        expect(chunks.join('')).toBe('hello');
        expect(response.stopReason).toBe('end_turn');
        expect(response.content.filter((block: { type: string }) => block.type === 'tool_use')).toEqual([]);
      });
    }
  }

  for (const { name, make } of chatAdapters.filter(a => a.tools)) {
    const call = (index: unknown) => ({ index, id: 'call_zz', type: 'function', function: { name: 'zz_tool', arguments: '{}' } });
    const holes: Array<[string, unknown[]]> = [
      ['a dropped entry before a kept one', [null, call(1)]],
      ['a first call whose index is 1', [call(1)]],
      ['a first call whose index is "1"', [call('1')]],
    ];
    for (const [label, entries] of holes) {
      it(`${name}: ${label} still gives the one tool call`, async () => {
        const frame = { choices: [{ delta: { tool_calls: entries } }] };
        vi.stubGlobal('fetch', vi.fn(async () => sseResponse([frame, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }, '[DONE]']).response));
        const response = await make().stream(wire, { onChunk() {} }) as any;
        expect(response.content.filter((block: { type: string }) => block.type === 'tool_use')).toMatchObject([{ id: 'call_zz', name: 'zz_tool' }]);
      });
    }

    for (const [what, rest] of [['null', { index: null }], ['absent', {}]] as Array<[string, Record<string, unknown>]>) {
      it(`${name}: a continuation whose index is ${what} joins the call before it, here the one at index 0`, async () => {
        const start = { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_zz', type: 'function', function: { name: 'zz_tool', arguments: '{"a":' } }] } }] };
        const more = { choices: [{ delta: { tool_calls: [{ ...rest, function: { arguments: '1}' } }] } }] };
        vi.stubGlobal('fetch', vi.fn(async () => sseResponse([start, more, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }, '[DONE]']).response));
        const response = await make().stream(wire, { onChunk() {} }) as any;
        expect(response.content.filter((block: { type: string }) => block.type === 'tool_use')).toMatchObject([{ id: 'call_zz', name: 'zz_tool', input: { a: 1 } }]);
      });
    }

    it(`${name}: a call at the largest array index, "4294967294", is placed, after one at 0`, async () => {
      const at = (index: unknown, id: string) => ({ choices: [{ delta: { tool_calls: [{ index, id, type: 'function', function: { name: `zz_${id}`, arguments: '{}' } }] } }] });
      vi.stubGlobal('fetch', vi.fn(async () => sseResponse([at('4294967294', 'call_z'), at(0, 'call_a'), { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }, '[DONE]']).response));
      const response = await make().stream(wire, { onChunk() {} }) as any;
      expect(response.content.filter((block: { type: string }) => block.type === 'tool_use').map((block: { id: string }) => block.id)).toEqual(['call_a', 'call_z']);
    });

    it(`${name}: two calls that arrive out of index order come back in index order`, async () => {
      const at = (index: number, id: string) => ({ choices: [{ delta: { tool_calls: [{ index, id, type: 'function', function: { name: `zz_${id}`, arguments: '{}' } }] } }] });
      vi.stubGlobal('fetch', vi.fn(async () => sseResponse([at(1, 'call_b'), at(0, 'call_a'), { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }, '[DONE]']).response));
      const response = await make().stream(wire, { onChunk() {} }) as any;
      expect(response.content.filter((block: { type: string }) => block.type === 'tool_use').map((block: { id: string }) => block.id)).toEqual(['call_a', 'call_b']);
    });

    it(`${name}: a tool_calls entry whose index is a string of digits is placed`, async () => {
      const call = { choices: [{ delta: { tool_calls: [{ index: '0', id: 'call_zz', type: 'function', function: { name: 'zz_tool', arguments: '{}' } }] } }] };
      vi.stubGlobal('fetch', vi.fn(async () => sseResponse([call, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }, '[DONE]']).response));
      const response = await make().stream(wire, { onChunk() {} }) as any;
      expect(response.content.filter((block: { type: string }) => block.type === 'tool_use')).toMatchObject([{ id: 'call_zz', name: 'zz_tool' }]);
    });
  }

  const rawChunk = (payloadText: string): Uint8Array => {
    const headers = stringHeader(':event-type', 'chunk');
    const payload = new TextEncoder().encode(payloadText);
    const frame = new Uint8Array(12 + headers.length + payload.length + 4);
    new DataView(frame.buffer).setUint32(0, frame.length, false);
    new DataView(frame.buffer).setUint32(4, headers.length, false);
    frame.set(headers, 12);
    frame.set(payload, 12 + headers.length);
    return frame;
  };
  const bedrockCases: Array<[string, Uint8Array]> = [
    ['an event that doesn\'t decode', rawChunk('not json {')],
    ['an event whose bytes aren\'t base64', rawChunk(JSON.stringify({ bytes: '%%% not base64' }))],
    ['an event whose bytes decode to text that isn\'t JSON', rawChunk(JSON.stringify({ bytes: btoa('not json {') }))],
    ['an event with no bytes', rawChunk(JSON.stringify({ p: 'zz' }))],
    ['an event that decodes to null', chunkFrame(null)],
    ['an event that decodes to a number', chunkFrame(5)],
    ['an event that decodes to an array', chunkFrame([{ type: 'message_stop' }])],
  ];
  const blockStart = (index: unknown, content_block: unknown) => chunkFrame({ type: 'content_block_start', index, content_block });
  const bedrockBlocks: Array<[string, Uint8Array[]]> = [
    ['a block start whose index is "length"', [blockStart('length', { type: 'text', text: '' }), chunkFrame({ type: 'content_block_stop', index: 'length' })]],
    ['a block start whose block is a number', [blockStart(1, 5), chunkFrame({ type: 'content_block_stop', index: 1 })]],
    ['a block start whose block is an array', [blockStart(1, []), chunkFrame({ type: 'content_block_stop', index: 1 })]],
    ['a block start whose block is null', [blockStart(1, null), chunkFrame({ type: 'content_block_stop', index: 1 })]],
    ['a block start whose index is false', [blockStart(false, { type: 'text', text: '' })]],
    ['a block stop whose index is ""', [chunkFrame({ type: 'content_block_stop', index: '' })]],
  ];
  for (const [label, bad] of bedrockBlocks) {
    it(`bedrock: ${label} is skipped, with a warning`, async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const events = bedrockEvents('hello').map(chunkFrame);
      vi.stubGlobal('fetch', vi.fn(async () => bedrockResponse([...events.slice(0, MESSAGE_DELTA_INDEX), ...bad, ...events.slice(MESSAGE_DELTA_INDEX)]).response));
      const chunks: string[] = [];
      const blockIndexes: unknown[] = [];
      const response = await bedrock().stream(bedrockWire, {
        onChunk: chunk => { chunks.push(chunk); },
        onContentBlock: (index) => { blockIndexes.push(index); },
      }) as any;
      expect(chunks.join('')).toBe('hello more');
      expect(response.stopReason).toBe('end_turn');
      expect(warn).toHaveBeenCalledWith('[membrane:bedrock] Skipping malformed stream event:', expect.anything());
      expect(blockIndexes).toEqual([0, 0]);
    });
  }

  it('bedrock: a block start skipped before a later block fails the call, naming the block the message lost', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const events = bedrockEvents('hello').map(chunkFrame);
    const between = [
      blockStart(1, 5),
      chunkFrame({ type: 'content_block_stop', index: 1 }),
      blockStart(2, { type: 'tool_use', id: 'toolu_zz', name: 'zz_tool', input: {} }),
      chunkFrame({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"a":1}' } }),
      chunkFrame({ type: 'content_block_stop', index: 2 }),
    ];
    vi.stubGlobal('fetch', vi.fn(async () => bedrockResponse([...events.slice(0, MESSAGE_DELTA_INDEX), ...between, ...events.slice(MESSAGE_DELTA_INDEX)]).response));
    const error = await settle(bedrock().stream(bedrockWire, { onChunk() {} }));
    expect(error).toBeInstanceOf(MembraneError);
    expect(error).toMatchObject({ type: 'network', retryable: true });
    expect((error as Error).message).toContain('lost content block 1');
  });

  it('bedrock: a thinking block whose start names no slot, before a tool call, fails the call rather than dropping it', async () => {
    // Anthropic's thinking docs: "when you return tool results, you must pass
    // the thinking blocks from the assistant message back to the API, complete
    // and unmodified".
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 1 } } },
      { type: 'content_block_start', index: false, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'zz-thought' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'zz-sig' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_zz', name: 'zz_tool', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"a":1}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => bedrockResponse(events.map(chunkFrame)).response));
    const error = await settle(bedrock().stream(bedrockWire, { onChunk() {} }));
    expect(error).toMatchObject({ type: 'network', retryable: true });
    expect((error as Error).message).toContain('lost content block 0');
  });

  it('bedrock: deltas after a skipped block start join no block in the response', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const events = bedrockEvents('hello').map(chunkFrame);
    const stray = [
      blockStart(false, { type: 'text', text: '' }),
      chunkFrame({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: ' zz-stray' } }),
    ];
    vi.stubGlobal('fetch', vi.fn(async () => bedrockResponse([...events.slice(0, MESSAGE_DELTA_INDEX), ...stray, ...events.slice(MESSAGE_DELTA_INDEX)]).response));
    const response = await bedrock().stream(bedrockWire, { onChunk() {} }) as any;
    expect(response.content.map((block: { type: string; text?: string }) => block.text)).toEqual(['hello more']);
  });

  it('bedrock: a block stop with no index finalizes the open block', async () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: ' more' } },
      { type: 'content_block_stop' },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => bedrockResponse(events.map(chunkFrame)).response));
    const blockIndexes: unknown[] = [];
    await bedrock().stream(bedrockWire, { onChunk() {}, onContentBlock: (index) => { blockIndexes.push(index); } });
    expect(blockIndexes).toEqual([0, 0, 1, 1]);
  });

  it('gemini: data: null, a number and an array are dropped', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      null,
      5,
      [{ zz: 1 }],
      { candidates: [{ content: { parts: [{ text: 'hello' }] } }] },
      { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } },
    ]).response));
    const chunks: string[] = [];
    const response = await new GeminiAdapter({ apiKey: 'zz-key' }).stream(wire, { onChunk: chunk => { chunks.push(chunk); } }) as any;
    expect(chunks.join('')).toBe('hello');
    expect(response.stopReason).toBe('end_turn');
  });

  it('openai-responses-api: data: null, a number and an array are dropped', async () => {
    const message = { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'hello', annotations: [] }] };
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      null,
      5,
      [{ type: 'response.completed' }],
      { type: 'response.output_item.added', output_index: 0, item: { ...message, status: 'in_progress', content: [] } },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'msg_1', delta: 'hello' },
      { type: 'response.completed', response: { id: 'resp_1', model: 'zz-review-model', status: 'completed', output: [message], usage: { input_tokens: 1, output_tokens: 1 } } },
      '[DONE]',
    ]).response));
    const chunks: string[] = [];
    const response = await new OpenAIResponsesAPIAdapter({ apiKey: 'zz-key' }).stream(wire, { onChunk: chunk => { chunks.push(chunk); } }) as any;
    expect(chunks.join('')).toBe('hello');
    expect(response.stopReason).toBe('end_turn');
  });

  for (const [label, bad] of bedrockCases) {
    it(`bedrock: ${label} is skipped, with a warning`, async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const [start, ...rest] = bedrockEvents('hello').map(chunkFrame);
      vi.stubGlobal('fetch', vi.fn(async () => bedrockResponse([start!, bad, ...rest]).response));
      const chunks: string[] = [];
      const response = await bedrock().stream(bedrockWire, { onChunk: chunk => { chunks.push(chunk); } }) as any;
      expect(chunks.join('')).toBe('hello more');
      expect(response.stopReason).toBe('end_turn');
      expect(warn).toHaveBeenCalledWith('[membrane:bedrock] Skipping malformed stream event:', expect.anything());
    });
  }
});

describe('through Membrane', () => {
  const request: NormalizedRequest = {
    messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz-prompt' }] }],
    config: { model: 'zz-model-1', maxTokens: 64 },
  };
  const membrane = () => new Membrane(new OpenAIAdapter({ apiKey: 'zz-key' }), {
    formatter: new NativeFormatter(),
    retry: { maxRetries: 3, retryDelayMs: 1, maxRetryDelayMs: 2 },
  });

  it("a callback that fails after emission ends the call after one send, and its error isn't retryable", async () => {
    const fetch = vi.fn(async () => sseResponse([chat('hello'), chat(' world', 'stop'), '[DONE]']).response);
    vi.stubGlobal('fetch', fetch);
    const thrown = new Error('zz 429 rate limit');
    const error = await settle(membrane().stream(request, { onChunk: () => { throw thrown; } }));
    expect(error).toMatchObject({ type: 'rate_limit', retryable: false, cause: thrown });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("a callback error with code EPIPE after emission is typed network, and isn't retryable either", async () => {
    const fetch = vi.fn(async () => sseResponse([chat('hello'), chat(' world', 'stop'), '[DONE]']).response);
    vi.stubGlobal('fetch', fetch);
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    const error = await settle(membrane().stream(request, { onChunk: () => { throw epipe; } }));
    expect(error).toMatchObject({ type: 'network', retryable: false, cause: epipe });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('a callback that fails on text held for a stop sequence, delivered as the stream ends, fails the call', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([chat('hello Z', 'stop'), '[DONE]']).response));
    const seen: string[] = [];
    const error = await settle(membrane().stream({ ...request, stopSequences: ['ZZSTOP'] }, {
      onChunk: (chunk) => { seen.push(chunk); if (chunk === 'Z') throw new Error('zz-held-failure'); },
    }));
    expect(error).toMatchObject({ message: 'zz-held-failure' });
    expect(seen).toEqual(['hello ', 'Z']);
  });

  it("held text isn't handed on after the caller's onBlock fails on a block a chunk releases", async () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'abS' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => bedrockResponse(events.map(chunkFrame)).response));
    const onBedrock = new Membrane(bedrock(), {
      formatter: new NativeFormatter(),
      retry: { maxRetries: 3, retryDelayMs: 1, maxRetryDelayMs: 2 },
    });
    const seen: string[] = [];
    const error = await settle(onBedrock.stream(
      { ...request, config: { model: bedrockWire.model, maxTokens: 64 }, stopSequences: ['STOP'] },
      { onChunk: (chunk) => { seen.push(chunk); }, onBlock: () => { throw new Error('zz-block-failure'); } },
    ));
    expect(error).toMatchObject({ message: 'zz-block-failure' });
    expect(seen).toEqual([]);
  });

  it('text held for a stop sequence isn\'t handed to a callback that has failed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([chat('hello Z'), chat('Zq', 'stop'), '[DONE]']).response));
    const seen: string[] = [];
    const error = await settle(membrane().stream({ ...request, stopSequences: ['ZZSTOP'] }, {
      onChunk: (chunk) => { seen.push(chunk); throw new Error('zz-callback-failure'); },
    }));
    expect(error).toMatchObject({ message: 'zz-callback-failure' });
    expect(seen).toEqual(['hello ']);
  });
});
