/**
 * A stop found inside a provider chunk, in the prefill loops.
 *
 * The loops look for the stop that ends first in the round's text, and keep
 * what comes before it. The chunk that holds the stop used to go through the
 * parser whole, and the text up to the stop went out as one piece labelled
 * with the block the parser was in after the whole chunk: so the end of a
 * <thinking> block that closed in that chunk, or of a tool call before its
 * own `</function_calls>` stop, went out as visible text. Now the parser
 * takes only the text before the stop, and what goes out is its own
 * emissions, each labelled by its block, on both loops. The round then ends
 * as a round the provider stopped does: what the parser held back goes out,
 * and the block in progress completes. A stop that turns out to sit inside a
 * block the model opened is then put back: its text starts a new block of
 * that type, and a closing tag, with no block in progress, sends no block
 * event. Neither does a closing tag that opens the round after a tool round.
 */

import { describe, it, expect } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { AnthropicXmlFormatter } from '../../src/formatters/anthropic-xml.js';
import { CompletionsFormatter } from '../../src/formatters/completions.js';
import type { ContentBlock, NormalizedRequest } from '../../src/types/index.js';
import type { ProviderAdapter, ProviderResponse } from '../../src/types/provider.js';
import type { BlockEvent, ChunkMeta, StreamCallbacks } from '../../src/types/streaming.js';
import type { PrefillFormatter } from '../../src/formatters/types.js';

/** A round's chunks; a provider that stops at a stop sequence doesn't send it. */
type Round = string[] | { chunks: string[]; stop: string };

/**
 * Streams fixed chunks, as a provider's deltas: one round per call. A call
 * past the last round throws, so a loop that runs on fails its test instead
 * of spinning until the runner's own limit.
 */
function rounds(...list: Round[]): ProviderAdapter {
  let call = 0;
  return {
    name: 'zz-chunks',
    usageCacheConvention: 'cache-excluded',
    supportsModel: () => true,
    complete: async () => {
      throw new Error('zz-chunks: complete() is not used here');
    },
    stream: async (_request: unknown, callbacks: StreamCallbacks): Promise<ProviderResponse> => {
      const round = list[call++];
      if (round === undefined) throw new Error(`zz-chunks: call ${call} asked for a round, and only ${list.length} were given`);
      const chunks = Array.isArray(round) ? round : round.chunks;
      for (const chunk of chunks) callbacks.onChunk(chunk);
      return {
        content: [{ type: 'text', text: chunks.join('') }],
        ...(Array.isArray(round) ? { stopReason: 'end_turn' } : { stopReason: 'stop_sequence', stopSequence: round.stop }),
        usage: { inputTokens: 1, outputTokens: 1 },
        model: 'zz-model',
        rawRequest: null,
        raw: null,
      };
    },
  } as ProviderAdapter;
}

// The participant's name makes '\nuser:' one of the request's stops.
const REQUEST: NormalizedRequest = {
  messages: [{ participant: 'user', content: [{ type: 'text', text: 'zz summarize' }] }],
  config: { model: 'zz-model', maxTokens: 100 },
};
// With tools, '</function_calls>' is one of the stops too.
const WITH_TOOLS: NormalizedRequest = {
  ...REQUEST,
  tools: [{ name: 'zz_look', description: 'zz', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }],
};
const THINKING: NormalizedRequest = { ...WITH_TOOLS, config: { ...REQUEST.config, thinking: { enabled: true } } };

type Piece = { text: string; type: string; visible: boolean; index: number };
/** What went out, in the order it went out. */
type Sent = { piece: Piece } | { block: BlockEvent };
type Run = { sent: Sent[]; pieces: Piece[]; blocks: BlockEvent[]; content: ContentBlock[] };
type Options = {
  formatter?: PrefillFormatter;
  request?: NormalizedRequest;
  yielding?: { emitTokens?: boolean; emitBlocks?: boolean };
  /** stream() only: false leaves out onToolCalls, so no tools run. */
  handler?: boolean;
  /** Both loops' maxToolDepth, which also caps the rounds a put-back stop resumes. */
  maxToolDepth?: number;
  /** Both loops' maxResumptionRounds, the cap on rounds a put-back stop resumes. */
  maxResumptionRounds?: number;
};

const piece = (text: string, meta: ChunkMeta): Sent => ({ piece: { text, type: meta.type, visible: meta.visible, index: meta.blockIndex } });
const xml = () => new AnthropicXmlFormatter({ toolMode: 'xml' });
const result = (call: { id: string }) => ({ toolUseId: call.id, content: 'zz found', isError: false });

function split(sent: Sent[], content: ContentBlock[]): Run {
  return {
    sent,
    pieces: sent.flatMap((s) => ('piece' in s ? [s.piece] : [])),
    blocks: sent.flatMap((s) => ('block' in s ? [s.block] : [])),
    content,
  };
}

async function viaYielding(adapter: ProviderAdapter, options: Options = {}): Promise<Run> {
  const membrane = new Membrane(adapter, { formatter: options.formatter ?? xml() });
  const sent: Sent[] = [];
  let content: ContentBlock[] = [];
  const stream = membrane.streamYielding(options.request ?? REQUEST, {
    ...(options.yielding ?? {}),
    ...(options.maxToolDepth === undefined ? {} : { maxToolDepth: options.maxToolDepth }),
    ...(options.maxResumptionRounds === undefined ? {} : { maxResumptionRounds: options.maxResumptionRounds }),
  });
  for await (const event of stream) {
    if (event.type === 'tokens') sent.push(piece(event.content, event.meta));
    if (event.type === 'block') sent.push({ block: event.event });
    if (event.type === 'tool-calls') stream.provideToolResults(event.calls.map(result));
    if (event.type === 'complete') content = event.response.content;
    if (event.type === 'error') throw event.error;
  }
  return split(sent, content);
}

async function viaStream(adapter: ProviderAdapter, options: Options = {}): Promise<Run> {
  const membrane = new Membrane(adapter, { formatter: options.formatter ?? xml() });
  const sent: Sent[] = [];
  const response = await membrane.stream(options.request ?? REQUEST, {
    onChunk: (text: string, meta: ChunkMeta) => sent.push(piece(text, meta)),
    onBlock: (event: BlockEvent) => sent.push({ block: event }),
    onToolCalls: options.handler === false ? undefined : async (calls) => calls.map(result),
    ...(options.maxToolDepth === undefined ? {} : { maxToolDepth: options.maxToolDepth }),
    ...(options.maxResumptionRounds === undefined ? {} : { maxResumptionRounds: options.maxResumptionRounds }),
  });
  if ('aborted' in response) throw new Error('zz the turn aborted');
  return split(sent, response.content);
}

const visible = (pieces: Piece[]) => pieces.filter((p) => p.visible).map((p) => p.text).join('');

/** Each block that starts completes, once, and no index starts twice. */
function paired(blocks: BlockEvent[]): void {
  const started = blocks.filter((b) => b.event === 'block_start').map((b) => b.index);
  const completed = blocks.filter((b) => b.event === 'block_complete').map((b) => b.index);
  expect(new Set(started).size, `an index started twice: ${JSON.stringify(started)}`).toBe(started.length);
  expect([...completed].sort((a, b) => a - b)).toEqual([...started].sort((a, b) => a - b));
}

const start = (index: number, type: string): Sent => ({ block: { event: 'block_start', index, block: { type } } as BlockEvent });
const complete = (index: number, type: string, content: string): Sent => ({ block: { event: 'block_complete', index, block: { type, content } } as BlockEvent });
const text = (value: string, index: number): Sent => ({ piece: { text: value, type: 'text', visible: true, index } });
const thought = (value: string, index: number): Sent => ({ piece: { text: value, type: 'thinking', visible: false, index } });
const callText = (value: string, index: number): Sent => ({ piece: { text: value, type: 'tool_call', visible: false, index } });
const resultText = (value: string, index: number): Sent => ({ piece: { text: value, type: 'tool_result', visible: false, index } });
/** The tool path's block for a call it parsed, after the parser's block for the call's text. */
const parsedCall = (index: number, toolName: string, input: unknown): Sent => ({
  block: { event: 'block_complete', index, block: { type: 'tool_call', toolId: expect.any(String), toolName, input } } as BlockEvent,
});
const resultComplete = (index: number, content: string): Sent => ({
  block: { event: 'block_complete', index, block: { type: 'tool_result', toolId: expect.any(String), content, isError: false } } as BlockEvent,
});

describe.each([
  ['streamYielding', viaYielding],
  ['stream', viaStream],
] as const)('a stop inside a chunk, through %s', (_name, run) => {
  it('labels the end of a thinking block that closed in that chunk as thinking, and sends each piece and event in order', async () => {
    const { sent, content } = await run(rounds(['<thinking>Which', ' memories matter?</thinking>They met.\nuser: next']));
    expect(sent).toEqual([
      start(0, 'thinking'),
      thought('Which', 0),
      thought(' memories matter?', 0),
      complete(0, 'thinking', 'Which memories matter?'),
      start(1, 'text'),
      text('They met.', 1),
      complete(1, 'text', 'They met.'),
    ]);
    expect(content).toEqual([
      { type: 'thinking', thinking: 'Which memories matter?' },
      { type: 'text', text: 'They met.' },
    ]);
  });

  it('sends the text before the stop when the chunk holds text alone, nothing after it, and completes the block', async () => {
    const { sent, content } = await run(rounds(['They ', 'met.\nuser: next']));
    expect(sent).toEqual([start(0, 'text'), text('They ', 0), text('met.', 0), complete(0, 'text', 'They met.')]);
    expect(content).toEqual([{ type: 'text', text: 'They met.' }]);
  });

  it('sends what the parser held back before the stop: a possible tag\'s start', async () => {
    // '<thi' could begin a <thinking> tag, so the parser holds it until the
    // round ends; it's the model's text, and the content keeps it.
    const { sent, content } = await run(rounds(['They met. <thi\nuser: next']));
    expect(sent).toEqual([start(0, 'text'), text('They met. ', 0), text('<thi', 0), complete(0, 'text', 'They met. <thi')]);
    expect(content).toEqual([{ type: 'text', text: 'They met. <thi' }]);
  });

  it('sends what the parser held back when the stop begins at the next chunk\'s start', async () => {
    const { sent, content } = await run(rounds(['They met. <', '\nuser: next']));
    expect(sent).toEqual([start(0, 'text'), text('They met. ', 0), text('<', 0), complete(0, 'text', 'They met. <')]);
    expect(content).toEqual([{ type: 'text', text: 'They met. <' }]);
  });

  it('sends what the parser held back at a round that ends without a stop', async () => {
    const { sent, content } = await run(rounds(['They met. <']));
    expect(sent).toEqual([start(0, 'text'), text('They met. ', 0), text('<', 0), complete(0, 'text', 'They met. <')]);
    expect(content).toEqual([{ type: 'text', text: 'They met. <' }]);
  });

  it('sends nothing of a chunk when the stop began in the chunk before it', async () => {
    // '\nuser:' begins in the first chunk, which held no whole stop, so all
    // of it has gone out, the stop's first part included. The second gives
    // nothing. A stop split across chunks is otherwise left as it was: the
    // parser starts again from the text before the stop, and the round's
    // block isn't completed.
    const { sent, content } = await run(rounds(['They met.\nus', 'er: next']));
    expect(sent).toEqual([start(0, 'text'), text('They met.\nus', 0)]);
    expect(content).toEqual([{ type: 'text', text: 'They met.' }]);
  });

  it('finds the stop after the prefill only, though the prefill holds its text', async () => {
    // The XML prefill writes the conversation, so an earlier user turn puts
    // '\nuser:' before the round's text.
    const request: NormalizedRequest = {
      ...REQUEST,
      messages: [
        { participant: 'user', content: [{ type: 'text', text: 'zz first' }] },
        { participant: 'user', content: [{ type: 'text', text: 'zz summarize' }] },
      ],
    };
    const { sent, content } = await run(rounds(['They met.\nuser: next']), { request });
    expect(sent).toEqual([start(0, 'text'), text('They met.', 0), complete(0, 'text', 'They met.')]);
    expect(content).toEqual([{ type: 'text', text: 'They met.' }]);
  });

  it('labels the end of a tool call before its own </function_calls> stop as the tool call, and numbers the next round\'s blocks on', async () => {
    const { pieces, blocks, content } = await run(rounds(
      ['Let me look.<function_calls>\n<invoke name="zz_look">\n<parameter name="q">zz</parameter>\n', '</invoke>\n</function_calls>\nuser: next'],
      ['Found it.'],
    ), { request: WITH_TOOLS });
    // Nothing of the call goes out as visible text; the stop chunk's text before the stop is the call's.
    expect(visible(pieces)).toBe('Let me look.Found it.');
    expect(pieces.filter((p) => p.type === 'tool_call').map((p) => p.text).join('')).toBe('\n\nzz\n\n');
    expect(blocks.filter((b) => b.event === 'block_complete' && b.block.type === 'tool_call').map((b) => (b.block as { toolName?: string }).toolName))
      .toEqual([undefined, 'zz_look']);
    // The round's blocks complete, and the tool call's and the next round's take indices after them.
    paired(blocks);
    expect(content.filter((b) => b.type === 'text')).toEqual([{ type: 'text', text: 'Let me look.' }, { type: 'text', text: 'Found it.' }]);
  });

  it('puts a stop found inside a block the model opened back in a new block of that type, which goes on into the next round', async () => {
    // '\nuser:' inside a thinking block isn't the next turn: the loop puts the
    // stop's text back and asks for the rest. The round's end has completed
    // the model's block, so the stop's text starts a new one of its type.
    const { sent, content } = await run(rounds(
      ['<thinking>Who speaks?\nuser: is next'],
      [' is next.</thinking>They met.'],
    ));
    expect(sent).toEqual([
      start(0, 'thinking'),
      thought('Who speaks?', 0),
      complete(0, 'thinking', 'Who speaks?'),
      start(1, 'thinking'),
      thought('\nuser:', 1),
      thought(' is next.', 1),
      complete(1, 'thinking', '\nuser: is next.'),
      start(2, 'text'),
      text('They met.', 2),
      complete(2, 'text', 'They met.'),
    ]);
    expect(content).toEqual([
      { type: 'thinking', thinking: 'Who speaks?\nuser: is next.' },
      { type: 'text', text: 'They met.' },
    ]);
  });

  it('completes the block a put-back stop opens when the turn ends at the depth cap right after it', async () => {
    // The stop sits inside the thinking block the model opened, so it's put
    // back, opening a new thinking block, and the depth cap then ends the turn.
    const { blocks } = await run(rounds(['<thinking>Who speaks?', '\nuser: is next.']), { maxToolDepth: 0 });
    expect(blocks.filter((b) => b.event === 'block_start').map((b) => b.block.type)).toEqual(['thinking', 'thinking']);
    paired(blocks);
  });

  it('completes the block a put-back stop opens when the turn ends at the resumption cap right after it', async () => {
    const { blocks } = await run(rounds(['<thinking>Who speaks?', '\nuser: is next.']), { maxResumptionRounds: 0 });
    expect(blocks.filter((b) => b.event === 'block_start').map((b) => b.block.type)).toEqual(['thinking', 'thinking']);
    paired(blocks);
  });

  it('through a plain formatter, sends the text before the stop, completes the block, and sends no empty piece for a chunk the stop begins', async () => {
    const { sent } = await run(rounds(['They met.', '\nuser: next']), { formatter: new CompletionsFormatter() });
    // The plain parser's block content is everything it was given, prompt included, so only its shape is asserted.
    expect(sent.map((s) => ('piece' in s ? ['piece', s.piece.text, s.piece.type, s.piece.index] : [s.block.event, s.block.index, s.block.block.type])))
      .toEqual([['block_start', 0, 'text'], ['piece', 'They met.', 'text', 0], ['block_complete', 0, 'text']]);
  });
});

describe.each([
  ['streamYielding', viaYielding],
  ['stream', viaStream],
] as const)('a closing tag with no block in progress, through %s', (_name, run) => {
  it('puts back a </function_calls> stop written inside a thinking block, when no call parses, with no block event, and the thinking goes on in a new block', async () => {
    // No call parses, so the stop sits inside the thinking block the model
    // opened, and the loop puts it back. The round's end has completed the
    // tool call's block, so the closing tag has no block to complete. Only
    // the stream is asserted: the content's thinking holds that closing tag
    // twice, a separate fault. The tool path adds it, which brings the call
    // depth back to the prefill's, and the put-back adds it again because the
    // thinking block is still open.
    const { sent, blocks } = await run(rounds(
      ['<thinking>I could write <function_calls> here', '</function_calls>\nuser: next'],
      [' but won\'t.</thinking>Done.'],
    ), { request: WITH_TOOLS });
    expect(sent).toEqual([
      start(0, 'thinking'),
      thought('I could write ', 0),
      complete(0, 'thinking', 'I could write '),
      start(1, 'tool_call'),
      callText(' here', 1),
      complete(1, 'tool_call', ' here'),
      start(2, 'thinking'),
      thought(' but won\'t.', 2),
      complete(2, 'thinking', ' but won\'t.'),
      start(3, 'text'),
      text('Done.', 3),
      complete(3, 'text', 'Done.'),
    ]);
    paired(blocks);
  });

  it('sends no block event for a </thinking> that opens the round after a tool round', async () => {
    // With thinking on, the tool round ends what the model is sent with
    // '\n<thinking>', which starts no block in the stream, so the model
    // closing it at once has no block to complete.
    const { sent, blocks } = await run(rounds(
      ['I will look.</thinking><function_calls>\n<invoke name="zz_look">\n<parameter name="q">zz</parameter>\n</invoke>\n', '</function_calls>'],
      ['</thinking>Found it.'],
    ), { request: THINKING });
    expect(sent).toEqual([
      start(0, 'thinking'),
      thought('I will look.', 0),
      complete(0, 'thinking', 'I will look.'),
      start(1, 'tool_call'),
      callText('\n', 1),
      callText('\n', 1),
      callText('zz', 1),
      callText('\n', 1),
      callText('\n', 1),
      complete(1, 'tool_call', '\n\nzz\n\n'),
      start(2, 'tool_call'),
      parsedCall(2, 'zz_look', { q: 'zz' }),
      start(3, 'tool_result'),
      resultText('zz found', 3),
      resultComplete(3, 'zz found'),
      start(4, 'text'),
      text('Found it.', 4),
      complete(4, 'text', 'Found it.'),
    ]);
    paired(blocks);
  });

  // A closing tag with no block in progress leaves its depth at 0, so a block
  // the model opens after it counts as open, and a stop inside that block is
  // put back, whether the loop finds the stop or the provider applied it.
  const afterStrayClose: Sent[] = [
    start(0, 'text'),
    text('They met.', 0),
    complete(0, 'text', 'They met.'),
    start(1, 'thinking'),
    thought('Who speaks?', 1),
    complete(1, 'thinking', 'Who speaks?'),
    start(2, 'thinking'),
    thought('\nuser:', 2),
    thought(' is next.', 2),
    complete(2, 'thinking', '\nuser: is next.'),
    start(3, 'text'),
    text('Done.', 3),
    complete(3, 'text', 'Done.'),
  ];

  it('takes no depth below 0, so a stop the loop finds inside a block the model opens after it is put back', async () => {
    const { sent, blocks } = await run(rounds(
      ['</thinking>They met.<thinking>Who speaks?\nuser: is next'],
      [' is next.</thinking>Done.'],
    ));
    expect(sent).toEqual(afterStrayClose);
    paired(blocks);
  });

  it('takes no depth below 0, so a stop the provider applied inside a block the model opens after it is put back', async () => {
    const { sent, blocks } = await run(rounds(
      { chunks: ['</thinking>They met.<thinking>Who speaks?'], stop: '\nuser:' },
      [' is next.</thinking>Done.'],
    ));
    expect(sent).toEqual(afterStrayClose);
    paired(blocks);
  });
});

describe('a closing tag with no block in progress, through stream() with no onToolCalls', () => {
  it('puts the </function_calls> stop back with no block event, and the next round\'s text is the next block', async () => {
    // With no onToolCalls no tool runs, so the stop sits inside the tool
    // call the model opened, and the loop puts it back and asks for the rest.
    // The round's end has completed the call's block, so the closing tag has
    // no block to complete.
    const { sent, blocks } = await viaStream(rounds(
      ['Let me look.<function_calls>\n<invoke name="zz_look">\n<parameter name="q">zz</parameter>\n', '</invoke>\n</function_calls>\nuser: next'],
      ['Found it.'],
    ), { request: WITH_TOOLS, handler: false });
    expect(sent).toEqual([
      start(0, 'text'),
      text('Let me look.', 0),
      complete(0, 'text', 'Let me look.'),
      start(1, 'tool_call'),
      callText('\n', 1),
      callText('\n', 1),
      callText('zz', 1),
      callText('\n', 1),
      callText('\n', 1),
      complete(1, 'tool_call', '\n\nzz\n\n'),
      start(2, 'text'),
      text('Found it.', 2),
      complete(2, 'text', 'Found it.'),
    ]);
    paired(blocks);
  });
});

/**
 * Streams fixed chunks inside one text block a round, with the block's typed
 * events around them, as an adapter that reports typed blocks does. The block
 * takes the provider's `index`, such as 1 for a text block that follows the
 * provider's thinking block.
 */
function typedRounds(index: number, ...list: Round[]): ProviderAdapter {
  const plain = rounds(...list);
  return {
    ...plain,
    name: 'zz-typed',
    stream: async (request: unknown, callbacks: StreamCallbacks): Promise<ProviderResponse> => {
      let streamed = '';
      callbacks.onContentBlock?.(index, { type: 'text', text: '' } as ContentBlock);
      const response = await plain.stream(request as never, {
        ...callbacks,
        onChunk: (chunk: string) => { streamed += chunk; callbacks.onChunk(chunk); },
      });
      callbacks.onContentBlock?.(index, { type: 'text', text: streamed } as ContentBlock);
      return response;
    },
  } as ProviderAdapter;
}

/** The pieces that went out while the provider had no block open. */
function outsideProviderBlocks(sent: Sent[]): Piece[] {
  let open = false;
  const outside: Piece[] = [];
  for (const s of sent) {
    if ('block' in s) open = s.block.event === 'block_start';
    else if (!open) outside.push(s.piece);
  }
  return outside;
}

/**
 * A prefill formatter whose parser reads XML blocks but which runs no XML
 * tools, as a consumer's own formatter can be: the provider's typed blocks
 * then label the stream.
 */
function xmlBlocksNoXmlTools(): PrefillFormatter {
  const formatter = xml();
  (formatter as unknown as { supportsXmlTools: boolean }).supportsXmlTools = false;
  return formatter;
}

describe.each([
  ['streamYielding', (adapter: ProviderAdapter, options: Options = {}) => viaYielding(adapter, { ...options, yielding: { emitTokens: true, emitBlocks: true } })],
  ['stream', viaStream],
] as const)('under the provider\'s typed blocks, through %s', (_name, run) => {
  it('streams nothing the parser held back at a round\'s end, and a put-back stop at the parser\'s index 0, outside the provider\'s blocks', async () => {
    // The stop sits inside the thinking block the model opened, so it's put
    // back after the provider's block completed: main sent it then, labelled
    // with the parser's block and index 0, and still does. The provider's
    // blocks sit at index 1, so that 0 is main's own, not the provider's. The
    // next round ends with a possible tag's start, which the parser holds back
    // until the round ends, and which main never streamed.
    const { sent, blocks } = await run(typedRounds(1,
      ['zz <thinking>Who speaks?', '\nuser: is next.'],
      [' They met.</thinking> zz done <'],
    ), { formatter: xmlBlocksNoXmlTools() });
    expect(blocks.filter((b) => b.event === 'block_complete').map((b) => b.index), 'the premise: the provider completed a block at index 1 each round').toEqual([1, 1]);
    expect(sent.some((s) => 'piece' in s), 'the premise: the rounds\' text went out').toBe(true);
    expect(outsideProviderBlocks(sent)).toEqual([{ text: '\nuser:', type: 'thinking', visible: false, index: 0 }]);
  });

  it('labels each piece before a stop the loop found by its own block, with the provider\'s index, and sends nothing after the stop', async () => {
    // The second chunk closes the thinking block and holds the stop: main sent
    // its text before the stop as one visible piece at index 0.
    const { pieces, blocks } = await run(typedRounds(1,
      ['zz <thinking>Who speaks?', ' They met.</thinking>Done.\nuser: next'],
    ), { formatter: xmlBlocksNoXmlTools() });
    expect(blocks.map((b) => [b.event, b.index]), 'the premise: the provider\'s block, and no block event of the parser\'s').toEqual([['block_start', 1], ['block_complete', 1]]);
    expect(pieces.every((p) => p.index === 1)).toBe(true);
    expect(visible(pieces)).toBe('zz Done.');
    expect(pieces.filter((p) => p.type === 'thinking').map((p) => p.text).join('')).toBe('Who speaks? They met.');
    expect(pieces.some((p) => p.text.includes('next'))).toBe(false);
  });

  it('labels a put-back </function_calls> stop with the tool call it closes, not as visible text', async () => {
    // With no XML tools, nothing runs the call, so the stop sits inside the
    // block the model opened and is put back.
    const { sent } = await run(typedRounds(1,
      ['zz <function_calls><invoke name="zz_look">', '</function_calls> zz after'],
      [' They met.'],
    ), { formatter: xmlBlocksNoXmlTools() });
    expect(outsideProviderBlocks(sent)).toEqual([{ text: '</function_calls>', type: 'tool_call', visible: false, index: 0 }]);
  });

  it.each([
    ['the depth cap', { maxToolDepth: 0 }],
    ['the resumption cap', { maxResumptionRounds: 0 }],
  ] as const)('streams nothing the parser held back of a put-back stop when the turn ends at %s right after it', async (_cap, caps) => {
    // The stop ends in a possible tag's start, which the parser holds back
    // after the put-back. The put-back has already sent the stop whole.
    const { sent } = await run(typedRounds(1, ['<thinking>Who speaks? zz <', 'next']), {
      formatter: xmlBlocksNoXmlTools(),
      request: { ...REQUEST, stopSequences: ['zz <'] },
      ...caps,
    });
    expect(outsideProviderBlocks(sent)).toEqual([{ text: 'zz <', type: 'thinking', visible: false, index: 0 }]);
  });
});

describe('a put-back stop under the provider\'s typed blocks, through streamYielding with tokens turned off', () => {
  it('sends no tokens, and the provider\'s block events', async () => {
    const { pieces, blocks } = await viaYielding(typedRounds(1,
      ['zz <thinking>Who speaks?', '\nuser: is next.'],
      [' They met.</thinking> zz done'],
    ), { formatter: xmlBlocksNoXmlTools(), yielding: { emitTokens: false, emitBlocks: true } });
    expect(pieces).toEqual([]);
    expect(blocks.map((b) => [b.event, b.index])).toEqual([['block_start', 1], ['block_complete', 1], ['block_start', 1], ['block_complete', 1]]);
  });
});

describe('a stop inside a chunk, through streamYielding with events turned off', () => {
  const chunks = ['<thinking>Which', ' memories matter?</thinking>They met.\nuser: next'];

  it('sends no tokens with emitTokens off, and every block event', async () => {
    const { pieces, blocks } = await viaYielding(rounds(chunks), { yielding: { emitTokens: false } });
    expect(pieces).toEqual([]);
    expect(blocks.map((b) => [b.event, b.index])).toEqual([['block_start', 0], ['block_complete', 0], ['block_start', 1], ['block_complete', 1]]);
  });

  it('sends no block events with emitBlocks off, and every token', async () => {
    const { pieces, blocks } = await viaYielding(rounds(chunks), { yielding: { emitBlocks: false } });
    expect(blocks).toEqual([]);
    expect(pieces.map((p) => p.text).join('')).toBe('Which memories matter?They met.');
  });
});
