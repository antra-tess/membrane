/**
 * Anthropic server-tool blocks (web search and the like) round-trip: response
 * parsing keeps each on a zero-width carrier, Membrane sends it back in its
 * place through the Anthropic adapter, and its other builds and request shapes
 * for other wires leave it out.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { AnthropicXmlFormatter } from '../../src/formatters/anthropic-xml.js';
import { CompletionsFormatter } from '../../src/formatters/completions.js';
import { OpenAIResponsesFormatter } from '../../src/formatters/openai-responses.js';
import { AnthropicAdapter, fromAnthropicContent, resetUnconvertibleBlockWarnings, toAnthropicContent } from '../../src/providers/anthropic.js';
import { BedrockAdapter } from '../../src/providers/bedrock.js';
import { GeminiAdapter, toGeminiParts } from '../../src/providers/gemini.js';
import { OpenAIAdapter, toOpenAIContent } from '../../src/providers/openai.js';
import { OpenAICompatibleAdapter, toOpenAIMessages } from '../../src/providers/openai-compatible.js';
import { OpenAICompletionsAdapter } from '../../src/providers/openai-completions.js';
import { OpenRouterAdapter, toOpenRouterMessages } from '../../src/providers/openrouter.js';
import { normalizeResponsesInput } from '../../src/providers/responses-input.js';
import { ANTHROPIC_SERVER_BLOCK_TYPES, anthropicServerBlockFor, unpairedServerBlocks } from '../../src/utils/anthropic-server-blocks.js';
import { extractText } from '../../src/types/message.js';
import { FidelityNotes } from '../../src/utils/fidelity.js';
import { resetUnconvertibleProviderItemWarnings } from '../../src/utils/usage.js';
import type { ContentBlock, NormalizedMessage, NormalizedRequest, ProviderAdapter, ProviderRequest } from '../../src/types/index.js';

// A web-search turn in the order the API returned one: signed thinking, the
// search call and its results, more signed thinking, then the answer.
const thinking1 = { type: 'thinking', thinking: '', signature: 'zz-sig-1' };
const serverUse = { type: 'server_tool_use', id: 'srvtoolu_zz1', name: 'web_search', input: { query: 'zz latest release' } };
const searchResult = {
  type: 'web_search_tool_result',
  tool_use_id: 'srvtoolu_zz1',
  caller: { type: 'direct' },
  content: [{ type: 'web_search_result', title: 'zz release', url: 'https://zz.example/', encrypted_content: 'zz-enc', page_age: null }],
};
const thinking2 = { type: 'thinking', thinking: '', signature: 'zz-sig-2' };
const answer = { type: 'text', text: 'zz answer' };

const carrier = (item: unknown, extra: Record<string, unknown> = {}): ContentBlock =>
  ({ type: 'text', text: '', rawItem: item, ...extra }) as ContentBlock;
/** A carrier holding another wire's item: an opaque Responses reasoning item. */
const responsesCarrier = carrier({ type: 'reasoning', id: 'rs_zz1', summary: [], encrypted_content: 'zz-rs' });

const turn = (): ContentBlock[] => [
  thinking1 as ContentBlock, carrier(serverUse), carrier(searchResult), thinking2 as ContentBlock, answer as ContentBlock,
];
/** The turn as Anthropic-shaped requests send it back. */
const sentTurn = [thinking1, serverUse, searchResult, thinking2, answer];

const history = (assistant: ContentBlock[] = turn()): NormalizedMessage[] => [
  { participant: 'User', content: [{ type: 'text', text: 'zz what is the latest release?' }] },
  { participant: 'Claude', content: assistant },
  { participant: 'User', content: [{ type: 'text', text: 'zz thanks' }] },
];
const options = { participantMode: 'simple' as const, assistantParticipant: 'Claude', humanParticipant: 'User', anthropicServerBlocks: true };

/** Every object in `value` whose `type` is one of the listed server block types. */
function serverBlocksIn(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(serverBlocksIn);
  if (!value || typeof value !== 'object') return [];
  const own = ANTHROPIC_SERVER_BLOCK_TYPES.has((value as { type?: string }).type ?? '') ? [value] : [];
  return [...own, ...Object.values(value).flatMap(serverBlocksIn)];
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('anthropicServerBlockFor', () => {
  it('holds exactly these types: a change to the list is a change to this test', () => {
    expect([...ANTHROPIC_SERVER_BLOCK_TYPES].sort()).toEqual([
      'bash_code_execution_tool_result',
      'code_execution_tool_result',
      'container_upload',
      'mcp_tool_result',
      'mcp_tool_use',
      'server_tool_use',
      'text_editor_code_execution_tool_result',
      'tool_search_tool_result',
      'web_fetch_tool_result',
      'web_search_tool_result',
    ]);
  });

  it.each([...ANTHROPIC_SERVER_BLOCK_TYPES])('gives back a carrier\'s %s block as a copy', (type) => {
    const raw = { type, zz: 'field' };
    const sent = anthropicServerBlockFor(carrier(raw));
    expect(sent).toEqual(raw);
    expect(sent).not.toBe(raw);
  });

  it('sends no cache marker stored on the carrier or on the block', () => {
    const stored = { ...searchResult, cache_control: { type: 'ephemeral' } };
    const marked = carrier(stored, { cache_control: { type: 'ephemeral', ttl: '1h' } });
    const before = structuredClone(marked);
    expect(anthropicServerBlockFor(marked)).toEqual(searchResult);
    expect(marked).toEqual(before);
  });

  it('gives back a server block given as itself, as a copy', () => {
    const sent = anthropicServerBlockFor(serverUse);
    expect(sent).toEqual(serverUse);
    expect(sent).not.toBe(serverUse);
  });

  it.each([
    ['a carrier holding another wire\'s item', responsesCarrier],
    ['text that holds a raw item', { type: 'text', text: 'zz visible', rawItem: serverUse }],
    ['plain text', answer],
    ['a client tool call', { type: 'tool_use', id: 'toolu_zz1', name: 'record', input: {} }],
    ['null', null],
  ])('has nothing for %s', (_name, block) => {
    expect(anthropicServerBlockFor(block)).toBeUndefined();
  });
});

describe('NativeFormatter', () => {
  it('sends each kept server block back in its place in the turn', () => {
    const messages = history();
    const before = structuredClone(messages);
    const built = new NativeFormatter().buildMessages(messages, options);
    expect(built.messages[1]).toEqual({ role: 'assistant', content: sentTurn });
    expect(messages).toEqual(before);
  });

  it('sends server blocks stored as themselves, not on carriers, back in place between signed thinking', () => {
    // A seeded history can hold them so, as the field report's did.
    const bare = [thinking1, serverUse, searchResult, thinking2, answer] as ContentBlock[];
    const built = new NativeFormatter().buildMessages(history(bare), options);
    expect(built.messages[1]).toEqual({ role: 'assistant', content: sentTurn });
  });

  it('still leaves out a carrier holding another wire\'s item', () => {
    const built = new NativeFormatter().buildMessages(history([responsesCarrier, ...turn()]), options);
    expect(built.messages[1]!.content).toEqual(sentTurn);
  });

  it('leaves them out of another participant\'s message, which goes as a user turn', () => {
    const messages: NormalizedMessage[] = [
      { participant: 'User', content: [{ type: 'text', text: 'zz ask the other agent' }] },
      { participant: 'Other', content: turn() },
      { participant: 'User', content: [{ type: 'text', text: 'zz and you?' }] },
    ];
    const built = new NativeFormatter().buildMessages(messages, { participantMode: 'multiuser', assistantParticipant: 'Claude' });
    expect(serverBlocksIn(built.messages)).toEqual([]);
    expect(JSON.stringify(built.messages)).toContain('zz answer');
  });

  it('builds under cm-owned markers though a stored block or its carrier holds one', () => {
    const blockMarked = carrier({ ...serverUse, cache_control: { type: 'ephemeral' } });
    const carrierMarked = carrier(searchResult, { cache_control: { type: 'ephemeral' } });
    const built = new NativeFormatter().buildMessages(
      history([thinking1 as ContentBlock, blockMarked, carrierMarked, answer as ContentBlock]),
      { ...options, promptCaching: true, cacheMarkers: 'cm-owned' },
    );
    expect(built.messages[1]!.content).toEqual([thinking1, serverUse, searchResult, answer]);
  });

  it('marks a breakpoint on the sent copy, never the stored block', () => {
    const before = structuredClone(searchResult);
    const messages = history([thinking1 as ContentBlock, carrier(serverUse), carrier(searchResult)]);
    messages[1] = { ...messages[1]!, cacheBreakpoint: true };
    const built = new NativeFormatter().buildMessages(messages, { ...options, promptCaching: true });
    expect(built.messages[1]!.content).toEqual([
      thinking1, serverUse, { ...searchResult, cache_control: { type: 'ephemeral' } },
    ]);
    expect(searchResult).toEqual(before);
  });
});

describe('a server block and an image in one request', () => {
  // Real 1x1 PNG, and text bytes labelled as one, which no request can carry as an image.
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
  const NOTES = Buffer.from('notes: buy milk').toString('base64');
  const image = (data: string): ContentBlock => ({ type: 'image', source: { type: 'base64', mediaType: 'image/png', data } }) as ContentBlock;

  it('NativeFormatter sends the server blocks in their place and each image as it would alone', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const messages: NormalizedMessage[] = [
      { participant: 'User', content: [{ type: 'text', text: 'zz what is in this?' }, image(PNG)] },
      { participant: 'Claude', content: turn() },
      { participant: 'User', content: [{ type: 'text', text: 'zz and this?' }, image(NOTES)] },
    ];
    const built = new NativeFormatter().buildMessages(messages, options);
    const sent = built.messages as Array<{ role: string; content: unknown[] }>;
    expect(sent.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(sent[1]).toEqual({ role: 'assistant', content: sentTurn });
    expect(sent[0]!.content).toContainEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } });
    expect(JSON.stringify(sent[2])).not.toContain(NOTES);
    expect(JSON.stringify(sent[2])).toContain('the formats this request can carry');
    expect(serverBlocksIn([sent[0], sent[2]])).toEqual([]);
  });
});

describe('toAnthropicContent', () => {
  it('in an assistant turn, converts each carrier to its server block in place and leaves out another wire\'s item', () => {
    expect(toAnthropicContent([...turn(), responsesCarrier], { role: 'assistant' })).toEqual(sentTurn);
  });

  it('in an assistant turn, sends a server block given as itself', () => {
    expect(toAnthropicContent([serverUse as unknown as ContentBlock, searchResult as unknown as ContentBlock, answer as ContentBlock], { role: 'assistant' }))
      .toEqual([serverUse, searchResult, answer]);
  });

  it('in an assistant turn, leaves out a call with no result after it, and a result with no call before it', () => {
    expect(toAnthropicContent([serverUse as unknown as ContentBlock, answer as ContentBlock], { role: 'assistant' })).toEqual([answer]);
    expect(toAnthropicContent([searchResult as unknown as ContentBlock, answer as ContentBlock], { role: 'assistant' })).toEqual([answer]);
    expect(toAnthropicContent([carrier(serverUse), answer as ContentBlock], { role: 'assistant' })).toEqual([answer]);
  });

  it('with lastMessage, keeps a lone call, as the request\'s final message a paused turn is resumed in, and still leaves out a lone result', () => {
    expect(toAnthropicContent([serverUse as unknown as ContentBlock, answer as ContentBlock], { role: 'assistant', lastMessage: true }))
      .toEqual([serverUse, answer]);
    expect(toAnthropicContent([carrier(serverUse), answer as ContentBlock], { role: 'assistant', lastMessage: true }))
      .toEqual([serverUse, answer]);
    expect(toAnthropicContent([searchResult as unknown as ContentBlock, answer as ContentBlock], { role: 'assistant', lastMessage: true }))
      .toEqual([answer]);
  });

  it.each([[undefined], ['user' as const]])('with role %s, leaves them out, bare or on a carrier', (role) => {
    const given = role ? { role } : undefined;
    expect(toAnthropicContent([...turn(), responsesCarrier], given)).toEqual([thinking1, thinking2, answer]);
    expect(toAnthropicContent([serverUse as unknown as ContentBlock, answer as ContentBlock], given)).toEqual([answer]);
  });
});

describe('complete()', () => {
  it('keeps a turn\'s server blocks on carriers, and sends them back verbatim', async () => {
    // The warning is once per type per process: forget any an earlier test gave.
    resetUnconvertibleProviderItemWarnings();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({
        id: 'msg_zz', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
        content: bodies.length === 1 ? sentTurn : [{ type: 'text', text: 'zz ok' }],
        stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
      }), { headers: { 'content-type': 'application/json' } });
    }));
    const membrane = new Membrane(
      new AnthropicAdapter({ apiKey: 'zz-key', cacheKeepalive: { enabled: false } }),
      { formatter: new NativeFormatter() },
    );
    const config = { model: 'claude-sonnet-4-6', maxTokens: 32 };
    const question = history()[0]!;
    const first = await membrane.complete({ messages: [question], assistantParticipant: 'Claude', config });
    expect(first.content).toEqual([thinking1, carrier(serverUse), carrier(searchResult), thinking2, answer]);

    await membrane.complete({
      messages: [question, { participant: 'Claude', content: first.content }, history()[2]!],
      assistantParticipant: 'Claude',
      config,
    });
    expect(bodies[1].messages[1]).toEqual({ role: 'assistant', content: sentTurn });
    // A server block is its own native form, so keeping it warns of nothing.
    expect(warn.mock.calls.map((c) => String(c[0])).filter((line) => /unconvertible|no normalized/i.test(line))).toEqual([]);
  });

  it('restores an XML closing tag onto the last text block, not onto a server block carrier after it', async () => {
    const adapter: ProviderAdapter = {
      name: 'anthropic', supportsModel: () => true, replaysAnthropicServerBlocks: true,
      complete: async () => ({
        content: [{ type: 'text', text: 'zz before <zz_note>zz noted' }, serverUse],
        stopReason: 'stop_sequence',
        stopSequence: '</zz_note>',
        usage: { inputTokens: 1, outputTokens: 1 },
        raw: {},
      }) as any,
      stream: async () => { throw new Error('Unexpected stream'); },
    };
    const membrane = new Membrane(adapter, { formatter: new AnthropicXmlFormatter() });
    const res = await membrane.complete({
      messages: [history()[0]!], assistantParticipant: 'Claude', config: { model: 'claude-zz', maxTokens: 32 }, toolMode: 'xml',
    } as any);
    expect(res.content).toContainEqual(carrier(serverUse));
    const texts = res.content.filter((block) => block.type === 'text' && !('rawItem' in block)) as Array<{ text: string }>;
    expect(texts.at(-1)!.text.endsWith('</zz_note>')).toBe(true);
  });

  it('keeps a provider item with no normalized form as its native item, as the Responses adapter gives it', async () => {
    // The Responses adapter's compaction item: a normalized-looking wrapper
    // whose rawItem is the item the API sent.
    const native = { type: 'compaction', id: 'cmp_zz1', encrypted_content: 'zz-cmp' };
    const adapter: ProviderAdapter = {
      name: 'openai-responses', supportsModel: () => true,
      complete: async () => ({
        content: [
          { type: 'compaction', id: 'cmp_zz1', encryptedContent: 'zz-cmp', outputIndex: 0, rawItem: native },
          { type: 'text', text: 'zz answer' },
        ],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
        raw: {},
      }) as any,
      stream: async () => { throw new Error('Unexpected stream'); },
    };
    const membrane = new Membrane(adapter, { formatter: new OpenAIResponsesFormatter() });
    const res = await membrane.complete({
      messages: [history()[0]!], assistantParticipant: 'Claude', config: { model: 'gpt-zz', maxTokens: 32 },
    });
    expect(res.content).toEqual([carrier(native), answer]);
  });
});

describe('the native tool loop', () => {
  // One round that searched and then called a client tool, the shape whose
  // continuation the API refuses with the server blocks left out.
  const call = { type: 'tool_use', id: 'toolu_zz1', name: 'record', input: { fact: 'zz' } };
  const toolTurn = [thinking1, serverUse, searchResult, thinking2, call];

  function recordingAdapter(sent: any[], replaysAnthropicServerBlocks = true): ProviderAdapter {
    return {
      name: 'anthropic', supportsModel: () => true, replaysAnthropicServerBlocks,
      complete: async () => { throw new Error('Unexpected complete'); },
      stream: async (request) => {
        sent.push(structuredClone(request));
        const first = sent.length === 1;
        return {
          content: first ? toolTurn : [{ type: 'text', text: 'zz done' }],
          stopReason: first ? 'tool_use' : 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1 },
          raw: {},
        };
      },
    };
  }
  const request = (): NormalizedRequest => ({
    messages: [history()[0]!],
    assistantParticipant: 'Claude',
    config: { model: 'claude-sonnet-4-6', maxTokens: 32 },
    toolMode: 'native',
    tools: [{ name: 'record', description: 'Record a fact.', inputSchema: { type: 'object' } }],
  });
  const results = (calls: Array<{ id: string }>) =>
    calls.map((c) => ({ toolUseId: c.id, toolName: 'record', content: 'zz recorded' }));

  it('sends a history\'s server blocks only in the assistant\'s own turns, and marks only the copy', async () => {
    const sent: any[] = [];
    const membrane = new Membrane(recordingAdapter(sent));
    const own = [thinking1 as ContentBlock, carrier(serverUse), carrier(searchResult)];
    const messages: NormalizedMessage[] = [
      { participant: 'User', content: [{ type: 'text', text: 'zz search, and ask Other' }] },
      { participant: 'Claude', content: own, cacheBreakpoint: true },
      // Another agent's turn, without its thinking: a reasoning block in a
      // user turn is the normalizer's to re-role, which this test isn't about.
      { participant: 'Other', content: [carrier(serverUse), carrier(searchResult), answer as ContentBlock] },
      { participant: 'User', content: [{ type: 'text', text: 'zz now record it' }] },
    ];
    const before = structuredClone(messages);
    await membrane.stream({ ...request(), messages }, { onToolCalls: async (calls) => results(calls) });
    expect(sent[0].messages[1]).toEqual({
      role: 'assistant',
      content: [thinking1, serverUse, { ...searchResult, cache_control: { type: 'ephemeral' } }],
    });
    expect(serverBlocksIn(sent[0].messages.slice(2))).toEqual([]);
    expect(messages).toEqual(before);
  });

  it('sends server blocks stored as themselves back in place between signed thinking', async () => {
    const sent: any[] = [];
    const membrane = new Membrane(recordingAdapter(sent));
    const messages = history([thinking1, serverUse, searchResult, thinking2, answer] as ContentBlock[]);
    await membrane.stream({ ...request(), messages }, { onToolCalls: async (calls) => results(calls) });
    expect(sent[0].messages[1]).toEqual({ role: 'assistant', content: sentTurn });
  });

  it.each([
    ['stream', 'declared false'], ['stream', 'not declared'], ['streamYielding', 'not declared'],
  ] as const)('%s sends none through an adapter whose capability is %s', async (method, how) => {
    const sent: any[] = [];
    const adapter = recordingAdapter(sent, false);
    if (how === 'not declared') delete (adapter as { replaysAnthropicServerBlocks?: boolean }).replaysAnthropicServerBlocks;
    const membrane = new Membrane(adapter);
    if (method === 'stream') {
      await membrane.stream(request(), { onToolCalls: async (calls) => results(calls) });
    } else {
      const stream = membrane.streamYielding(request());
      for await (const event of stream) {
        if (event.type === 'error') throw event.error;
        if (event.type === 'tool-calls') stream.provideToolResults(results(event.calls));
      }
    }
    expect(sent).toHaveLength(2);
    expect(sent[1].messages[1]).toEqual({ role: 'assistant', content: [thinking1, thinking2, call] });
    expect(serverBlocksIn(sent)).toEqual([]);
  });

  it.each(['stream', 'streamYielding'] as const)('%s sends the round\'s server blocks back with its tool result', async (method) => {
    const sent: any[] = [];
    const membrane = new Membrane(recordingAdapter(sent));
    if (method === 'stream') {
      await membrane.stream(request(), { onToolCalls: async (calls) => results(calls) });
    } else {
      const stream = membrane.streamYielding(request());
      for await (const event of stream) {
        if (event.type === 'error') throw event.error;
        if (event.type === 'tool-calls') stream.provideToolResults(results(event.calls));
      }
    }
    expect(sent).toHaveLength(2);
    expect(sent[1].messages[1]).toEqual({ role: 'assistant', content: toolTurn });
    expect(sent[1].messages[2].content).toEqual([
      expect.objectContaining({ type: 'tool_result', tool_use_id: 'toolu_zz1' }),
    ]);
  });
});

describe('the Anthropic adapter\'s stream', () => {
  function fakeStream(events: unknown[]) {
    return {
      controller: { abort() { /* noop */ } },
      [Symbol.asyncIterator]() {
        let i = 0;
        return { async next() { return i < events.length ? { value: events[i++], done: false } : { value: undefined, done: true }; } };
      },
    };
  }

  it('assembles a server tool call\'s input from its input_json_delta fragments', async () => {
    const adapter = new AnthropicAdapter({ apiKey: 'zz-key', cacheKeepalive: { enabled: false } });
    (adapter as any).client = {
      messages: {
        stream: async () => fakeStream([
          { type: 'message_start', message: { model: 'claude-zz-1', usage: { input_tokens: 10 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srvtoolu_zz1', name: 'web_search', input: {} } },
          { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query": "zz lat' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'est release"}' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'content_block_start', index: 1, content_block: searchResult },
          { type: 'content_block_stop', index: 1 },
          { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'zz answer' } },
          { type: 'content_block_stop', index: 2 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
        ]),
      },
    };
    const res: any = await adapter.stream(
      { model: 'claude-zz-1', maxTokens: 64, messages: [{ role: 'user', content: [{ type: 'text', text: 'zz ask' }] }] } as any,
      { onChunk: () => {} } as any,
    );
    expect(res.content).toEqual([serverUse, searchResult, answer]);
  });

  async function streamed(events: unknown[]): Promise<any> {
    const adapter = new AnthropicAdapter({ apiKey: 'zz-key', cacheKeepalive: { enabled: false } });
    (adapter as any).client = { messages: { stream: async () => fakeStream(events) } };
    return adapter.stream(
      { model: 'claude-zz-1', maxTokens: 64, messages: [{ role: 'user', content: [{ type: 'text', text: 'zz ask' }] }] } as any,
      { onChunk: () => {} } as any,
    );
  }

  it('assembles an MCP connector call\'s input the same way', async () => {
    const res = await streamed([
      { type: 'message_start', message: { model: 'claude-zz-1', usage: { input_tokens: 10 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'mcp_tool_use', id: 'mcptoolu_zz1', name: 'zz_lookup', server_name: 'zz', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"key": ' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"zz"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
    ]);
    expect(res.content).toEqual([{ type: 'mcp_tool_use', id: 'mcptoolu_zz1', name: 'zz_lookup', server_name: 'zz', input: { key: 'zz' } }]);
  });

  for (const [label, fragment] of [['part of its input', '{"q": "zz'], ['input that happens to parse', '{"q": "zz"}']] as const) {
    it(`marks a server call cut off before its block stopped, with ${label}, and keeps the start's input, and says so`, async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const res = await streamed([
        { type: 'message_start', message: { model: 'claude-zz-1', usage: { input_tokens: 10 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'mcp_tool_use', id: 'mcptoolu_zz2', name: 'zz_lookup', server_name: 'zz', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: fragment } },
        { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 5 } },
      ]);
      // Only a block that stopped has all of its input.
      expect(res.content).toEqual([{ type: 'mcp_tool_use', id: 'mcptoolu_zz2', name: 'zz_lookup', server_name: 'zz', input: {}, unparseableInput: fragment }]);
      expect(warn.mock.calls.map((c) => String(c[0]))).toContainEqual(
        expect.stringMatching(new RegExp(`mcp_tool_use mcptoolu_zz2 was cut off before its block stopped \\(${fragment.length} characters\\); it keeps the start's input, marked$`)),
      );
    });
  }

  it('marks a server call whose fragments don\'t parse, and keeps the start\'s input, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await streamed([
      { type: 'message_start', message: { model: 'claude-zz-1', usage: { input_tokens: 10 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srvtoolu_zz1', name: 'web_search', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query": "zz lat' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 5 } },
    ]);
    expect(res.content).toEqual([{ type: 'server_tool_use', id: 'srvtoolu_zz1', name: 'web_search', input: {}, unparseableInput: '{"query": "zz lat' }]);
    expect(warn.mock.calls.map((c) => String(c[0]))).toContainEqual(
      expect.stringMatching(/server_tool_use srvtoolu_zz1 didn't parse to an object \(17 characters\); it keeps the start's input, marked$/),
    );
  });

  for (const fragment of ['null', '"zz"', '["zz"]', '5']) {
    it(`marks a stopped server call whose fragments parse to ${fragment}, which isn't an object, and says so`, async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const res = await streamed([
        { type: 'message_start', message: { model: 'claude-zz-1', usage: { input_tokens: 10 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srvtoolu_zz5', name: 'web_search', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: fragment } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
      ]);
      expect(res.content).toEqual([{ type: 'server_tool_use', id: 'srvtoolu_zz5', name: 'web_search', input: {}, unparseableInput: fragment }]);
      expect(warn.mock.calls.map((c) => String(c[0]))).toContainEqual(
        expect.stringMatching(new RegExp(`server_tool_use srvtoolu_zz5 didn't parse to an object \\(${fragment.length} characters\\); it keeps the start's input, marked$`)),
      );
    });
  }

  it('keeps a stopped server call whose fragments are only whitespace as a call with no input, unmarked', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await streamed([
      { type: 'message_start', message: { model: 'claude-zz-1', usage: { input_tokens: 10 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srvtoolu_zz6', name: 'web_search', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '  \n' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
    ]);
    expect(res.content).toEqual([{ type: 'server_tool_use', id: 'srvtoolu_zz6', name: 'web_search', input: {} }]);
    expect(warn.mock.calls.map((c) => String(c[0])).some((line) => line.includes('srvtoolu_zz6'))).toBe(false);
  });

  it('marks a server call cut off before its block stopped with no input fragments, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await streamed([
      { type: 'message_start', message: { model: 'claude-zz-1', usage: { input_tokens: 10 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srvtoolu_zz4', name: 'web_search', input: {} } },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 5 } },
    ]);
    expect(res.content).toEqual([{ type: 'server_tool_use', id: 'srvtoolu_zz4', name: 'web_search', input: {}, unparseableInput: '' }]);
    expect(warn.mock.calls.map((c) => String(c[0]))).toContainEqual(
      expect.stringMatching(/server_tool_use srvtoolu_zz4 was cut off before its block stopped \(0 characters\); it keeps the start's input, marked$/),
    );
  });

  it('keeps a server call with no input fragments, which stopped, as the call it is', async () => {
    const res = await streamed([
      { type: 'message_start', message: { model: 'claude-zz-1', usage: { input_tokens: 10 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srvtoolu_zz3', name: 'web_search', input: {} } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
    ]);
    expect(res.content).toEqual([{ type: 'server_tool_use', id: 'srvtoolu_zz3', name: 'web_search', input: {} }]);
  });
});

describe('a server call that didn\'t arrive whole', () => {
  it('goes back as stored, with the start\'s input and without the marker, beside the result that follows it', () => {
    const broken = { type: 'server_tool_use', id: 'srvtoolu_zz9', name: 'web_search', input: {}, unparseableInput: '{"query": "zz' };
    const result = { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_zz9', content: [] };
    const sent = { type: 'server_tool_use', id: 'srvtoolu_zz9', name: 'web_search', input: {} };
    expect(anthropicServerBlockFor(carrier(broken))).toEqual(sent);
    expect(anthropicServerBlockFor(broken)).toEqual(sent);
    const notes = new FidelityNotes();
    const built = new NativeFormatter().buildMessages([
      { participant: 'User', content: [{ type: 'text', text: 'zz ask' }] },
      { participant: 'Claude', content: [{ type: 'text', text: 'zz searching' }, carrier(broken), carrier(result)] },
      { participant: 'User', content: [{ type: 'text', text: 'zz go on' }] },
    ], { assistantParticipant: 'Claude', participantMode: 'multiuser', fidelity: notes, anthropicServerBlocks: true } as any);
    const assistant = JSON.stringify(built.messages[1]);
    expect(assistant).toContain('"id":"srvtoolu_zz9"');
    expect(assistant).toContain('"tool_use_id":"srvtoolu_zz9"');
    expect(assistant).not.toContain('unparseableInput');
    expect([...notes.altered]).toEqual([]);
  });
});

describe('extractText', () => {
  it('leaves a carrier out, so a turn complete() returned gains no empty lines', () => {
    const message: NormalizedMessage = {
      participant: 'Claude',
      content: [carrier(serverUse), carrier(searchResult), { type: 'text', text: 'zz one' }, { type: 'text', text: 'zz two' }],
    };
    expect(extractText(message)).toBe('zz one\nzz two');
  });

  it('still keeps an empty text block that carries nothing', () => {
    expect(extractText({ participant: 'Claude', content: [{ type: 'text', text: '' }, { type: 'text', text: 'zz one' }] })).toBe('\nzz one');
  });
});

describe('wires with no form for them', () => {
  const anthropicShaped = () => new NativeFormatter().buildMessages(history(), options).messages as any[];

  it('the Responses formatter sends no server block as an item, and still replays its own', () => {
    const built = new OpenAIResponsesFormatter().buildMessages(history([...turn(), responsesCarrier]), options);
    expect(serverBlocksIn(built.messages)).toEqual([]);
    expect(JSON.stringify(built.messages)).toContain('zz answer');
    expect(built.messages).toContainEqual(expect.objectContaining({ type: 'reasoning', id: 'rs_zz1' }));
  });

  it('the Responses formatter leaves out a server block given as itself', () => {
    const built = new OpenAIResponsesFormatter().buildMessages(
      history([serverUse as unknown as ContentBlock, answer as ContentBlock]),
      options,
    );
    expect(serverBlocksIn(built.messages)).toEqual([]);
    expect(JSON.stringify(built.messages)).toContain('zz answer');
  });

  it('the Responses input normalization leaves out their carriers, with no empty part', () => {
    const items = normalizeResponsesInput([
      { role: 'assistant', content: [carrier(serverUse), carrier(searchResult), answer] },
      { role: 'assistant', content: [carrier(serverUse), carrier(searchResult)] },
    ] as ProviderRequest['messages']);
    expect(items).toEqual([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'zz answer' }] }]);
  });

  it('the Responses input normalization leaves them out, and a message of only them', () => {
    const items = normalizeResponsesInput([
      ...anthropicShaped(),
      { role: 'assistant', content: [serverUse, searchResult] },
    ] as ProviderRequest['messages']);
    expect(serverBlocksIn(items)).toEqual([]);
    expect(JSON.stringify(items)).toContain('zz answer');
    expect(items).toHaveLength(3);
  });

  it.each([
    ['OpenAI', (m: any[]) => (new OpenAIAdapter({ apiKey: 'zz' }) as any).convertMessages(m)],
    ['OpenRouter', (m: any[]) => (new OpenRouterAdapter({ apiKey: 'zz' }) as any).convertMessages(m)],
    ['OpenAI-compatible', (m: any[]) =>
      (new OpenAICompatibleAdapter({ apiKey: 'zz', baseURL: 'http://localhost' }) as any).convertMessages(m)],
    ['Gemini', (m: any[]) => (new GeminiAdapter({ apiKey: 'zz' }) as any).convertMessages(m, 'gemini-2.5-pro')],
    ['OpenAI completions', (m: any[]) => {
      const adapter = new OpenAICompletionsAdapter({ baseURL: 'http://zz-host.invalid/v1', apiKey: 'zz' }) as any;
      return m.map((message) => adapter.extractTextContent(message.content));
    }],
  ])('the %s adapter leaves them out of what it sends', (_name, convert) => {
    const out = convert(anthropicShaped());
    expect(serverBlocksIn(out)).toEqual([]);
    expect(JSON.stringify(out)).not.toContain('srvtoolu_zz1');
    expect(JSON.stringify(out)).toContain('zz answer');
  });

  it.each([
    ['OpenAI', (m: any[]) => (new OpenAIAdapter({ apiKey: 'zz' }) as any).convertMessages(m)],
    ['OpenRouter', (m: any[]) => (new OpenRouterAdapter({ apiKey: 'zz' }) as any).convertMessages(m)],
    ['OpenAI-compatible', (m: any[]) =>
      (new OpenAICompatibleAdapter({ apiKey: 'zz', baseURL: 'http://localhost' }) as any).convertMessages(m)],
    ['Gemini', (m: any[]) => (new GeminiAdapter({ apiKey: 'zz' }) as any).convertMessages(m, 'gemini-2.5-pro')],
    ['OpenAI completions', (m: any[]) => {
      const adapter = new OpenAICompletionsAdapter({ baseURL: 'http://zz-host.invalid/v1', apiKey: 'zz' }) as any;
      return m.map((message) => adapter.extractTextContent(message.content));
    }],
    ['exported toOpenAIMessages', (m: any[]) => toOpenAIMessages(m)],
    ['exported toOpenRouterMessages', (m: any[]) => toOpenRouterMessages(m)],
    ['exported toOpenAIContent', (m: any[]) => m.map((message) => toOpenAIContent(message.content))],
  ])('the %s adapter writes a turn as if its carriers weren\'t there', (_name, convert) => {
    const ask = { role: 'user', content: [{ type: 'text', text: 'zz ask' }] };
    const withCarriers = convert([ask, { role: 'assistant', content: [carrier(serverUse), carrier(searchResult), responsesCarrier, answer] }]);
    const without = convert([ask, { role: 'assistant', content: [answer] }]);
    expect(withCarriers).toEqual(without);
  });

  it.each([
    ['XML', () => new AnthropicXmlFormatter()],
    ['completions', () => new CompletionsFormatter()],
  ] as const)('the %s formatter writes the turn as if its carriers weren\'t there', (_name, create) => {
    const withCarriers = create().buildMessages(history(), options);
    const without = create().buildMessages(history([thinking1 as ContentBlock, thinking2 as ContentBlock, answer as ContentBlock]), options);
    expect(withCarriers.messages).toEqual(without.messages);
  });

});

// A provider that doesn't take server blocks back, such as Bedrock, gets the
// request it got before they went back at all. Only the build can leave them
// out before it places cache markers and merges consecutive turns, so it does
// when told the provider doesn't take them.
describe('an adapter Membrane doesn\'t replay them through', () => {
  const T = (text: string): ContentBlock => ({ type: 'text', text });
  const U = (text: string): NormalizedMessage => ({ participant: 'User', content: [T(text)] });
  const A = (content: ContentBlock[], more: Partial<NormalizedMessage> = {}): NormalizedMessage => ({ participant: 'Claude', content, ...more });
  const C = (item: unknown) => carrier(item);
  const use2 = { ...serverUse, id: 'srvtoolu_zz2' };
  const result2 = { ...searchResult, tool_use_id: 'srvtoolu_zz2' };
  const clientCall = { type: 'tool_use', id: 'toolu_zz9', name: 'client', input: {} } as ContentBlock;
  const clientResult = { type: 'tool_result', toolUseId: 'toolu_zz9', content: 'zz ok' } as ContentBlock;
  const cases: Array<[string, NormalizedMessage[], Record<string, unknown>]> = [
    ['a turn ending in server blocks, with a breakpoint', [U('ask'), A([answer as ContentBlock, C(serverUse), C(searchResult)], { cacheBreakpoint: true }), U('next')], {}],
    ['a server-only last turn', [U('ask'), A([C(serverUse), C(searchResult)])], {}],
    ['a server-only turn in the middle', [U('ask'), A([C(serverUse), C(searchResult)]), U('next')], {}],
    ['a marker on the message after a server-only turn', [U('first'), A([T('first answer')]), U('second'), A([C(serverUse), C(searchResult)]), U('third')],
      { hasCacheMarker: (_message: NormalizedMessage, index: number) => index === 4 }],
    ['assistant shards merged after their markers', [U('ask'), A([T('before'), C(serverUse), C(searchResult)], { cacheBreakpoint: true }), A([T('after')]), U('next')], {}],
    ['shards around a client tool call', [U('ask'), A([T('before'), C(serverUse), C(searchResult)], { cacheBreakpoint: true }), A([T('after'), clientCall]),
      { participant: 'User', content: [clientResult] }, U('next')], {}],
    ['two marked shards', [U('ask'), A([T('before'), C(serverUse), C(searchResult)], { cacheBreakpoint: true }), A([T('middle'), C(use2), C(result2)], { cacheBreakpoint: true }), U('next')], {}],
    ['a breakpoint on a server-only turn, with the system fallback', [U('ask'), A([C(serverUse), C(searchResult)], { cacheBreakpoint: true }), U('next')], { systemPrompt: 'zz system' }],
  ];
  const build = (messages: NormalizedMessage[], extra: Record<string, unknown>, serverBlocks?: boolean) =>
    new NativeFormatter().buildMessages(messages, {
      ...options, promptCaching: true, ...extra, ...(serverBlocks === undefined ? {} : { anthropicServerBlocks: serverBlocks }),
    });
  const withoutCarriers = (messages: NormalizedMessage[]): NormalizedMessage[] =>
    messages.map((message) => ({ ...message, content: message.content.filter((block) => !anthropicServerBlockFor(block)) }));

  it.each(cases)('%s: NativeFormatter builds exactly what it built with the carriers absent', (_name, messages, extra) => {
    expect(build(messages, extra, false)).toEqual(build(withoutCarriers(messages), extra));
    expect(serverBlocksIn(build(messages, extra).messages).length).toBeGreaterThan(0);
  });

  it('Membrane builds without them for an adapter that doesn\'t declare the capability; the Anthropic adapter declares it', async () => {
    const sent: any[] = [];
    const adapter: ProviderAdapter = {
      name: 'zz-other', supportsModel: () => true,
      complete: async (request) => {
        sent.push(structuredClone(request));
        return { content: [{ type: 'text', text: 'zz ok' }], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, raw: {} } as any;
      },
      stream: async () => { throw new Error('Unexpected stream'); },
    };
    const membrane = new Membrane(adapter, { formatter: new NativeFormatter() });
    await membrane.complete({ messages: history(), assistantParticipant: 'Claude', config: { model: 'zz', maxTokens: 32 } });
    expect(sent[0].messages[1].content).toEqual([thinking1, thinking2, answer]);
    expect(new AnthropicAdapter({ apiKey: 'zz-key', cacheKeepalive: { enabled: false } }).replaysAnthropicServerBlocks).toBe(true);
    expect(new BedrockAdapter({ accessKeyId: 'zz', secretAccessKey: 'zz', region: 'us-west-2' }).replaysAnthropicServerBlocks).toBeUndefined();
  });
});

describe('a server call and its result go out together, or not at all', () => {
  const call = (id: string) => ({ type: 'server_tool_use', id, name: 'web_search', input: { query: 'zz' } });
  const result = (id: string) => ({ type: 'web_search_tool_result', tool_use_id: id, content: [] });
  const say = (text: string): ContentBlock => ({ type: 'text', text });
  const options = (notes: FidelityNotes, extra: Record<string, unknown> = {}) =>
    ({ assistantParticipant: 'Claude', participantMode: 'multiuser', fidelity: notes, anthropicServerBlocks: true, ...extra }) as any;

  it('unpairedServerBlocks names a call with no result after it in the turn, and a result with no call before it', () => {
    const c1 = call('a'); const r1 = result('a'); const c2 = call('b'); const r3 = result('c');
    const upload = { type: 'container_upload', file_id: 'zz-file' };
    const turn = [c1, r1, c2, r3, upload, answer];
    // The API refuses container_upload in any assistant turn, so it never goes,
    // whatever it carries.
    expect([...unpairedServerBlocks(turn, false)]).toEqual([c2, r3, upload]);
    const naming = { type: 'container_upload', file_id: 'zz-file', tool_use_id: 'a' };
    expect([...unpairedServerBlocks([c1, naming, r1], false)]).toEqual([naming]);
    // As the request's last message, a paused turn keeps its lone calls, but not a lone result.
    expect([...unpairedServerBlocks(turn, true)]).toEqual([r3, upload]);
    // A result before its call pairs with nothing.
    const r4 = result('d'); const c4 = call('d');
    expect([...unpairedServerBlocks([r4, c4], false)]).toEqual([r4, c4]);
    // The MCP connector's pair, by the same rule.
    const mcpCall = { type: 'mcp_tool_use', id: 'zz-m1', name: 'zz_lookup', server_name: 'zz', input: {} };
    const mcpResult = { type: 'mcp_tool_result', tool_use_id: 'zz-m1', content: [] };
    expect(unpairedServerBlocks([mcpCall, mcpResult], false).size).toBe(0);
    expect([...unpairedServerBlocks([mcpCall], false)]).toEqual([mcpCall]);
  });

  it('unpairedServerBlocks pairs each id once in a turn: a second call with an id, and a second result for a call, go', () => {
    // The API refuses a turn holding either ("`server_tool_use` ids must be
    // unique per assistant turn", "found multiple `web_search_tool_result`
    // blocks with id"), and takes what's left: one call and its result.
    for (const lastTurn of [false, true]) {
      const c1 = call('a'); const c2 = call('a'); const r1 = result('a');
      expect([...unpairedServerBlocks([c1, c2, r1], lastTurn)], 'two calls, one result').toEqual([c2]);
      const c3 = call('a'); const r2 = result('a'); const r3 = result('a');
      expect([...unpairedServerBlocks([c3, r2, r3], lastTurn)], 'one call, two results').toEqual([r3]);
      const c4 = call('a'); const r4 = result('a'); const c5 = call('a'); const r5 = result('a');
      expect([...unpairedServerBlocks([c4, r4, c5, r5], lastTurn)], 'the same pair twice').toEqual([c5, r5]);
      // A result before the first call of its id pairs with nothing, and the result after it pairs.
      const r6 = result('a'); const c6 = call('a'); const r7 = result('a');
      expect([...unpairedServerBlocks([r6, c6, r7], lastTurn)], 'a result before its call').toEqual([r6]);
      // Two ids, each once, both pair.
      expect(unpairedServerBlocks([call('a'), result('a'), call('b'), result('b')], lastTurn).size, 'two ids').toBe(0);
    }
  });

  it('unpairedServerBlocks names a call whose id, or a result whose tool_use_id, isn\'t a string, in every turn, the last included', () => {
    // The API refuses each: "Field required", "Input should be a valid string".
    for (const lastTurn of [false, true]) {
      const unnamed = { type: 'web_search_tool_result', content: [] };
      const numbered = { type: 'web_search_tool_result', tool_use_id: 7, content: [] };
      const c1 = call('a'); const r1 = result('a');
      expect([...unpairedServerBlocks([c1, unnamed, r1, numbered], lastTurn)], 'results').toEqual([unnamed, numbered]);
      const noId = { type: 'server_tool_use', name: 'web_search', input: { query: 'zz' } };
      const numberId = { type: 'server_tool_use', id: 7, name: 'web_search', input: { query: 'zz' } };
      expect([...unpairedServerBlocks([noId, numberId], lastTurn)], 'calls').toEqual([noId, numberId]);
    }
  });

  it('NativeFormatter leaves a lone call or a lone result out of a turn that isn\'t the request\'s last, and names each message', () => {
    const notes = new FidelityNotes();
    const built = new NativeFormatter().buildMessages([
      { participant: 'User', content: [say('zz ask')] },
      { participant: 'Claude', content: [say('zz searching'), carrier(call('zz-lone-call'))] },
      { participant: 'User', content: [say('zz go on')] },
      { participant: 'Claude', content: [carrier(result('zz-lone-result')), say('zz found')] },
      { participant: 'User', content: [say('zz and?')] },
    ], options(notes));
    const sent = JSON.stringify(built.messages);
    expect(sent).not.toContain('zz-lone-call');
    expect(sent).not.toContain('zz-lone-result');
    expect(sent).toContain('zz searching');
    expect(sent).toContain('zz found');
    expect([...notes.altered].sort()).toEqual([1, 3]);
  });

  it('NativeFormatter keeps a lone call in the request\'s last message when it\'s the assistant\'s, as a paused turn is resumed', () => {
    const notes = new FidelityNotes();
    const built = new NativeFormatter().buildMessages([
      { participant: 'User', content: [say('zz ask')] },
      { participant: 'Claude', content: [say('zz searching'), carrier(call('zz-paused')), carrier(result('zz-no-call'))] },
    ], options(notes));
    const last = built.messages.at(-1)!;
    expect(last.role).toBe('assistant');
    expect(JSON.stringify(last.content)).toContain('"id":"zz-paused"');
    expect(JSON.stringify(last.content)).not.toContain('zz-no-call');
    expect([...notes.altered]).toEqual([1]);
  });

  it('NativeFormatter sends a call and its result stored as two consecutive assistant messages together, as the one turn they become', () => {
    const notes = new FidelityNotes();
    const built = new NativeFormatter().buildMessages([
      { participant: 'User', content: [say('zz ask')] },
      { participant: 'Claude', content: [say('zz searching'), carrier(call('zz-split'))] },
      { participant: 'Claude', content: [carrier(result('zz-split')), say('zz found')] },
      { participant: 'User', content: [say('zz go on')] },
    ], options(notes));
    expect(built.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
    const turn = JSON.stringify(built.messages[1]!.content);
    expect(turn).toContain('"id":"zz-split"');
    expect(turn).toContain('"tool_use_id":"zz-split"');
    expect([...notes.altered]).toEqual([]);
  });

  it('NativeFormatter sends a pair stored twice, in two assistant messages that merge into one turn, once', () => {
    // As a retry that stores the same turn again leaves it. The API takes each
    // id once per turn as sent, so the second copy goes, and its message is named.
    const notes = new FidelityNotes();
    const built = new NativeFormatter().buildMessages([
      { participant: 'User', content: [say('zz ask')] },
      { participant: 'Claude', content: [carrier(call('zz-twice')), carrier(result('zz-twice')), say('zz found')] },
      { participant: 'Claude', content: [carrier(call('zz-twice')), carrier(result('zz-twice')), say('zz found again')] },
      { participant: 'User', content: [say('zz go on')] },
    ], options(notes));
    expect(built.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
    const turn = JSON.stringify(built.messages[1]!.content);
    expect(turn.split('"id":"zz-twice"').length - 1).toBe(1);
    expect(turn.split('"tool_use_id":"zz-twice"').length - 1).toBe(1);
    expect(turn).toContain('zz found again');
    expect([...notes.altered]).toEqual([2]);
  });

  it('NativeFormatter drops an assistant turn left with nothing, and the user turns around it become one', () => {
    const notes = new FidelityNotes();
    const built = new NativeFormatter().buildMessages([
      { participant: 'User', content: [say('zz ask')] },
      { participant: 'Claude', content: [carrier(call('zz-only'))] },
      { participant: 'User', content: [say('zz go on')] },
    ], options(notes));
    expect(built.messages.map((message) => message.role)).toEqual(['user']);
    const sent = JSON.stringify(built.messages);
    expect(sent).toContain('zz ask');
    expect(sent).toContain('zz go on');
    expect(sent).not.toContain('zz-only');
    expect([...notes.altered]).toEqual([1]);
  });

  it('NativeFormatter moves a marker from a block it leaves out to the turn\'s last block that can hold one', () => {
    const notes = new FidelityNotes();
    const built = new NativeFormatter().buildMessages([
      { participant: 'User', content: [say('zz ask')] },
      { participant: 'Claude', content: [say('zz searching'), carrier(call('zz-marked'))], cacheBreakpoint: true },
      { participant: 'User', content: [say('zz go on')] },
    ], options(notes, { promptCaching: true }));
    const turn = built.messages[1]!.content as Array<Record<string, unknown>>;
    expect(JSON.stringify(turn)).not.toContain('zz-marked');
    expect(turn.at(-1)!.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('NativeFormatter leaves a dropped marker where it is when a kept block of the turn already holds one', () => {
    const notes = new FidelityNotes();
    const built = new NativeFormatter().buildMessages([
      { participant: 'User', content: [say('zz ask')] },
      { participant: 'Claude', content: [say('zz first')], cacheBreakpoint: true },
      { participant: 'Claude', content: [say('zz second'), carrier(call('zz-lone-marked'))], cacheBreakpoint: true },
      { participant: 'User', content: [say('zz go on')] },
    ], options(notes, { promptCaching: true }));
    const turn = built.messages[1]!.content as Array<Record<string, unknown>>;
    expect(turn.map((block) => block.type)).toEqual(['text', 'text']);
    expect(turn[0]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(turn[1]!.cache_control).toBeUndefined();
  });

  it('NativeFormatter leaves container_upload out of an assistant turn, which the API refuses there, and names its message', () => {
    const notes = new FidelityNotes();
    const upload = { type: 'container_upload', file_id: 'zz-file' };
    const built = new NativeFormatter().buildMessages([
      { participant: 'User', content: [say('zz ask')] },
      { participant: 'Claude', content: [say('zz uploaded'), carrier(upload)] },
      { participant: 'User', content: [say('zz go on')] },
    ], options(notes));
    expect(JSON.stringify(built.messages)).not.toContain('container_upload');
    expect([...notes.altered]).toEqual([1]);
  });

  it('NativeFormatter replays server blocks only when the build asks for them', () => {
    const messages: NormalizedMessage[] = [
      { participant: 'User', content: [say('zz ask')] },
      { participant: 'Claude', content: [say('zz searching'), carrier(call('zz-default')), carrier(result('zz-default'))] },
      { participant: 'User', content: [say('zz go on')] },
    ];
    const plain = { assistantParticipant: 'Claude', participantMode: 'multiuser' } as any;
    expect(JSON.stringify(new NativeFormatter().buildMessages(messages, plain).messages)).not.toContain('zz-default');
    expect(JSON.stringify(new NativeFormatter().buildMessages(messages, { ...plain, anthropicServerBlocks: true }).messages)).toContain('zz-default');
  });

  it('NativeFormatter puts a moved marker on the last block that can hold one, not on thinking after it', () => {
    const notes = new FidelityNotes();
    const built = new NativeFormatter().buildMessages([
      { participant: 'User', content: [say('zz ask')] },
      { participant: 'Claude', content: [say('zz searching'), thinking1 as unknown as ContentBlock, carrier(call('zz-marked-2'))], cacheBreakpoint: true },
      { participant: 'User', content: [say('zz go on')] },
    ], options(notes, { promptCaching: true }));
    const turn = built.messages[1]!.content as Array<Record<string, unknown>>;
    expect(turn.map((block) => block.type)).toEqual(['text', 'thinking']);
    expect(turn[0]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(turn[1]!.cache_control).toBeUndefined();
  });

  it('NativeFormatter drops the marker when no kept block of the turn can hold one', () => {
    const notes = new FidelityNotes();
    const built = new NativeFormatter().buildMessages([
      { participant: 'User', content: [say('zz ask')] },
      { participant: 'Claude', content: [thinking1 as unknown as ContentBlock, carrier(call('zz-marked-3'))], cacheBreakpoint: true },
      { participant: 'User', content: [say('zz go on')] },
    ], options(notes, { promptCaching: true }));
    const turn = built.messages[1]!.content as Array<Record<string, unknown>>;
    expect(turn.map((block) => block.type)).toEqual(['thinking']);
    expect(turn[0]!.cache_control).toBeUndefined();
    expect([...notes.altered]).toEqual([1]);
  });

  it('NativeFormatter pairs within each turn: a call and its result with a user turn between them are both left out', () => {
    const notes = new FidelityNotes();
    const built = new NativeFormatter().buildMessages([
      { participant: 'User', content: [say('zz ask')] },
      { participant: 'Claude', content: [say('zz searching'), carrier(call('zz-across'))] },
      { participant: 'User', content: [say('zz meanwhile')] },
      { participant: 'Claude', content: [carrier(result('zz-across')), say('zz found')] },
      { participant: 'User', content: [say('zz and?')] },
    ], options(notes));
    expect(JSON.stringify(built.messages)).not.toContain('zz-across');
    expect([...notes.altered].sort()).toEqual([1, 3]);
  });

  it('a call cut off mid-stream, which has no result after it, is left out of a turn that isn\'t the last, and goes back as stored in the final one', () => {
    const broken = { type: 'server_tool_use', id: 'srvtoolu_zz8', name: 'web_search', input: {}, unparseableInput: '{"query": "zz' };
    const notes = new FidelityNotes();
    const mid = new NativeFormatter().buildMessages([
      { participant: 'User', content: [say('zz ask')] },
      { participant: 'Claude', content: [say('zz searching'), carrier(broken)] },
      { participant: 'User', content: [say('zz go on')] },
    ], options(notes));
    expect(JSON.stringify(mid.messages)).not.toContain('srvtoolu_zz8');
    expect([...notes.altered]).toEqual([1]);
    const last = new NativeFormatter().buildMessages([
      { participant: 'User', content: [say('zz ask')] },
      { participant: 'Claude', content: [say('zz searching'), carrier(broken)] },
    ], options(new FidelityNotes()));
    const turn = JSON.stringify(last.messages.at(-1));
    expect(turn).toContain('"id":"srvtoolu_zz8"');
    expect(turn).not.toContain('unparseableInput');
  });

  it('NativeFormatter drops only the turns pairing empties, not another message with no content', () => {
    const notes = new FidelityNotes();
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'zz ask' }] },
      { role: 'assistant', content: [] },
      { role: 'user', content: [{ type: 'text', text: 'zz go on' }] },
      { role: 'assistant', content: [{ type: 'server_tool_use', id: 'zz-only-2', name: 'web_search', input: {} }] },
      { role: 'user', content: [{ type: 'text', text: 'zz and?' }] },
    ];
    const paired = (NativeFormatter as unknown as { pairServerBlocks(m: unknown[], f: FidelityNotes): Array<{ role: string; content: unknown[] }> })
      .pairServerBlocks(messages, notes);
    expect(paired.map((message) => [message.role, message.content.length])).toEqual([['user', 1], ['assistant', 0], ['user', 2]]);
  });
});

describe('direct conversions and a zero-width carrier', () => {
  it('toGeminiParts adds no part for a carrier', () => {
    expect(toGeminiParts([{ type: 'text', text: 'zz said' } as ContentBlock, carrier(serverUse)])).toEqual([{ text: 'zz said' }]);
  });

  it("toOpenAIContent gives '' for a turn whose only text blocks are carriers, and null for one with no text block", () => {
    expect(toOpenAIContent([carrier(serverUse)])).toBe('');
    expect(toOpenAIContent([])).toBe(null);
    expect(toOpenAIContent([{ type: 'text', text: 'zz said' } as ContentBlock, carrier(serverUse)])).toBe('zz said');
  });

  it('fromAnthropicContent carries a server block without the unknown-type warning', () => {
    resetUnconvertibleBlockWarnings();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(fromAnthropicContent([serverUse as never])).toEqual([{ type: 'text', text: '', rawItem: serverUse }]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
