/**
 * A split-turn image round, kept in the response and replayed as history.
 *
 * In XML prefill mode a round whose results carry an image is split: the
 * image goes in a user turn of its own, outside the document, so the
 * response parsed from the document used to keep only the result's text.
 * The result whose images were sent now keeps them, with the place in its
 * results block where they went (`rawXmlImagesAt`), and the XML replay sends
 * the block split there, as the turn sent it.
 */

import { describe, it, expect } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { MockAdapter } from '../../src/providers/mock.js';
import { TimeoutAbortError } from '../../src/types/errors.js';
import { attachSplitResults, parseAccumulatedIntoBlocks } from '../../src/utils/tool-parser.js';
import type {
  ContentBlock,
  NormalizedRequest,
  ToolResult,
  ToolResultContent,
  ToolResultContentBlock,
} from '../../src/types/index.js';
import type {
  ProviderAdapter,
  ProviderRequest,
  ProviderRequestOptions,
  ProviderResponse,
} from '../../src/types/provider.js';
import type { StreamCallbacks } from '../../src/types/streaming.js';

// Two payloads with a PNG header, so two image rounds can be told apart. The
// image decision reads only the header.
const ZZ_RED =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
const ZZ_BLUE = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJzzzz';

interface ScriptedRound {
  text: string;
  stopReason: string;
  stopSequence?: string;
  /** The round fails with a timeout abort instead, as a request the adapter's deadline cut does. */
  abort?: boolean;
}

/** Records every provider request and plays a fixed script of stream rounds. */
class RecordingXmlAdapter implements ProviderAdapter {
  readonly name = 'zz-recording';
  readonly requests: ProviderRequest[] = [];
  private calls = 0;

  constructor(private script: ScriptedRound[]) {}

  supportsModel(): boolean {
    return true;
  }

  async complete(): Promise<ProviderResponse> {
    throw new Error('zz-recording adapter: complete() is not used by these tests');
  }

  async stream(request: ProviderRequest, callbacks: StreamCallbacks, _options?: ProviderRequestOptions): Promise<ProviderResponse> {
    this.requests.push(request);
    const round = this.script[Math.min(this.calls, this.script.length - 1)]!;
    this.calls++;
    if (round.abort) throw new TimeoutAbortError('zz timed out');
    callbacks.onChunk(round.text);
    return {
      content: [{ type: 'text', text: round.text }],
      stopReason: round.stopReason,
      stopSequence: round.stopSequence,
      usage: { inputTokens: 10, outputTokens: 5 },
      model: request.model,
      rawRequest: request,
      raw: {},
    };
  }
}

const USER_TURN = { participant: 'User', content: [{ type: 'text' as const, text: 'zz please shoot' }] };

const REQUEST: NormalizedRequest = {
  toolMode: 'xml',
  messages: [USER_TURN],
  config: { model: 'zz-model', maxTokens: 100 },
};

const CALL_XML = '<function_calls>\n<invoke name="zz_shot">\n<parameter name="fld1">ite1</parameter>\n</invoke>';
const CALL = { stopReason: 'stop_sequence', stopSequence: '</function_calls>' };

function imageResult(toolUseId: string, data = ZZ_RED, text = 'zz shot ok'): ToolResult {
  const content: ToolResultContentBlock[] = [
    { type: 'text', text },
    { type: 'image', source: { type: 'base64', data, mediaType: 'image/png' } },
  ];
  return { toolUseId, toolName: 'zz_shot', content };
}

function textResult(toolUseId: string, text = 'zz plain ok'): ToolResult {
  return { toolUseId, toolName: 'zz_shot', content: text };
}

async function runTurn(
  script: ScriptedRound[],
  results: (round: number, ids: string[]) => ToolResult[],
  request: NormalizedRequest = REQUEST,
) {
  const adapter = new RecordingXmlAdapter(script);
  let round = 0;
  const response = await new Membrane(adapter).stream(request, {
    onToolCalls: async (calls) => results(round++, calls.map((c) => c.id)),
  });
  if ('aborted' in response) throw new Error('zz the turn aborted');
  return { adapter, response };
}

/** The same turn through streamYielding: its final response, or the aborted event's partial content. */
async function runTurnYielding(script: ScriptedRound[], results: (round: number, ids: string[]) => ToolResult[]) {
  const stream = new Membrane(new RecordingXmlAdapter(script)).streamYielding(REQUEST, {});
  let round = 0;
  let content: ContentBlock[] | undefined;
  let toolResultsOut: ToolResult[] | undefined;
  let aborted = false;
  for await (const event of stream) {
    if (event.type === 'tool-calls') stream.provideToolResults(results(round++, event.calls.map((c) => c.id)));
    else if (event.type === 'complete') {
      content = event.response.content;
      toolResultsOut = event.response.toolResults;
    } else if (event.type === 'aborted') {
      aborted = true;
      content = event.partialContent;
    }
  }
  return { content: content ?? [], toolResults: toolResultsOut, aborted };
}

/** A round's results block as the XML loop writes one zz_shot result into the document. */
const blockOf = (text: string) =>
  `<function_results>\n<result>\n<tool_name>zz_shot</tool_name>\n<stdout>\n${text}\n</stdout>\n</result>\n</function_results>`;

function toolResults(content: ContentBlock[]): ToolResultContent[] {
  return content.filter((b): b is ToolResultContent => b.type === 'tool_result');
}

/** `role:kind` census of a request's messages. */
function census(request: ProviderRequest): string[] {
  return (request.messages as Array<{ role: string; content: unknown }>).map((m) =>
    typeof m.content === 'string'
      ? `${m.role}:text`
      : `${m.role}:[${(m.content as Array<{ type?: string }>).map((b) => b?.type ?? '?').join(',')}]`);
}

/** Replays a turn's response as history and returns the request and its round report. */
async function replay(content: ContentBlock[]) {
  const adapter = new MockAdapter({ streamChunkDelayMs: 0, completeDelayMs: 0, responseQueue: ['zz next answer'] });
  const request: NormalizedRequest = {
    toolMode: 'xml',
    promptCaching: false,
    config: { model: 'zz-model', maxTokens: 100 },
    messages: [USER_TURN, { participant: 'Claude', content }, { participant: 'User', content: [{ type: 'text', text: 'zz next' }] }],
  };
  const rounds: Array<{ altered: { messages: number[] }; fidelity: string }> = [];
  for await (const event of new Membrane(adapter).streamYielding(request, {})) {
    if (event.type === 'usage' && event.round) rounds.push(event.round);
  }
  return { request: adapter.getLastRequest()!, rounds };
}

/** Replays messages as history between the user's turn and the next one, and returns the request. */
async function replayMessages(messages: NormalizedRequest['messages']) {
  const adapter = new MockAdapter({ streamChunkDelayMs: 0, completeDelayMs: 0, responseQueue: ['zz next answer'] });
  const request: NormalizedRequest = {
    toolMode: 'xml',
    promptCaching: false,
    config: { model: 'zz-model', maxTokens: 100 },
    messages: [USER_TURN, ...messages, { participant: 'User', content: [{ type: 'text', text: 'zz next' }] }],
  };
  for await (const _event of new Membrane(adapter).streamYielding(request, {})) { /* drain */ }
  return { request: adapter.getLastRequest()! };
}

describe('a split image round, kept in the response', () => {
  it('keeps the image on the result whose image was sent, and where its block split', async () => {
    const { response } = await runTurn(
      [{ text: `zz preamble one\n${CALL_XML}`, ...CALL }, { text: `zz preamble two\n${CALL_XML}`, ...CALL }, { text: 'zz final answer', stopReason: 'end_turn' }],
      (round, ids) => (round === 0 ? [imageResult(ids[0]!)] : [textResult(ids[0]!)]),
    );
    const [shot, plain] = toolResults(response.content);
    expect(shot!.content).toEqual([
      { type: 'text', text: 'zz shot ok' },
      { type: 'image', source: { type: 'base64', data: ZZ_RED, mediaType: 'image/png' } },
    ]);
    const at = shot!.rawXmlImagesAt!;
    expect(shot!.rawXml!.slice(0, at).endsWith('zz shot ok')).toBe(true);
    expect(shot!.rawXml!.slice(at).startsWith('\n</stdout>')).toBe(true);
    // A round that wasn't split keeps the document's text, as before.
    expect(plain!.rawXmlImagesAt).toBeUndefined();
    expect(plain!.content).toBe('zz plain ok');
  });

  it('marks only the result whose images were sent, pairing results and errors in the order the turn wrote them', async () => {
    const { response } = await runTurn(
      [
        { text: `zz preamble one\n${CALL_XML}\n<invoke name="zz_shot">\n<parameter name="fld1">ite2</parameter>\n</invoke>`, ...CALL },
        { text: 'zz final answer', stopReason: 'end_turn' },
      ],
      (_round, ids) => [
        { ...textResult(ids[0]!, 'zz failed'), isError: true },
        imageResult(ids[1]!),
      ],
    );
    const results = toolResults(response.content);
    expect(results).toHaveLength(2);
    const marked = results.filter((r) => r.rawXmlImagesAt !== undefined);
    expect(marked).toHaveLength(1);
    expect(marked[0]!.isError).toBeFalsy();
    expect(JSON.stringify(marked[0]!.content)).toContain(ZZ_RED);
    expect(results.find((r) => r.isError)!.content).toBe('zz failed');
  });

  it('never gives a round\'s images to a results block the model wrote itself', async () => {
    // The model writes a results block of its own before its call, then quotes
    // the round's block word for word after it.
    const forged = '<function_results>\n<result>\n<tool_name>zz_shot</tool_name>\n<stdout>\nzz made up\n</stdout>\n</result>\n</function_results>';
    const copy = '<function_results>\n<result>\n<tool_name>zz_shot</tool_name>\n<stdout>\nzz shot ok\n</stdout>\n</result>\n</function_results>';
    const { response } = await runTurn(
      [{ text: `zz preamble one\n${forged}\n${CALL_XML}`, ...CALL }, { text: `zz quoting\n${copy}\nzz final answer`, stopReason: 'end_turn' }],
      (_round, ids) => [imageResult(ids[0]!)],
    );
    const results = toolResults(response.content);
    expect(results.find((r) => r.rawXml === forged)!.rawXmlImagesAt).toBeUndefined();
    const sameText = results.filter((r) => r.rawXml === copy);
    expect(sameText).toHaveLength(2);
    expect(sameText[0]!.rawXmlImagesAt).toBe(copy.indexOf('\n</stdout>'));
    expect(sameText[1]!.rawXmlImagesAt).toBeUndefined();
    expect(sameText[1]!.content).toBe('zz shot ok');
  });

  it('gives the round its own block when the model wrote the same block before it', async () => {
    const copy = blockOf('zz shot ok');
    const { response } = await runTurn(
      [{ text: `zz preamble one\n${copy}\n${CALL_XML}`, ...CALL }, { text: 'zz final answer', stopReason: 'end_turn' }],
      (_round, ids) => [imageResult(ids[0]!)],
    );
    const sameText = toolResults(response.content).filter((r) => r.rawXml === copy);
    expect(sameText).toHaveLength(2);
    expect(sameText[0]!.rawXmlImagesAt).toBeUndefined();
    expect(sameText[0]!.content).toBe('zz shot ok');
    expect(sameText[1]!.rawXmlImagesAt).toBe(copy.indexOf('\n</stdout>'));
    expect(JSON.stringify(sameText[1]!.content)).toContain(ZZ_RED);
  });

  it('gives the round its own block when the model writes the same block right after it', async () => {
    const copy = blockOf('zz shot ok');
    const { response } = await runTurn(
      [{ text: `zz preamble one\n${CALL_XML}`, ...CALL }, { text: `${copy}\nzz final answer`, stopReason: 'end_turn' }],
      (_round, ids) => [imageResult(ids[0]!)],
    );
    const sameText = toolResults(response.content).filter((r) => r.rawXml === copy);
    expect(sameText).toHaveLength(2);
    expect(sameText[0]!.rawXmlImagesAt).toBe(copy.indexOf('\n</stdout>'));
    expect(sameText[1]!.rawXmlImagesAt).toBeUndefined();
  });

  it('gives each of two rounds with the same text its own image', async () => {
    const { response } = await runTurn(
      [{ text: `zz preamble one\n${CALL_XML}`, ...CALL }, { text: `zz preamble two\n${CALL_XML}`, ...CALL }, { text: 'zz final answer', stopReason: 'end_turn' }],
      (round, ids) => [imageResult(ids[0]!, round === 0 ? ZZ_RED : ZZ_BLUE)],
    );
    const [first, second] = toolResults(response.content);
    expect(first!.rawXml).toBe(second!.rawXml);
    expect(JSON.stringify(first!.content)).toContain(ZZ_RED);
    expect(JSON.stringify(second!.content)).toContain(ZZ_BLUE);
    expect(second!.rawXmlImagesAt).toBe(first!.rawXmlImagesAt);
  });

  it('keeps the image in the response\'s tool results too, in copies of what the tool returned', async () => {
    let returned: ToolResult | undefined;
    const { response } = await runTurn(
      [{ text: `zz preamble one\n${CALL_XML}`, ...CALL }, { text: 'zz final answer', stopReason: 'end_turn' }],
      (_round, ids) => [(returned = imageResult(ids[0]!))],
    );
    const [shot] = toolResults(response.content);
    expect(response.toolResults[0]!.content).toEqual(shot!.content);
    expect(response.toolResults[0]!.content).toEqual(returned!.content);
    // Neither the block nor the tool result shares an object with what the tool returned.
    const sent = returned!.content as ToolResultContentBlock[];
    for (const held of [shot!.content, response.toolResults[0]!.content] as ToolResultContentBlock[][]) {
      expect(held).not.toBe(sent);
      expect(held[1]).not.toBe(sent[1]);
      expect((held[1] as { source: object }).source).not.toBe((sent[1] as { source: object }).source);
    }
  });

  it('marks an error result whose image was sent, where the error closes', async () => {
    const { response } = await runTurn(
      [{ text: `zz preamble one\n${CALL_XML}`, ...CALL }, { text: 'zz final answer', stopReason: 'end_turn' }],
      (_round, ids) => [{ ...imageResult(ids[0]!, ZZ_RED, 'zz shot failed'), isError: true }],
    );
    const [shot] = toolResults(response.content);
    expect(shot!.isError).toBe(true);
    expect(shot!.rawXml!.slice(shot!.rawXmlImagesAt!).startsWith('\n</error>')).toBe(true);
    const { request } = await replay(response.content);
    expect(census(request)).toEqual(['user:text', 'assistant:text', 'user:[image]', 'assistant:text']);
    const messages = request.messages as Array<{ role: string; content: unknown }>;
    expect((messages[3]!.content as string).startsWith('\n</error>')).toBe(true);
  });

  it('finds the round\'s block when thinking puts the turn inside a thinking block', async () => {
    const thinking: NormalizedRequest = { ...REQUEST, config: { ...REQUEST.config, maxTokens: 4000, thinking: { enabled: true, budgetTokens: 2048 } } };
    const { response } = await runTurn(
      [
        { text: `zz pondering one\n</thinking>\n${CALL_XML}`, ...CALL },
        { text: 'zz pondering two\n</thinking>\nzz final answer', stopReason: 'end_turn' },
      ],
      (_round, ids) => [imageResult(ids[0]!)],
      thinking,
    );
    const [shot] = toolResults(response.content);
    expect(shot!.rawXmlImagesAt).toBe(shot!.rawXml!.indexOf('\n</stdout>'));
    expect(JSON.stringify(shot!.content)).toContain(ZZ_RED);
  });

  it('keeps the image through streamYielding, as stream() does', async () => {
    const { content, toolResults: results, aborted } = await runTurnYielding(
      [{ text: `zz preamble one\n${CALL_XML}`, ...CALL }, { text: 'zz final answer', stopReason: 'end_turn' }],
      (_round, ids) => [imageResult(ids[0]!)],
    );
    expect(aborted).toBe(false);
    const [shot] = toolResults(content);
    expect(shot!.rawXmlImagesAt).toBe(shot!.rawXml!.indexOf('\n</stdout>'));
    expect(JSON.stringify(shot!.content)).toContain(ZZ_RED);
    expect(JSON.stringify(results)).toContain(ZZ_RED);
  });

  it("keeps the image at its own index of the response's tool results when an earlier round's result comes first", async () => {
    const { response } = await runTurn(
      [{ text: `zz preamble one\n${CALL_XML}`, ...CALL }, { text: `zz preamble two\n${CALL_XML}`, ...CALL }, { text: 'zz final answer', stopReason: 'end_turn' }],
      (round, ids) => (round === 0 ? [textResult(ids[0]!)] : [imageResult(ids[0]!)]),
    );
    expect(response.toolResults).toHaveLength(2);
    expect(response.toolResults[0]!.content).toBe('zz plain ok');
    expect(JSON.stringify(response.toolResults[1]!.content)).toContain(ZZ_RED);
    expect(response.toolResults[1]!.content).toEqual(toolResults(response.content)[1]!.content);
  });

  it('gives a round nothing, and no other result its image, when an unclosed opener earlier in the turn joins its block to the text before it', async () => {
    const { response } = await runTurn(
      [{ text: `zz the tag <function_results> opens a results block\n${CALL_XML}`, ...CALL }, { text: 'zz final answer', stopReason: 'end_turn' }],
      (_round, ids) => [imageResult(ids[0]!)],
    );
    // The parse reads one results block from the prose's opener through the round's close, as it always has.
    expect(JSON.stringify(response.content)).not.toContain(ZZ_RED);
    expect(JSON.stringify(response.toolResults)).not.toContain(ZZ_RED);
    expect(toolResults(response.content).some((b) => b.rawXmlImagesAt !== undefined)).toBe(false);
  });

  it("gives a round nothing when the parse lists fewer of its results than it wrote", () => {
    const xml = blockOf('zz shot ok');
    // The round wrote three results, the image on the second; the parse lists two, the first lost.
    // Paired in order, the third would take the image.
    const shot: ToolResultContent = { type: 'tool_result', toolUseId: 'zz-p1', content: 'zz shot ok', rawXml: xml };
    const after: ToolResultContent = { type: 'tool_result', toolUseId: 'zz-p2', content: 'zz plain ok', rawXml: xml };
    const parsed = {
      blocks: [shot as ContentBlock, after as ContentBlock],
      toolResults: [{ toolUseId: 'zz-p1', content: 'zz shot ok' }, { toolUseId: 'zz-p2', content: 'zz plain ok' }],
      resultSpans: [{ at: 7, block: 0, result: 0, count: 2 }],
    };
    const round = { xml, docAt: 7, at: 10, imageResult: 1, results: [textResult('zz1'), imageResult('zz2'), textResult('zz3')] };
    const attached = attachSplitResults(parsed, [round]);
    expect(attached.blocks).toBe(parsed.blocks);
    expect(attached.toolResults).toBe(parsed.toolResults);
  });

  it('gives a round nothing when the block where it wrote its own holds other text', () => {
    const block: ToolResultContent = { type: 'tool_result', toolUseId: 'zz1', content: 'zz other', rawXml: blockOf('zz other') };
    const parsed = {
      blocks: [block as ContentBlock],
      toolResults: [{ toolUseId: 'zz1', content: 'zz other' }],
      resultSpans: [{ at: 7, block: 0, result: 0, count: 1 }],
    };
    const round = { xml: blockOf('zz shot ok'), docAt: 7, at: 10, imageResult: 0, results: [imageResult('zz1')] };
    const attached = attachSplitResults(parsed, [round]);
    expect(attached.blocks).toBe(parsed.blocks);
    expect(attached.toolResults).toBe(parsed.toolResults);
  });

  it('keeps the image in the partial content of a turn aborted after the split round, on both loops', async () => {
    const script: ScriptedRound[] = [{ text: `zz preamble one\n${CALL_XML}`, ...CALL }, { text: '', stopReason: 'end_turn', abort: true }];
    const response = await new Membrane(new RecordingXmlAdapter(script)).stream(REQUEST, {
      onToolCalls: async (calls) => [imageResult(calls[0]!.id)],
    });
    expect('aborted' in response).toBe(true);
    const partial = (response as { partialContent?: ContentBlock[] }).partialContent ?? [];
    const yielded = await runTurnYielding(script, (_round, ids) => [imageResult(ids[0]!)]);
    expect(yielded.aborted).toBe(true);
    for (const content of [partial, yielded.content]) {
      const [shot] = toolResults(content);
      expect(shot!.rawXmlImagesAt).toBe(shot!.rawXml!.indexOf('\n</stdout>'));
      expect(JSON.stringify(shot!.content)).toContain(ZZ_RED);
    }
  });
});

describe('the XML replay of a split image round', () => {
  it('sends the block split where the turn split it, with its image, and counts it carried', async () => {
    const { response } = await runTurn(
      [{ text: `zz preamble one\n${CALL_XML}`, ...CALL }, { text: 'zz final answer', stopReason: 'end_turn' }],
      (_round, ids) => [imageResult(ids[0]!)],
    );
    const { request, rounds } = await replay(response.content);
    expect(census(request)).toEqual(['user:text', 'assistant:text', 'user:[image]', 'assistant:text']);
    const messages = request.messages as Array<{ role: string; content: unknown }>;
    expect((messages[1]!.content as string).endsWith('zz shot ok')).toBe(true);
    expect(JSON.stringify(messages[2]!.content)).toContain(ZZ_RED);
    expect((messages[3]!.content as string).startsWith('\n</stdout>')).toBe(true);
    expect(rounds.map((r) => [r.altered.messages, r.fidelity])).toEqual([[[], 'established']]);
  });

  it("sends a marked result's images as the live split chose them: media in MCP's form converted, and none it couldn't send", async () => {
    // Beside its text, the tool returns an image in MCP's form, which converts
    // and is sent; one in MCP's form with no mimeType, which can't convert; a
    // base64 source with no data, and one whose data is empty; a URL image;
    // and a URL source that also carries data, which isn't base64 data either.
    // The response keeps them as returned.
    const { adapter, response } = await runTurn(
      [{ text: `zz preamble one\n${CALL_XML}`, ...CALL }, { text: 'zz final answer', stopReason: 'end_turn' }],
      (_round, ids) => [{ toolUseId: ids[0]!, toolName: 'zz_shot', content: [
        { type: 'text', text: 'zz shot ok' },
        { type: 'image', data: ZZ_RED, mimeType: 'image/png' },
        { type: 'image', data: ZZ_BLUE },
        { type: 'image', source: { type: 'base64', mediaType: 'image/png' } },
        { type: 'image', source: { type: 'base64', data: '', mediaType: 'image/png' } },
        { type: 'image', source: { type: 'url', url: 'https://example.com/zz.png' } },
        { type: 'image', source: { type: 'url', url: 'https://example.com/zz.png', data: ZZ_BLUE } },
      ] as unknown as ToolResultContentBlock[] }],
    );
    const sent = (request: ProviderRequest) => (request.messages as Array<{ content: unknown }>)
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []) as Array<{ type?: string; source?: { data?: unknown } }>)
      .filter((b) => b.type === 'image')
      .map((b) => b.source?.data);
    expect(sent(adapter.requests[1]!)).toEqual([ZZ_RED]);
    const { request } = await replay(response.content);
    expect(census(request)).toEqual(['user:text', 'assistant:text', 'user:[image]', 'assistant:text']);
    expect(sent(request)).toEqual([ZZ_RED]);
  });

  it('replays two image rounds of one turn, each split where it was sent', async () => {
    const { response } = await runTurn(
      [{ text: `zz preamble one\n${CALL_XML}`, ...CALL }, { text: `zz preamble two\n${CALL_XML}`, ...CALL }, { text: 'zz final answer', stopReason: 'end_turn' }],
      (round, ids) => [round === 0 ? imageResult(ids[0]!) : imageResult(ids[0]!, ZZ_BLUE, 'zz second shot')],
    );
    const { request } = await replay(response.content);
    expect(census(request)).toEqual(['user:text', 'assistant:text', 'user:[image]', 'assistant:text', 'user:[image]', 'assistant:text']);
    const messages = request.messages as Array<{ role: string; content: unknown }>;
    expect(JSON.stringify(messages[2]!.content)).toContain(ZZ_RED);
    expect(JSON.stringify(messages[4]!.content)).toContain(ZZ_BLUE);
    expect((messages[3]!.content as string)).toContain('zz preamble two');
  });

  it('ends the assistant part without whitespace when the result\'s text ends in it, as the live split does', async () => {
    const { response } = await runTurn(
      [{ text: `zz preamble one\n${CALL_XML}`, ...CALL }, { text: 'zz final answer', stopReason: 'end_turn' }],
      (_round, ids) => [imageResult(ids[0]!, ZZ_RED, 'zz shot ok   ')],
    );
    const { request } = await replay(response.content);
    expect(census(request)).toEqual(['user:text', 'assistant:text', 'user:[image]', 'assistant:text']);
    const messages = request.messages as Array<{ role: string; content: unknown }>;
    expect((messages[1]!.content as string).endsWith('zz shot ok')).toBe(true);
  });

  it('splits a block replayed from a message of tool results alone, unlabeled, as the turn sent it', async () => {
    const { response } = await runTurn(
      [{ text: `zz preamble one\n${CALL_XML}`, ...CALL }, { text: 'zz final answer', stopReason: 'end_turn' }],
      (_round, ids) => [imageResult(ids[0]!)],
    );
    const results = response.content.filter((b) => b.type === 'tool_result');
    const rest = response.content.filter((b) => b.type !== 'tool_result');
    const call = rest.slice(0, rest.findIndex((b) => b.type === 'tool_use') + 1);
    const after = rest.slice(call.length);
    const { request } = await replayMessages([
      { participant: 'Claude', content: call },
      { participant: 'Tools', content: results },
      { participant: 'Claude', content: after },
    ]);
    expect(census(request)).toEqual(['user:text', 'assistant:text', 'user:[image]', 'assistant:text']);
    const messages = request.messages as Array<{ role: string; content: unknown }>;
    expect((messages[1]!.content as string).endsWith('zz shot ok')).toBe(true);
    expect(messages[1]!.content as string).not.toContain('Tools:');
    expect(JSON.stringify(messages[2]!.content)).toContain(ZZ_RED);
    expect((messages[3]!.content as string).startsWith('\n</stdout>')).toBe(true);
  });

  it("splits a block in the assistant's message that continues after injected results", async () => {
    const { response } = await runTurn(
      [{ text: `zz preamble one\n${CALL_XML}`, ...CALL }, { text: `zz preamble two\n${CALL_XML}`, ...CALL }, { text: 'zz final answer', stopReason: 'end_turn' }],
      (round, ids) => (round === 0 ? [textResult(ids[0]!)] : [imageResult(ids[0]!)]),
    );
    const first = response.content.findIndex((b) => b.type === 'tool_result');
    const { request } = await replayMessages([
      { participant: 'Claude', content: response.content.slice(0, first) },
      { participant: 'Tools', content: [response.content[first]!] },
      { participant: 'Claude', content: response.content.slice(first + 1) },
    ]);
    expect(census(request)).toEqual(['user:text', 'assistant:text', 'user:[image]', 'assistant:text']);
    const messages = request.messages as Array<{ role: string; content: unknown }>;
    expect((messages[1]!.content as string).endsWith('zz shot ok')).toBe(true);
    expect(messages[1]!.content as string).not.toContain('Claude: zz preamble two');
    expect(JSON.stringify(messages[2]!.content)).toContain(ZZ_RED);
  });

  it('puts the split images where the block split when the message also carries an image of its own', async () => {
    const { response } = await runTurn(
      [{ text: `zz preamble one\n${CALL_XML}`, ...CALL }, { text: 'zz final answer', stopReason: 'end_turn' }],
      (_round, ids) => [imageResult(ids[0]!)],
    );
    const own: ContentBlock = { type: 'image', source: { type: 'base64', data: ZZ_BLUE, mediaType: 'image/png' } };
    const { request } = await replay([...response.content, own]);
    const turn = (request.messages as Array<{ role: string; content: unknown }>).find(
      (m) => Array.isArray(m.content) && JSON.stringify(m.content).includes(ZZ_RED),
    )!;
    expect(turn.role).toBe('user');
    const parts = turn.content as Array<{ type: string; text?: string; source?: { data?: string } }>;
    expect(parts.map((b) => b.type)).toEqual(['text', 'image', 'text', 'image']);
    expect(parts[0]!.text!.endsWith('zz shot ok')).toBe(true);
    expect(parts[1]!.source!.data).toBe(ZZ_RED);
    expect(parts[2]!.text!.startsWith('\n</stdout>')).toBe(true);
    expect(parts[3]!.source!.data).toBe(ZZ_BLUE);
  });

  it('sends the raw text whole when the mark no longer falls where the result closes', async () => {
    const { response } = await runTurn(
      [{ text: `zz preamble one\n${CALL_XML}`, ...CALL }, { text: 'zz final answer', stopReason: 'end_turn' }],
      (_round, ids) => [imageResult(ids[0]!)],
    );
    // A consumer rewrote the raw text and kept the mark: it no longer points at the result's close.
    const shifted = response.content.map((b) => b.type === 'tool_result' && b.rawXmlImagesAt !== undefined
      ? { ...b, rawXmlImagesAt: b.rawXmlImagesAt - 3 }
      : b);
    const { request, rounds } = await replay(shifted);
    expect(census(request)).toEqual(['user:text', 'assistant:text']);
    expect(JSON.stringify(request.messages)).not.toContain(ZZ_RED);
    // The result still holds the image the turn sent, and this request doesn't: the message is altered.
    expect(rounds.map((r) => r.altered.messages)).toEqual([[1]]);
  });

  it('sends the raw text whole when the marked result no longer holds an image', async () => {
    const { response } = await runTurn(
      [{ text: `zz preamble one\n${CALL_XML}`, ...CALL }, { text: 'zz final answer', stopReason: 'end_turn' }],
      (_round, ids) => [imageResult(ids[0]!)],
    );
    // A consumer replaced the image and kept the raw forms: the raw text goes as it is.
    const edited = response.content.map((b) => b.type === 'tool_result'
      ? { ...b, content: [{ type: 'text' as const, text: 'zz shot ok' }] }
      : b);
    const { request, rounds } = await replay(edited);
    expect(census(request)).toEqual(['user:text', 'assistant:text']);
    expect(JSON.stringify(request.messages)).not.toContain(ZZ_RED);
    // Nothing the message holds is left out: the raw text is what it carries.
    expect(rounds.map((r) => r.altered.messages)).toEqual([[]]);
  });

  it('replays two rounds with the same text, stored next to each other, each with its own image', async () => {
    const { response } = await runTurn(
      [{ text: `zz preamble one\n${CALL_XML}`, ...CALL }, { text: `zz preamble two\n${CALL_XML}`, ...CALL }, { text: 'zz final answer', stopReason: 'end_turn' }],
      (round, ids) => [imageResult(ids[0]!, round === 0 ? ZZ_RED : ZZ_BLUE)],
    );
    // A consumer that keeps a turn's results apart from its text stores both rounds' results in one message.
    const results = response.content.filter((b) => b.type === 'tool_result');
    const rest = response.content.filter((b) => b.type !== 'tool_result');
    const lastCall = rest.map((b) => b.type).lastIndexOf('tool_use');
    const { request } = await replayMessages([
      { participant: 'Claude', content: rest.slice(0, lastCall + 1) },
      { participant: 'Tools', content: results },
      { participant: 'Claude', content: rest.slice(lastCall + 1) },
    ]);
    const wire = JSON.stringify(request.messages);
    expect(wire.split(ZZ_RED).length - 1).toBe(1);
    expect(wire.split(ZZ_BLUE).length - 1).toBe(1);
    const imageTurns = (request.messages as Array<{ role: string; content: unknown }>)
      .filter((m) => Array.isArray(m.content) && JSON.stringify(m.content).includes('"image"'));
    expect(imageTurns).toHaveLength(2);
    expect(JSON.stringify(imageTurns[0]!.content)).toContain(ZZ_RED);
    expect(JSON.stringify(imageTurns[1]!.content)).toContain(ZZ_BLUE);
    // Each round's image goes after its own block's text: one block's text
    // before the first image, both blocks' before the second.
    const textsBefore = (data: string) => wire.slice(0, wire.indexOf(data)).split('zz shot ok').length - 1;
    expect(textsBefore(ZZ_RED)).toBe(1);
    expect(textsBefore(ZZ_BLUE)).toBe(2);
  });

  /** A turn's text, its calls, then every round's results in one message of their own, as a consumer that keeps results apart stores them. */
  function storedApart(content: ContentBlock[]): NormalizedRequest['messages'] {
    const results = content.filter((b) => b.type === 'tool_result');
    const rest = content.filter((b) => b.type !== 'tool_result');
    const lastCall = rest.map((b) => b.type).lastIndexOf('tool_use');
    return [
      { participant: 'Claude', content: rest.slice(0, lastCall + 1) },
      { participant: 'Tools', content: results },
      { participant: 'Claude', content: rest.slice(lastCall + 1) },
    ];
  }

  it('replays two rounds with the same text and no image, stored beside each other, as two blocks', async () => {
    const { response } = await runTurn(
      [{ text: `zz preamble one\n${CALL_XML}`, ...CALL }, { text: `zz preamble two\n${CALL_XML}`, ...CALL }, { text: 'zz final answer', stopReason: 'end_turn' }],
      (_round, ids) => [textResult(ids[0]!)],
    );
    const results = toolResults(response.content);
    expect(results).toHaveLength(2);
    expect(results[0]!.rawXml).toBe(results[1]!.rawXml);
    const { request } = await replayMessages(storedApart(response.content));
    expect(JSON.stringify(request.messages).split('zz plain ok').length - 1).toBe(2);
  });

  it('replays an unmarked round beside a marked one with the same text as two blocks', async () => {
    const { response } = await runTurn(
      [{ text: `zz preamble one\n${CALL_XML}`, ...CALL }, { text: `zz preamble two\n${CALL_XML}`, ...CALL }, { text: 'zz final answer', stopReason: 'end_turn' }],
      (round, ids) => [round === 0 ? textResult(ids[0]!, 'zz shot ok') : imageResult(ids[0]!)],
    );
    const results = toolResults(response.content);
    expect(results[0]!.rawXml).toBe(results[1]!.rawXml);
    expect(results.map((r) => typeof r.rawXmlImagesAt === 'number')).toEqual([false, true]);
    const { request } = await replayMessages(storedApart(response.content));
    const wire = JSON.stringify(request.messages);
    expect(wire.split('zz shot ok').length - 1).toBe(2);
    expect(wire.split(ZZ_RED).length - 1).toBe(1);
  });

  it('replays a block of two results beside its twin from the next round as two blocks, and their calls too', async () => {
    const twoCalls = `${CALL_XML}\n<invoke name="zz_shot">\n<parameter name="fld1">ite2</parameter>\n</invoke>`;
    const { response } = await runTurn(
      [{ text: `zz preamble one\n${twoCalls}`, ...CALL }, { text: `zz preamble two\n${twoCalls}`, ...CALL }, { text: 'zz final answer', stopReason: 'end_turn' }],
      (_round, ids) => [textResult(ids[0]!), textResult(ids[1]!, 'zz second ok')],
    );
    const results = toolResults(response.content);
    expect(results).toHaveLength(4);
    expect(new Set(results.map((r) => r.rawXml)).size).toBe(1);
    const calls = response.content.filter((b) => b.type === 'tool_use');
    expect(new Set(calls.map((b) => (b as { rawXml?: string }).rawXml)).size).toBe(1);
    // Both rounds' calls stored side by side, then both rounds' results.
    const { request } = await replayMessages([
      { participant: 'Claude', content: calls },
      { participant: 'Tools', content: results },
      { participant: 'Claude', content: [{ type: 'text', text: 'zz final answer' }] },
    ]);
    const wire = JSON.stringify(request.messages);
    expect(wire.split('zz plain ok').length - 1).toBe(2);
    expect(wire.split('zz second ok').length - 1).toBe(2);
    expect(wire.split('ite2').length - 1).toBe(2);
  });

  it('replays three rounds with the same text, stored side by side, as three blocks, results and calls alike', async () => {
    const { response } = await runTurn(
      [
        { text: `zz preamble one\n${CALL_XML}`, ...CALL },
        { text: `zz preamble two\n${CALL_XML}`, ...CALL },
        { text: `zz preamble three\n${CALL_XML}`, ...CALL },
        { text: 'zz final answer', stopReason: 'end_turn' },
      ],
      (_round, ids) => [textResult(ids[0]!)],
    );
    const results = toolResults(response.content);
    const calls = response.content.filter((b) => b.type === 'tool_use');
    expect(new Set(results.map((r) => r.rawXml)).size, 'the premise: one text for the three rounds\' results').toBe(1);
    expect(new Set(calls.map((b) => (b as { rawXml?: string }).rawXml)).size, 'and one for their calls').toBe(1);
    const { request } = await replayMessages([
      { participant: 'Claude', content: calls },
      { participant: 'Tools', content: results },
      { participant: 'Claude', content: [{ type: 'text', text: 'zz final answer' }] },
    ]);
    const wire = JSON.stringify(request.messages);
    expect(wire.split('zz plain ok').length - 1).toBe(3);
    expect(wire.split('ite1').length - 1).toBe(3);
  });

  it('replays a round of two results whose second carries the image beside its twin, each round split at its own marked result', async () => {
    const twoCalls = `${CALL_XML}\n<invoke name="zz_shot">\n<parameter name="fld1">ite2</parameter>\n</invoke>`;
    const { response } = await runTurn(
      [{ text: `zz preamble one\n${twoCalls}`, ...CALL }, { text: `zz preamble two\n${twoCalls}`, ...CALL }, { text: 'zz final answer', stopReason: 'end_turn' }],
      (round, ids) => [textResult(ids[0]!), imageResult(ids[1]!, round === 0 ? ZZ_RED : ZZ_BLUE)],
    );
    const results = toolResults(response.content);
    expect(results.map((r) => typeof r.rawXmlImagesAt === 'number'), 'the premise: each round marked its second result').toEqual([false, true, false, true]);
    expect(new Set(results.map((r) => r.rawXml)).size, 'with one text for both rounds').toBe(1);
    const { request } = await replayMessages(storedApart(response.content));
    const wire = JSON.stringify(request.messages);
    expect(wire.split(ZZ_RED).length - 1).toBe(1);
    expect(wire.split(ZZ_BLUE).length - 1).toBe(1);
    expect(wire.indexOf(ZZ_RED)).toBeLessThan(wire.indexOf(ZZ_BLUE));
  });

  it('replays two marked rounds whose text the parser reads nothing from as two blocks, each with its own image', async () => {
    const raw = 'zz RAW-RESULT\n</stdout>\nzz RAW-TAIL';
    expect(parseAccumulatedIntoBlocks(raw).toolResults, 'the premise: the parser reads no result from the text').toHaveLength(0);
    const at = raw.indexOf('\n</stdout>');
    const result = (id: string, data: string) => ({
      type: 'tool_result',
      toolUseId: id,
      rawXml: raw,
      rawXmlImagesAt: at,
      content: [{ type: 'text', text: 'zz shot ok' }, { type: 'image', source: { type: 'base64', data, mediaType: 'image/png' } }],
    }) as ContentBlock;
    const call = (id: string) => ({ type: 'tool_use', id, name: 'zz_shot', input: {}, rawXml: 'zz RAW-CALL' }) as ContentBlock;
    const { request } = await replayMessages([
      { participant: 'Claude', content: [call('zz-a'), call('zz-b')] },
      { participant: 'Tools', content: [result('zz-a', ZZ_RED), result('zz-b', ZZ_BLUE)] },
      { participant: 'Claude', content: [{ type: 'text', text: 'zz final answer' }] },
    ]);
    const wire = JSON.stringify(request.messages);
    expect(wire.split(ZZ_RED).length - 1).toBe(1);
    expect(wire.split(ZZ_BLUE).length - 1).toBe(1);
    expect(wire.split('zz RAW-TAIL').length - 1).toBe(2);
  });

  it('reports the message altered when a marked result\'s image is one the split can\'t send, and warns of nothing', async () => {
    const { response } = await runTurn(
      [{ text: `zz preamble one\n${CALL_XML}`, ...CALL }, { text: 'zz final answer', stopReason: 'end_turn' }],
      (_round, ids) => [imageResult(ids[0]!)],
    );
    const withImage = (image: Record<string, unknown>) => response.content.map((b) => b.type === 'tool_result'
      ? { ...b, content: [{ type: 'text' as const, text: 'zz shot ok' }, image as unknown as ToolResultContentBlock] }
      : b);
    for (const [label, image] of [
      ['a url source', { type: 'image', source: { type: 'url', url: 'https://zz.example/shot.png' } }],
      ['a refused media type', { type: 'image', source: { type: 'base64', data: 'Qk0zz', mediaType: 'image/bmp' } }],
    ] as const) {
      const warned: string[] = [];
      const original = console.warn;
      console.warn = (...args: unknown[]) => { warned.push(String(args[0])); };
      try {
        const { request, rounds } = await replay(withImage(image));
        expect(census(request), label).toEqual(['user:text', 'assistant:text']);
        expect(rounds.map((r) => r.altered.messages), label).toEqual([[1]]);
      } finally {
        console.warn = original;
      }
      expect(warned.filter((w) => w.includes('image block stripped')), label).toEqual([]);
    }
  });

  it('splits a marked result holding an accepted and a refused image with the accepted one, and reports nothing altered', async () => {
    const { response } = await runTurn(
      [{ text: `zz preamble one\n${CALL_XML}`, ...CALL }, { text: 'zz final answer', stopReason: 'end_turn' }],
      (_round, ids) => [{
        toolUseId: ids[0]!,
        toolName: 'zz_shot',
        content: [
          { type: 'text', text: 'zz shot ok' },
          { type: 'image', source: { type: 'base64', data: ZZ_RED, mediaType: 'image/png' } },
          { type: 'image', source: { type: 'base64', data: 'Qk0zz', mediaType: 'image/bmp' } },
        ],
      }],
    );
    expect(toolResults(response.content).filter((b) => typeof b.rawXmlImagesAt === 'number'), 'the premise: the round split and marked its result').toHaveLength(1);
    const { request, rounds } = await replay(response.content);
    const imageTurns = (request.messages as Array<{ content: unknown }>).filter((m) => JSON.stringify(m.content).includes('"image"'));
    expect(imageTurns).toHaveLength(1);
    expect(JSON.stringify(imageTurns[0]!.content)).toContain(ZZ_RED);
    expect(JSON.stringify(request.messages)).not.toContain('Qk0zz');
    // The turn wrote the refused image's note into the text before the split, and the raw text carries it.
    expect(JSON.stringify(request.messages)).toContain('image/bmp');
    expect(rounds.map((r) => r.altered.messages)).toEqual([[]]);
  });

  it('sends a raw text the parser reads nothing from once for its whole run, results and calls alike', async () => {
    const call = (id: string) => ({ type: 'tool_use', id, name: 'zz_shot', input: {}, rawXml: 'zz RAW-CALL' }) as ContentBlock;
    const result = (id: string) => ({ type: 'tool_result', toolUseId: id, content: 'zz plain ok', rawXml: 'zz RAW-RESULT' }) as ContentBlock;
    const { request } = await replayMessages([
      { participant: 'Claude', content: [call('zz-a'), call('zz-b')] },
      { participant: 'Tools', content: [result('zz-a'), result('zz-b')] },
      { participant: 'Claude', content: [{ type: 'text', text: 'zz final answer' }] },
    ]);
    const wire = JSON.stringify(request.messages);
    expect(wire.split('zz RAW-RESULT').length - 1).toBe(1);
    expect(wire.split('zz RAW-CALL').length - 1).toBe(1);
  });

  it('sends the raw text whole for a mark before the block\'s start', async () => {
    const { response } = await runTurn(
      [{ text: `zz preamble one\n${CALL_XML}`, ...CALL }, { text: 'zz final answer', stopReason: 'end_turn' }],
      (_round, ids) => [imageResult(ids[0]!)],
    );
    // The same place counted from the end, which slice() would read as the split.
    const negative = response.content.map((b) => b.type === 'tool_result' && b.rawXmlImagesAt !== undefined
      ? { ...b, rawXmlImagesAt: b.rawXmlImagesAt - b.rawXml!.length }
      : b);
    expect(toolResults(negative).some((b) => (b.rawXmlImagesAt ?? 0) < 0)).toBe(true);
    const { request, rounds } = await replay(negative);
    expect(census(request)).toEqual(['user:text', 'assistant:text']);
    expect(rounds.map((r) => r.altered.messages)).toEqual([[1]]);
  });
});

describe('a round whose every image is of a media type the API refuses', () => {
  const bmpResult = (toolUseId: string): ToolResult => ({
    toolUseId,
    toolName: 'zz_shot',
    content: [
      { type: 'text', text: 'zz shot ok' },
      { type: 'image', source: { type: 'base64', data: 'Qk0zzzz', mediaType: 'image/bmp' } },
    ],
  });
  const SCRIPT: ScriptedRound[] = [{ text: `zz preamble one\n${CALL_XML}`, ...CALL }, { text: 'zz final answer', stopReason: 'end_turn' }];

  it('goes in as text with the note where the image was, not as an empty user turn: stream()', async () => {
    const { adapter, response } = await runTurn(SCRIPT, (_round, ids) => [bmpResult(ids[0]!)]);
    const continuation = adapter.requests[1]!;
    expect(census(continuation)).toEqual(['user:text', 'assistant:text']);
    expect(JSON.stringify(continuation.messages)).toContain('media type \\"image/bmp\\" is not accepted');
    expect(toolResults(response.content).some((b) => b.rawXmlImagesAt !== undefined)).toBe(false);
  });

  it('the same through streamYielding', async () => {
    const adapter = new RecordingXmlAdapter(SCRIPT);
    const stream = new Membrane(adapter).streamYielding(REQUEST, {});
    for await (const event of stream) {
      if (event.type === 'tool-calls') stream.provideToolResults([bmpResult(event.calls[0]!.id)]);
    }
    const continuation = adapter.requests[1]!;
    expect(census(continuation)).toEqual(['user:text', 'assistant:text']);
    expect(JSON.stringify(continuation.messages)).toContain('media type \\"image/bmp\\" is not accepted');
  });
});
