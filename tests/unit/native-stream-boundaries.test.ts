/**
 * The stop boundary of a native-mode stream that this PR's native
 * construction left open (greptile on #102: discussion_r4207037937).
 *
 * A provider that does not apply a request's stop sequences (the Responses
 * API has no stop parameter; Chat Completions drops it for some models and
 * sends at most four) still ends the accepted output at the stop, including
 * in text it reports only in its returned output: no chunk, block event,
 * returned block or replayed item carries the stop or anything after it, and
 * thinking is never scanned.
 *
 * The Anthropic fixtures stream past the stop on purpose: they stand for any
 * provider that does not apply it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { OpenAIResponsesAPIAdapter, type OpenAIResponsesOutputItem } from '../../src/providers/openai-responses-api.js';
import { OpenAIResponsesFormatter } from '../../src/formatters/openai-responses.js';
import { LocalStopSequences, cutVisible } from '../../src/utils/local-stop-sequences.js';

const text = (value: string) => ({ type: 'text' as const, text: value });
const MODEL = 'claude-haiku-4-5';
afterEach(() => vi.unstubAllGlobals());

// ---------------------------------------------------------------------------
// Anthropic SSE fixtures
// ---------------------------------------------------------------------------

type Event = Record<string, any>;
const messageStart: Event = {
  type: 'message_start',
  message: { id: 'm', type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } },
};
const textBlock = (index: number, ...deltas: string[]): Event[] => [
  { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
  ...deltas.map(delta => ({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: delta } })),
  { type: 'content_block_stop', index },
];
const thinkingBlock = (index: number, thinking: string): Event[] => [
  { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } },
  { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking } },
  { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'signature' } },
  { type: 'content_block_stop', index },
];
const toolBlock = (index: number, id: string, name: string, json: string, finished = true): Event[] => [
  { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } },
  { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json } },
  ...(finished ? [{ type: 'content_block_stop', index }] : []),
];
const messageEnd = (stopReason = 'end_turn'): Event[] => [
  { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 2 } },
  { type: 'message_stop' },
];

/** One Anthropic SSE response; `abort` ends the transport with an AbortError after the events. */
function anthropicResponse(events: Event[], abort = false): Response {
  const frames = events.map(event => new TextEncoder().encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const frame = frames.shift();
      if (frame) controller.enqueue(frame);
      else if (abort) controller.error(new DOMException('aborted by fixture', 'AbortError'));
      else controller.close();
    },
  }, { highWaterMark: 0 });
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
}

/** Answer each request with the next scripted response; the last one repeats. Returns the request bodies. */
function script(...responses: Array<() => Response>): any[] {
  const bodies: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return responses[Math.min(bodies.length, responses.length) - 1]!();
  }));
  return bodies;
}

const claude = (config: Record<string, unknown> = {}) =>
  new Membrane(new AnthropicAdapter({ apiKey: 'test', cacheKeepalive: { enabled: false } }), config);

interface Sink { chunks: { chunk: string; meta: any }[]; blocks: any[]; toolCalls: unknown[] }
const sink = (): Sink => ({ chunks: [], blocks: [], toolCalls: [] });
const visibleText = (s: Sink) => s.chunks.filter(item => item.meta?.visible).map(item => item.chunk).join('');

async function run(path: string, membrane: Membrane, request: any, s: Sink): Promise<any> {
  if (path === 'stream') {
    return membrane.stream(request, {
      onChunk: (chunk, meta) => s.chunks.push({ chunk, meta }),
      onBlock: event => s.blocks.push(event),
      onToolCalls: async calls => {
        s.toolCalls.push(...calls);
        return calls.map(call => ({ toolUseId: call.id, content: 'result' }));
      },
    });
  }
  let result: any;
  const stream = membrane.streamYielding(request);
  for await (const event of stream) {
    if (event.type === 'tokens') s.chunks.push({ chunk: event.content, meta: event.meta });
    if (event.type === 'block') s.blocks.push(event.event);
    if (event.type === 'tool-calls') {
      s.toolCalls.push(...event.calls);
      stream.provideToolResults(event.calls.map(call => ({ toolUseId: call.id, content: 'result' })));
    }
    if (event.type === 'complete' || event.type === 'aborted') result = event.type === 'complete' ? event.response : event;
    if (event.type === 'error') throw event.error;
  }
  return result;
}

const ask = (extra: Record<string, unknown> = {}) => ({
  config: { model: MODEL, maxTokens: 256 },
  messages: [{ participant: 'User', content: [text('Question')] }],
  ...extra,
});
const lookup = { name: 'lookup', description: 'look up a record', inputSchema: { type: 'object' as const, properties: {} } };

// ---------------------------------------------------------------------------
// Stops
// ---------------------------------------------------------------------------

describe('a request stop on a native stream the provider did not stop', () => {
  it.each(['stream', 'yielding'])('ends the accepted output at a stop split across chunks, emitting no part of it (%s)', async path => {
    script(() => anthropicResponse([messageStart, ...textBlock(0, 'before E', 'N', 'D after'), ...messageEnd()]));
    const s = sink();
    const response = await run(path, claude(), ask({ stopSequences: ['END'] }), s);
    expect(visibleText(s)).toBe('before ');
    expect(response.content).toEqual([text('before ')]);
    expect(response.rawAssistantText).toBe('before ');
    expect(response.stopReason).toBe('stop_sequence');
    expect(response.details.stop).toMatchObject({ reason: 'stop_sequence', triggeredSequence: 'END' });
    expect(s.blocks.filter(event => event.event === 'block_complete').map(event => [event.block.type, event.block.content]))
      .toEqual([['text', 'before ']]);
  });

  it.each(['stream', 'yielding'])('catches a stop the provider split across adjacent text blocks (%s)', async path => {
    script(() => anthropicResponse([messageStart, ...textBlock(0, 'before E'), ...textBlock(1, 'ND after'), ...messageEnd()]));
    const s = sink();
    const response = await run(path, claude(), ask({ stopSequences: ['END'] }), s);
    expect(visibleText(s)).toBe('before ');
    expect(response.content).toEqual([text('before ')]);
    expect(s.blocks.map(event => [event.event, event.index, event.block.content])).toEqual([
      ['block_start', 0, undefined], ['block_complete', 0, 'before '],
    ]);
  });

  it.each(['stream', 'yielding'])('leaves the previous block whole when a stop begins a new text block (%s)', async path => {
    script(() => anthropicResponse([messageStart, ...textBlock(0, 'first '), ...textBlock(1, 'END rest'), ...messageEnd()]));
    const s = sink();
    const response = await run(path, claude(), ask({ stopSequences: ['END'] }), s);
    expect(response.content).toEqual([text('first ')]);
    expect(s.blocks.map(event => [event.event, event.index, event.block.content])).toEqual([
      ['block_start', 0, undefined], ['block_complete', 0, 'first '],
    ]);
  });

  it.each(['stream', 'yielding'])('releases held text and the boundaries behind it in their original order (%s)', async path => {
    script(() => anthropicResponse([messageStart, ...textBlock(0, 'a E'), ...textBlock(1, 'X b'), ...messageEnd()]));
    const s = sink();
    const response = await run(path, claude(), ask({ stopSequences: ['END'] }), s);
    expect(response.content).toEqual([text('a E'), text('X b')]);
    expect(response.stopReason).toBe('end_turn');
    expect(s.chunks.map(item => [item.chunk, item.meta.blockIndex])).toEqual([['a ', 0], ['E', 0], ['X b', 1]]);
    expect(s.blocks.map(event => [event.event, event.index, event.block.content])).toEqual([
      ['block_start', 0, undefined], ['block_complete', 0, 'a E'], ['block_start', 1, undefined], ['block_complete', 1, 'X b'],
    ]);
  });

  it.each(['stream', 'yielding'])('never scans thinking (%s)', async path => {
    script(() => anthropicResponse([messageStart, ...thinkingBlock(0, 'mull END over'), ...textBlock(1, 'visible'), ...messageEnd()]));
    const s = sink();
    const response = await run(path, claude(), ask({
      stopSequences: ['END'], config: { model: MODEL, maxTokens: 2048, thinking: { enabled: true, budgetTokens: 1024 } },
    }), s);
    expect(response.content).toEqual([{ type: 'thinking', thinking: 'mull END over', signature: 'signature' }, text('visible')]);
    expect(response.stopReason).toBe('end_turn');
  });

  it.each(['stream', 'yielding'])('releases a held stop prefix that never completes (%s)', async path => {
    script(() => anthropicResponse([messageStart, ...textBlock(0, 'ends with E', 'N'), ...messageEnd()]));
    const s = sink();
    const response = await run(path, claude(), ask({ stopSequences: ['END'] }), s);
    expect(visibleText(s)).toBe('ends with EN');
    expect(response.content).toEqual([text('ends with EN')]);
    expect(response.stopReason).toBe('end_turn');
  });

  it.each(['stream', 'yielding'])('neither executes nor returns a tool call after the stop (%s)', async path => {
    const bodies = script(
      () => anthropicResponse([messageStart, ...textBlock(0, 'say END now'), ...toolBlock(1, 'toolu_1', 'lookup', '{"q":1}'), ...messageEnd('tool_use')]),
      () => anthropicResponse([messageStart, ...textBlock(0, 'next round'), ...messageEnd()]),
    );
    const s = sink();
    const response = await run(path, claude(), ask({ stopSequences: ['END'], tools: [lookup] }), s);
    expect(s.toolCalls).toEqual([]);
    expect(bodies).toHaveLength(1);
    expect(response.content).toEqual([text('say ')]);
    expect(response.stopReason).toBe('stop_sequence');
    expect(s.blocks.some(event => event.block.type === 'tool_call')).toBe(false);
  });

  it.each(['stream', 'yielding'])('leaves explicit XML streams to their own parser-aware stop handling (%s)', async path => {
    // The XML loops read raw chunks: a stop spelled inside a payload is
    // theirs to judge. Were the native hold-back active here, `a E` would be
    // split to hold the `E`.
    script(() => anthropicResponse([messageStart, ...textBlock(0, 'a E', 'X b'), ...messageEnd()]));
    const s = sink();
    const response = await run(path, claude(), ask({ stopSequences: ['END'], toolMode: 'xml' }), s);
    expect(s.chunks.map(item => item.chunk)).toContain('a E');
    expect(response.stopReason).toBe('end_turn');
  });

  it.each(['stream', 'yielding'])('enforces a stop that a beforeRequest hook added (%s)', async path => {
    script(() => anthropicResponse([messageStart, ...textBlock(0, 'go HALT on'), ...messageEnd()]));
    const s = sink();
    const membrane = claude({
      hooks: { beforeRequest: (_request: unknown, raw: any) => ({ ...raw, stopSequences: [...(raw.stopSequences ?? []), 'HALT'] }) },
    });
    const response = await run(path, membrane, ask(), s);
    expect(visibleText(s)).toBe('go ');
    expect(response.content).toEqual([text('go ')]);
    expect(response.details.stop.triggeredSequence).toBe('HALT');
  });
});

// ---------------------------------------------------------------------------
// Stops through the Responses API, which has no stop parameter and reports
// its blocks only after the stream, carrying raw items the formatter replays.
// ---------------------------------------------------------------------------

/**
 * A Responses stream: reasoning, then a message streamed as `deltas`, then any
 * `after` items. `finalText` puts message text in the returned output that
 * never streamed as deltas, as a provider may.
 */
function responsesResponse(deltas: string[], options: { finalText?: string; after?: OpenAIResponsesOutputItem[] } = {}): Response {
  const after = options.after ?? [];
  const output: OpenAIResponsesOutputItem[] = [
    { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'sealed', status: 'completed' },
    {
      type: 'message', id: 'msg_1', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: options.finalText ?? deltas.join(''), annotations: [] }],
    },
    ...after,
  ];
  const events = [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1', summary: [], status: 'in_progress' } },
    { type: 'response.output_item.done', output_index: 0, item: output[0] },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'in_progress', content: [] } },
    ...deltas.map(delta => ({ type: 'response.output_text.delta', output_index: 1, content_index: 0, item_id: 'msg_1', delta })),
    { type: 'response.output_item.done', output_index: 1, item: output[1] },
    ...after.map((item, i) => ({ type: 'response.output_item.done', output_index: 2 + i, item })),
    { type: 'response.completed', response: { id: 'resp_1', model: 'gpt-5.6', status: 'completed', output, usage: { input_tokens: 3, output_tokens: 4 } } },
  ];
  const sse = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(new TextEncoder().encode(sse), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('a request stop through the Responses API', () => {
  it.each(['stream', 'yielding'])('cuts the late block events, the content and the replayed items at the stop (%s)', async path => {
    script(() => responsesResponse(['before E', 'ND after']));
    const formatter = new OpenAIResponsesFormatter();
    const membrane = new Membrane(new OpenAIResponsesAPIAdapter({ apiKey: 'sk-test' }), { formatter, assistantParticipant: 'Sol' });
    const s = sink();
    const request = {
      config: { model: 'gpt-5.6', maxTokens: 256 },
      messages: [{ participant: 'User', content: [text('Question')] }],
      stopSequences: ['END'],
    };
    const response = await run(path, membrane, request, s);
    expect(visibleText(s)).toBe('before ');
    expect(response.stopReason).toBe('stop_sequence');
    expect(response.content.map((block: any) => block.type)).toEqual(['redacted_thinking', 'text']);
    expect(response.content[0]).toMatchObject({ data: 'sealed', rawItem: { id: 'rs_1' } });
    expect(response.content[1]).toMatchObject(text('before '));
    expect(response.content[1].rawItem).toBeUndefined();
    // Block events follow the same projection: the reasoning before the stop
    // arrives, the message arrives cut, and nothing after it arrives at all.
    expect(s.blocks.filter(event => event.event === 'block_complete').map(event => [event.block.type, event.block.content]))
      .toEqual([['thinking', undefined], ['text', 'before ']]);
    // The next request replays the reasoning item and the accepted text only.
    const next = formatter.buildMessages([
      ...request.messages,
      { participant: 'Sol', content: response.content },
      { participant: 'User', content: [text('Go on')] },
    ], { assistantParticipant: 'Sol' } as any);
    const wire = JSON.stringify(next.messages);
    expect(wire).toContain('sealed');
    expect(wire).toContain('before ');
    expect(wire).not.toContain('END');
    expect(wire).not.toContain('after');
  });

  it.each(['stream', 'yielding'])('holds text the provider reported only in its returned output to the stop (%s)', async path => {
    script(() => responsesResponse([], { finalText: 'before END after' }));
    const formatter = new OpenAIResponsesFormatter();
    const membrane = new Membrane(new OpenAIResponsesAPIAdapter({ apiKey: 'sk-test' }), { formatter, assistantParticipant: 'Sol' });
    const s = sink();
    const request = {
      config: { model: 'gpt-5.6', maxTokens: 256 },
      messages: [{ participant: 'User', content: [text('Question')] }],
      stopSequences: ['END'],
    };
    const response = await run(path, membrane, request, s);
    expect(s.chunks.some(item => item.chunk.includes('END'))).toBe(false);
    expect(response.stopReason).toBe('stop_sequence');
    expect(response.content.map((block: any) => block.type)).toEqual(['redacted_thinking', 'text']);
    expect(response.content[1]).toMatchObject(text('before '));
    expect(response.content[1].rawItem).toBeUndefined();
    expect(s.blocks.filter(event => event.event === 'block_complete').map(event => [event.block.type, event.block.content]))
      .toEqual([['thinking', undefined], ['text', 'before ']]);
    const next = formatter.buildMessages([
      ...request.messages,
      { participant: 'Sol', content: response.content },
      { participant: 'User', content: [text('Go on')] },
    ], { assistantParticipant: 'Sol' } as any);
    const wire = JSON.stringify(next.messages);
    expect(wire).not.toContain('END');
    expect(wire).not.toContain('after');
  });
});

// ---------------------------------------------------------------------------
// The stop wrapper's own boundaries: callbacks that throw, the returned
// content's stretches, and replay identity.
// ---------------------------------------------------------------------------

describe('LocalStopSequences', () => {
  const response = (content: unknown) => ({
    content, stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, model: 'm', rawRequest: {}, raw: {},
  });

  it('never hands a callback that threw the same text again', () => {
    const chunks: string[] = [];
    let calls = 0;
    const stops = new LocalStopSequences(['END'], {
      onChunk: chunk => {
        chunks.push(chunk);
        if (calls++ === 0) throw new DOMException('consumer abort', 'AbortError');
      },
    });
    expect(() => stops.callbacks.onChunk('hello')).toThrow('consumer abort');
    stops.release();
    expect(chunks).toEqual(['hello']);
  });

  it('never releases the stop after a callback threw at it', () => {
    const chunks: string[] = [];
    const stops = new LocalStopSequences(['END'], {
      onChunk: chunk => {
        chunks.push(chunk);
        throw new DOMException('consumer abort', 'AbortError');
      },
    });
    expect(() => stops.callbacks.onChunk('before END after')).toThrow('consumer abort');
    stops.release();
    expect(chunks).toEqual(['before ']);
  });

  it('delivers block events still waiting when the adapter throws', () => {
    const events: unknown[] = [];
    const stops = new LocalStopSequences(['END'], {
      onChunk: chunk => events.push(chunk),
      onContentBlock: (index, block) => events.push([index, (block as any).type]),
    });
    stops.callbacks.onContentBlock!(0, { type: 'text', text: '' });
    stops.callbacks.onChunk('pre ');
    stops.callbacks.onContentBlock!(0, { type: 'text', text: 'pre ' });
    stops.callbacks.onContentBlock!(1, { type: 'tool_use', id: 't', name: 'x', input: {} });
    stops.callbacks.onContentBlock!(1, { type: 'tool_use', id: 't', name: 'x', input: { a: 1 } });
    stops.release();
    expect(events).toEqual([[0, 'text'], 'pre ', [0, 'text'], [1, 'tool_use'], [1, 'tool_use']]);
  });

  it('does not let a stop span a non-text block in the returned content (control)', () => {
    const stops = new LocalStopSequences(['END'], { onChunk: () => {} });
    const content = [text('a E'), { type: 'tool_use', id: 't', name: 'x', input: {} }, text('ND b')];
    const result = stops.finish(response(content) as any);
    expect(result.stopReason).toBe('end_turn');
    expect(result.content).toBe(content);
  });

  it('replays nothing of a cut message whose parts carry equal raw items without ids', () => {
    const item = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'pre END after' }] };
    const content = [
      { ...text('pre '), rawItem: structuredClone(item) },
      { ...text('END after'), rawItem: structuredClone(item) },
    ];
    const cut = cutVisible(content, 4);
    expect(cut.content).toEqual([text('pre ')]);
    const next = new OpenAIResponsesFormatter().buildMessages([
      { participant: 'User', content: [text('Question')] },
      { participant: 'Sol', content: cut.content as any },
      { participant: 'User', content: [text('Go on')] },
    ], { assistantParticipant: 'Sol' } as any);
    const wire = JSON.stringify(next.messages);
    expect(wire).toContain('pre ');
    expect(wire).not.toContain('END');
  });
});
