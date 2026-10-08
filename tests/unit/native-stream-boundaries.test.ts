/**
 * Three boundaries of a native-mode stream that this PR's native construction
 * left open (greptile on #102: discussion_r4207037937, r4207037948,
 * r4207037963).
 *
 * - Stops. A provider that does not apply a request's stop sequences (the
 *   Responses API has no stop parameter; Chat Completions drops it for some
 *   models and sends at most four) still ends the accepted output at the
 *   stop, including in text it reports only in its returned output: no
 *   chunk, block event, returned block or replayed item carries the stop or
 *   anything after it (chunks already sent ahead of unstreamed text that
 *   holds a stop aside; see LocalStopSequences), and thinking is never
 *   scanned. The returned content decides where the attempt stops when an
 *   adapter's chunks don't match it (slimepriestess's review of #58): text a
 *   stop withheld while streaming is delivered at the end when that content
 *   holds no stop.
 * - prefillUserMessage. The caller's synthetic user text is the leading user
 *   turn wherever a native conversation needs one.
 * - Aborts. A block the provider finished delivering before an abort is kept
 *   in partialContent, and once the provider has returned, every block it
 *   returned is; a tool call whose arguments never finished is not.
 *
 * The Anthropic fixtures stream past the stop on purpose: they stand for any
 * provider that does not apply it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { OpenAICompatibleAdapter } from '../../src/providers/openai-compatible.js';
import { OpenAIResponsesAPIAdapter, type OpenAIResponsesOutputItem } from '../../src/providers/openai-responses-api.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { OpenAIResponsesFormatter } from '../../src/formatters/openai-responses.js';
import { normalizeToolPairs } from '../../src/formatters/normalize-tool-pairs.js';
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
// Stops where the returned text is not the streamed text: OpenAICompatibleAdapter
// drops reasoning a backend leaked into the content channel (`…</think>`)
// from what it returns, while its chunks carried it. The returned content
// decides where the attempt stops (slimepriestess's review of #58).
// ---------------------------------------------------------------------------

/** An OpenAI-compatible chat stream of `deltas`, ending with finish_reason stop. */
function compatibleResponse(deltas: string[]): Response {
  const frames = [
    ...deltas.map(content => ({ choices: [{ index: 0, delta: { content } }] })),
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ].map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(new TextEncoder().encode(frames), { headers: { 'Content-Type': 'text/event-stream' } });
}

const compatible = () =>
  new Membrane(new OpenAICompatibleAdapter({ baseURL: 'http://localhost:9/v1', apiKey: 'k' }), { formatter: new NativeFormatter() });

describe('a request stop where the returned text is not the streamed text', () => {
  const rows: Array<{ name: string; deltas: string[]; stops?: string[]; chunks: string; content: string; reason: string; stop?: string }> = [
    {
      name: 'a stop in the answer, no leak (control)',
      deltas: ['Answer ', 'END after'], chunks: 'Answer ', content: 'Answer ', reason: 'stop_sequence', stop: 'END',
    },
    {
      name: 'a stop in the answer after a leaked prefix: cut in the returned text',
      deltas: ['leaked thought</think>', '\n\nAnswer ', 'END after'],
      chunks: 'leaked thought</think>\n\nAnswer ', content: 'Answer ', reason: 'stop_sequence', stop: 'END',
    },
    {
      name: 'a stop only in the leaked prefix: nothing stopped, and what was withheld is delivered',
      deltas: ['leak END x</think>', 'Answer'],
      chunks: 'leak END x</think>Answer', content: 'Answer', reason: 'end_turn',
    },
    {
      name: 'a stop in the leaked prefix and another in the answer: the answer\'s',
      deltas: ['leak END x</think>', 'Answer END more'],
      chunks: 'leak ', content: 'Answer ', reason: 'stop_sequence', stop: 'END',
    },
    {
      name: 'a different stop in the leaked prefix: the answer\'s stop is the one reported',
      deltas: ['a XYZ b</think>', 'Answer END more'], stops: ['END', 'XYZ'],
      chunks: 'a ', content: 'Answer ', reason: 'stop_sequence', stop: 'END',
    },
  ];

  for (const row of rows) {
    it.each(['stream', 'yielding'])(`${row.name} (%s)`, async path => {
      script(() => compatibleResponse(row.deltas));
      const s = sink();
      const response = await run(path, compatible(), {
        config: { model: 'm', maxTokens: 64 },
        messages: [{ participant: 'User', content: [text('Question')] }],
        stopSequences: row.stops ?? ['END'],
      }, s);
      expect(visibleText(s)).toBe(row.chunks);
      expect(response.rawAssistantText).toBe(row.chunks);
      expect(response.content).toEqual([text(row.content)]);
      expect(response.stopReason).toBe(row.reason);
      if (row.stop) expect(response.details.stop).toMatchObject({ reason: 'stop_sequence', triggeredSequence: row.stop });
    });
  }
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

  // The adapter reports no item boundaries while streaming, so the streamed
  // `before E` + `ND after` looks like one stretch; the returned content's
  // function call ends the stretch, so it holds no stop.
  const message = (id: string, value: string): OpenAIResponsesOutputItem => ({
    type: 'message', id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: value, annotations: [] }],
  });
  const call = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '{}', status: 'completed' } as any;
  const spanned = (streamed: boolean, abort = false) => responsesItems([
    { item: message('msg_1', 'before E'), deltas: streamed ? ['before E'] : [] },
    { item: call },
    { item: message('msg_2', 'ND after'), deltas: streamed ? ['ND after'] : [] },
  ], abort);
  const callRequest = {
    config: { model: 'gpt-5.6', maxTokens: 256 },
    messages: [{ participant: 'User', content: [text('Question')] }],
    tools: [lookup],
    stopSequences: ['END'],
  };
  const responses = () => new Membrane(new OpenAIResponsesAPIAdapter({ apiKey: 'sk-test' }), { formatter: new OpenAIResponsesFormatter() });
  const firstRoundBlocks = (s: Sink) => s.blocks
    .filter(event => event.event === 'block_complete' && event.index <= 2)
    .slice(0, 3)
    .map(event => [event.block.type, event.block.content ?? event.block.toolName]);

  it.each(['stream', 'yielding'])('runs a function call between two messages whose text only looks like a stop when streamed (%s)', async path => {
    const bodies = script(() => spanned(true), () => responsesResponse(['done']));
    const s = sink();
    const response = await run(path, responses(), callRequest, s);
    expect(bodies).toHaveLength(2);
    expect(s.toolCalls).toMatchObject([{ id: 'call_1', name: 'lookup' }]);
    // What the stream withheld after the stop it found arrives when the
    // round's content shows there was none.
    expect(s.chunks.map(item => item.chunk).join('')).toBe('before END afterdone');
    expect(firstRoundBlocks(s)).toEqual([['text', 'before E'], ['tool_call', 'lookup'], ['text', 'ND after']]);
    expect(response.stopReason).toBe('end_turn');
  });

  it.each(['stream', 'yielding'])('runs the same function call when that text never streamed (control) (%s)', async path => {
    const bodies = script(() => spanned(false), () => responsesResponse(['done']));
    const s = sink();
    const response = await run(path, responses(), callRequest, s);
    expect(bodies).toHaveLength(2);
    expect(s.toolCalls).toMatchObject([{ id: 'call_1', name: 'lookup' }]);
    expect(firstRoundBlocks(s)).toEqual([['text', 'before E'], ['tool_call', 'lookup'], ['text', 'ND after']]);
    expect(response.stopReason).toBe('end_turn');
  });

  it.each(['stream', 'yielding'])('keeps only what preceded such a stop when the transport aborts before the content can settle it (%s)', async path => {
    // With no returned content, a stop found while streaming stands, so a
    // stop that the content would not have held still truncates partialContent.
    script(() => spanned(true, true));
    const s = sink();
    const response = await run(path, responses(), callRequest, s);
    expect(response.partialContent).toEqual([text('before ')]);
    expect(visibleText(s)).toBe('before ');
    expect(s.toolCalls).toEqual([]);
  });

  it.each(['stream', 'yielding'])('cuts at the stop in the returned text when a refusal it never streamed comes first (%s)', async path => {
    // The adapter returns a refusal part as text but streams only output_text,
    // so the returned text is not the streamed text: the second live case of
    // the streamed-offset cut (Barnaby-1871's probe gave `no` + `ab`).
    const item = {
      type: 'message', id: 'msg_1', role: 'assistant', status: 'completed',
      content: [{ type: 'refusal', refusal: 'no' }, { type: 'output_text', text: 'abc END after', annotations: [] }],
    } as any;
    script(() => responsesItems([{ item, deltas: ['abc END after'], contentIndex: 1 }]));
    const s = sink();
    const response = await run(path, responses(), {
      config: { model: 'gpt-5.6', maxTokens: 256 },
      messages: [{ participant: 'User', content: [text('Question')] }],
      stopSequences: ['END'],
    }, s);
    expect(visibleText(s)).toBe('abc ');
    expect(response.content.map((block: any) => block.text)).toEqual(['no', 'abc ']);
    expect(response.stopReason).toBe('stop_sequence');
    expect(response.details.stop).toMatchObject({ reason: 'stop_sequence', triggeredSequence: 'END' });
  });
});

/**
 * A Responses stream of `items` in order, each message streaming its
 * `deltas` into part `contentIndex` (none: its text is only in the returned
 * output). `abort` errors the transport where response.completed would have
 * been.
 */
function responsesItems(items: Array<{ item: OpenAIResponsesOutputItem; deltas?: string[]; contentIndex?: number }>, abort = false): Response {
  const output = items.map(entry => entry.item);
  const events: Event[] = items.flatMap(({ item, deltas = [], contentIndex = 0 }, index) => [
    { type: 'response.output_item.added', output_index: index, item: item.type === 'message' ? { ...item, status: 'in_progress', content: [] } : item },
    ...deltas.map(delta => ({ type: 'response.output_text.delta', output_index: index, content_index: contentIndex, item_id: (item as any).id, delta })),
    { type: 'response.output_item.done', output_index: index, item },
  ]);
  if (!abort) {
    events.push({ type: 'response.completed', response: { id: 'resp_1', model: 'gpt-5.6', status: 'completed', output, usage: { input_tokens: 3, output_tokens: 4 } } });
  }
  const frames = events.map(event => new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
  if (!abort) frames.push(new TextEncoder().encode('data: [DONE]\n\n'));
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const frame = frames.shift();
      if (frame) controller.enqueue(frame);
      else if (abort) controller.error(new DOMException('aborted by fixture', 'AbortError'));
      else controller.close();
    },
  }, { highWaterMark: 0 });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

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

  /** A wrapper over a recording sink: chunks as strings, events as [index, type], signatures as ['sig', index]. */
  const recording = (stops: string[]) => {
    const events: unknown[] = [];
    const wrapper = new LocalStopSequences(stops, {
      onChunk: chunk => events.push(chunk),
      onContentBlock: (index, block) => events.push([index, (block as any).type]),
      onThinkingSignature: index => events.push(['sig', index]),
    });
    return { events, callbacks: wrapper.callbacks, wrapper };
  };
  const tool = { type: 'tool_use', id: 't', name: 'x', input: {} };

  it('delivers nothing it withheld after a stop when the adapter throws, whatever the content would have shown', () => {
    const { events, callbacks, wrapper } = recording(['END']);
    callbacks.onChunk('before E');
    callbacks.onChunk('ND after');
    wrapper.release();
    expect(events).toEqual(['before ']);
  });

  it('delivers what it withheld after a stop the returned content does not hold, in the order it arrived', () => {
    const { events, callbacks, wrapper } = recording(['END']);
    callbacks.onChunk('before E');
    callbacks.onChunk('ND');
    // After the stop: a thinking block streams, then a text block opens.
    callbacks.onContentBlock!(3, { type: 'thinking', thinking: '' });
    callbacks.onChunk('mull');
    callbacks.onThinkingSignature!(3, 'sig');
    callbacks.onContentBlock!(3, { type: 'thinking', thinking: 'mull' });
    callbacks.onContentBlock!(4, { type: 'text', text: '' });
    callbacks.onChunk(' tail');
    const content = [text('before E'), tool, text('ND'), { type: 'thinking', thinking: 'mull' }, text(' tail')];
    const result = wrapper.finish(response(content) as any);
    expect(result).toMatchObject({ content, stopReason: 'end_turn' });
    expect(events).toEqual(['before ', 'END', [3, 'thinking'], 'mull', ['sig', 3], [3, 'thinking'], [4, 'text'], ' tail']);
  });

  it('delivers withheld text up to a later stop the returned content holds, where positions correspond', () => {
    const { events, callbacks, wrapper } = recording(['END']);
    callbacks.onChunk('before E');
    callbacks.onChunk('ND after END tail');
    const result = wrapper.finish(response([text('before E'), tool, text('ND after END tail')]) as any);
    expect(result).toMatchObject({ content: [text('before E'), tool, text('ND after ')], stopReason: 'stop_sequence', stopSequence: 'END' });
    expect(events).toEqual(['before ', 'END after ']);
  });

  it('delivers nothing more where streamed and returned positions do not correspond', () => {
    // Streamed `leak END x</think>Answer END more`, returned `Answer END more`:
    // offset arithmetic across the two would hand out `EN` of the withheld stop.
    const stopped = recording(['END']);
    stopped.callbacks.onChunk('leak END x</think>');
    stopped.callbacks.onChunk('Answer END more');
    const cut = stopped.wrapper.finish(response([text('Answer END more')]) as any);
    expect(cut).toMatchObject({ content: [text('Answer ')], stopReason: 'stop_sequence', stopSequence: 'END' });
    expect(stopped.events).toEqual(['leak ']);
    // The same when streaming found no stop and only held a possible one.
    const held = recording(['END']);
    held.callbacks.onChunk('leak E');
    const kept = held.wrapper.finish(response([text('Answer END more')]) as any);
    expect(kept).toMatchObject({ content: [text('Answer ')], stopReason: 'stop_sequence' });
    expect(held.events).toEqual(['leak ']);
  });

  it('keeps a held stop prefix whose stop completes only in text the provider returned without streaming', () => {
    const { events, callbacks, wrapper } = recording(['END']);
    callbacks.onChunk('before E');
    const result = wrapper.finish(response([text('before END after')]) as any);
    expect(result).toMatchObject({ content: [text('before ')], stopReason: 'stop_sequence' });
    expect(events).toEqual(['before ']);
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

// ---------------------------------------------------------------------------
// prefillUserMessage
// ---------------------------------------------------------------------------

describe('prefillUserMessage in a native conversation', () => {
  const completed = () => new Response(JSON.stringify({
    id: 'm', type: 'message', role: 'assistant', model: MODEL, content: [text('ok')],
    stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
  }), { headers: { 'content-type': 'application/json' } });

  it('is the leading user turn before a context prefix, through the default formatter', async () => {
    const bodies = script(completed);
    await claude().complete(ask({ contextPrefix: 'seed', prefillUserMessage: 'CUSTOM' }) as any);
    expect(bodies[0].messages[0]).toEqual({ role: 'user', content: [text('CUSTOM')] });
    expect(bodies[0].messages[1]).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'seed' }] });
  });

  it('is the leading user turn before assistant-first history, through NativeFormatter', async () => {
    const bodies = script(completed);
    await claude({ formatter: new NativeFormatter() }).complete({
      config: { model: MODEL, maxTokens: 64 },
      messages: [
        { participant: 'Claude', content: [text('I spoke first.')] },
        { participant: 'User', content: [text('Then I did.')] },
      ],
      prefillUserMessage: 'CUSTOM',
    } as any);
    expect(bodies[0].messages[0]).toEqual({ role: 'user', content: [text('CUSTOM')] });
  });

  it('is the text the normalizer synthesizes when role repair leaves an assistant first', () => {
    const result = normalizeToolPairs([{ role: 'assistant', content: [text('a')] }], { leadingUserText: 'CUSTOM' } as any);
    expect(result.messages[0]).toEqual({ role: 'user', content: [text('CUSTOM')] });
  });

  it('leaves the synthetic turn as [continuing] when not supplied (control)', async () => {
    const bodies = script(completed);
    await claude().complete(ask({ contextPrefix: 'seed' }) as any);
    expect(bodies[0].messages[0]).toEqual({ role: 'user', content: [text('[continuing]')] });
  });

  it.each([' ', '\n', ''])('leaves the synthetic turn as [continuing] for text that is empty or only whitespace (%j)', async blank => {
    const bodies = script(completed);
    await claude({ formatter: new NativeFormatter() }).complete({
      config: { model: MODEL, maxTokens: 64 },
      messages: [
        { participant: 'Claude', content: [text('I spoke first.')] },
        { participant: 'User', content: [text('Then I did.')] },
      ],
      prefillUserMessage: blank,
    } as any);
    expect(bodies[0].messages[0]).toEqual({ role: 'user', content: [text('[continuing]')] });
    const direct = normalizeToolPairs([{ role: 'assistant', content: [text('a')] }], { leadingUserText: blank } as any);
    expect(direct.messages[0]).toEqual({ role: 'user', content: [text('[continuing]')] });
  });
});

// ---------------------------------------------------------------------------
// Aborts
// ---------------------------------------------------------------------------

describe('partialContent after a native stream aborts', () => {
  it.each(['stream', 'yielding'])('keeps a finished tool call when the transport aborts before another chunk, with stops configured (%s)', async path => {
    script(() => anthropicResponse([messageStart, ...textBlock(0, 'pre '), ...toolBlock(1, 'toolu_1', 'srv__echo', '{"x":1}')], true));
    const s = sink();
    const response = await run(path, claude(), ask({ tools: [echo], stopSequences: ['END'] }), s);
    expect(response.partialContent).toEqual([text('pre '), { type: 'tool_use', id: 'toolu_1', name: 'srv:echo', input: { x: 1 } }]);
    expect(s.toolCalls).toEqual([]);
  });

  it.each(['stream', 'yielding'])('keeps a finished thinking block and its signature when the transport aborts, with stops configured (%s)', async path => {
    script(() => anthropicResponse([messageStart, ...thinkingBlock(0, 'mull')], true));
    const response = await run(path, claude(), ask({ stopSequences: ['END'] }), sink());
    expect(response.partialContent).toEqual([{ type: 'thinking', thinking: 'mull', signature: 'signature' }]);
  });

  it.each(['stream', 'yielding'])('keeps only what precedes a stop when the transport aborts after it (%s)', async path => {
    script(() => anthropicResponse([messageStart, ...textBlock(0, 'before END after'), ...toolBlock(1, 'toolu_1', 'srv__echo', '{"x":1}')], true));
    const s = sink();
    const response = await run(path, claude(), ask({ tools: [echo], stopSequences: ['END'] }), s);
    expect(response.partialContent).toEqual([text('before ')]);
    expect(s.toolCalls).toEqual([]);
  });

  it('never hands the round\'s text twice to a callback that aborted it', async () => {
    script(() => anthropicResponse([messageStart, ...textBlock(0, 'hello'), ...messageEnd()]));
    const seen: string[] = [];
    const response: any = await claude().stream(ask({ stopSequences: ['END'] }) as any, {
      onChunk: chunk => {
        seen.push(chunk);
        throw new DOMException('consumer abort', 'AbortError');
      },
    });
    expect(seen).toEqual(['hello']);
    expect(response.partialContent).toEqual([text('hello')]);
  });

  it('keeps every block a single-final provider returned when a callback aborts after the stream', async () => {
    script(() => responsesResponse(['pre '], {
      after: [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'srv__echo', arguments: '{"x":1}', status: 'completed' } as any],
    }));
    const membrane = new Membrane(new OpenAIResponsesAPIAdapter({ apiKey: 'sk-test' }), { formatter: new OpenAIResponsesFormatter() });
    const toolCalls: unknown[] = [];
    const response: any = await membrane.stream({
      config: { model: 'gpt-5.6', maxTokens: 256 },
      messages: [{ participant: 'User', content: [text('Question')] }],
      tools: [echo],
    } as any, {
      onResponse: () => { throw new DOMException('consumer abort', 'AbortError'); },
      onToolCalls: async calls => {
        toolCalls.push(...calls);
        return [];
      },
    });
    expect(response.partialContent.map((block: any) => block.type)).toEqual(['redacted_thinking', 'text', 'tool_use']);
    expect(response.partialContent[1]).toMatchObject(text('pre '));
    expect(response.partialContent[2]).toMatchObject({ type: 'tool_use', id: 'call_1', name: 'srv:echo', input: { x: 1 } });
    expect(toolCalls).toEqual([]);
  });

  const echo = { name: 'srv:echo', description: 'echo', inputSchema: { type: 'object' as const, properties: {} } };

  it.each(['stream', 'yielding'])('keeps a tool call the provider finished, under its declared name, unexecuted (%s)', async path => {
    script(() => anthropicResponse([messageStart, ...textBlock(0, 'pre '), ...toolBlock(1, 'toolu_1', 'srv__echo', '{"x":1}')], true));
    const s = sink();
    const response = await run(path, claude(), ask({ tools: [echo] }), s);
    expect(response.partialContent).toEqual([text('pre '), { type: 'tool_use', id: 'toolu_1', name: 'srv:echo', input: { x: 1 } }]);
    expect(response.toolCalls ?? []).toEqual([]);
    expect(s.toolCalls).toEqual([]);
  });

  it.each(['stream', 'yielding'])('leaves out a tool call whose arguments never finished (%s)', async path => {
    script(() => anthropicResponse([messageStart, ...textBlock(0, 'pre '), ...toolBlock(1, 'toolu_1', 'srv__echo', '{"x":', false)], true));
    const s = sink();
    const response = await run(path, claude(), ask({ tools: [echo] }), s);
    expect(response.partialContent).toEqual([text('pre ')]);
  });

  it.each(['stream', 'yielding'])('keeps received text that was held as a possible stop (%s)', async path => {
    const open = textBlock(0, 'before E').slice(0, -1); // no content_block_stop
    script(() => anthropicResponse([messageStart, ...open], true));
    const s = sink();
    const response = await run(path, claude(), ask({ stopSequences: ['END'] }), s);
    expect(response.partialContent).toEqual([text('before E')]);
  });
});
