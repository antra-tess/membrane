import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicAdapter, readInputTransformations, toAnthropicContent } from '../../src/providers/anthropic.js';
import { BedrockAdapter } from '../../src/providers/bedrock.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { Membrane } from '../../src/membrane.js';
import type { ContentBlock, NormalizedMessage } from '../../src/types/index.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
const PDF = Buffer.from('%PDF-1.4\n%%EOF\n').toString('base64');
const MARK = { type: 'ephemeral' };
const ERROR_IMAGE_NOTE = '[system: an image in this tool result was NOT shown to you — a tool error reaches this model as text only. You are not seeing this image.]';
const EMPTY_ERROR_NOTE = '[system: this tool error carries no content this request can show.]';
const EXTRA = { annotations: { audience: ['user'] }, _meta: { server: 't' }, sourceUrl: 'https://example.com/a.png', tokenEstimate: 7, rawItem: { id: 'x' }, foo: 'bar' };

const adapters = {
  Anthropic: () => new AnthropicAdapter({ apiKey: 'test-key', cacheKeepalive: { enabled: false } }),
  Bedrock: () => new BedrockAdapter({ accessKeyId: 'test-key', secretAccessKey: 'test-secret', region: 'us-west-2' }),
} as const;
type Wire = keyof typeof adapters;
const wires = Object.keys(adapters) as Wire[];
const build = (wire: Wire, messages: unknown[], onContentAltered?: (block?: unknown) => void): any =>
  (adapters[wire]() as any).buildRequest({ model: 'claude-sonnet-4-5', maxTokens: 64, messages }, ...(wire === 'Bedrock' ? [undefined] : []), onContentAltered);
const result = (content: unknown[], extra: object = {}) =>
  [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', ...extra, content }] }];

/** count_tokens takes this request without its thinking blocks, whose
 *  signatures are made up, and with a real PDF for PDF's stand-in bytes. The
 *  API takes at most four breakpoints, so text's is pinned by the ttl test. */
const everyField = (wire: Wire) => [
  { role: 'user', content: [
    { type: 'text', text: 'see', citations: null },
    { type: 'image', source: { type: 'base64', data: PNG, media_type: 'image/png' }, cache_control: MARK, transformations: null },
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PDF }, cache_control: MARK, citations: { enabled: true }, context: 'c', title: 't' },
  ] },
  { role: 'assistant', content: [
    { type: 'thinking', thinking: 'x', signature: 'c2ln' },
    { type: 'redacted_thinking', data: 'RW5j' },
    { type: 'tool_use', id: 'toolu_1', name: 'snap', input: {}, cache_control: MARK, caller: { type: 'direct' }, toolset_name: null },
  ] },
  { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'toolu_1', is_error: false, toolset_name: null, cache_control: MARK, content: [
      { type: 'text', text: 'nested' },
      { type: 'image', source: wire === 'Anthropic'
        ? { type: 'base64', media_type: 'image/png', data: PNG }
        : { type: 'base64', data: PNG, media_type: 'image/png' } },
    ] },
  ] },
];

describe.each(wires)('%s', (wire) => {
  it('keeps every field the API takes at the top of a message, with the same bytes', () => {
    expect(JSON.stringify(build(wire, everyField(wire)).messages)).toBe(JSON.stringify(everyField(wire)));
  });

  it('leaves behind every field the API refuses, at the top and in a tool_result, a field another type takes included', () => {
    const request = build(wire, [
      { role: 'user', content: [
        { type: 'text', text: 'see', id: 'toolu_x', source: { type: 'text', data: 'x' }, ...EXTRA },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG, ...EXTRA }, cache_control: MARK, ...EXTRA },
        { type: 'document', source: { type: 'base64', mediaType: 'application/pdf', data: PDF }, filename: 'a.pdf', ...EXTRA },
        { type: 'image', source: { type: 'url', url: 'https://example.com/a.png', ...EXTRA }, ...EXTRA },
      ] },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: 'x', signature: 'c2ln', cache_control: MARK, data: 'RW5j', ...EXTRA },
        { type: 'redacted_thinking', data: 'RW5j', signature: 'c2ln', cache_control: MARK, ...EXTRA },
        { type: 'tool_use', id: 'toolu_1', name: 'snap', input: {}, rawXml: '<x/>', unparseableInput: '', ...EXTRA },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', toolName: 'snap', ...EXTRA, content: [
          { type: 'text', text: 'nested', ...EXTRA },
          { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: PNG }, ...EXTRA },
        ] },
      ] },
    ]);
    const keys = (block: Record<string, unknown>) => Object.keys(block).sort();
    const [user, assistant, results] = request.messages;
    expect(user.content.map(keys)).toEqual([
      ['text', 'type'],
      ['cache_control', 'source', 'type'],
      ['source', 'title', 'type'],
      ['source', 'type'],
    ]);
    expect(keys(user.content[1].source)).toEqual(['data', 'media_type', 'type']);
    expect(user.content[2]).toEqual({ type: 'document', source: { type: 'base64', data: PDF, media_type: 'application/pdf' }, title: 'a.pdf' });
    expect(user.content[3].source).toEqual({ type: 'url', url: 'https://example.com/a.png' });
    expect(assistant.content.map(keys)).toEqual([
      ['signature', 'thinking', 'type'],
      ['data', 'type'],
      ['id', 'input', 'name', 'type'],
    ]);
    const [block] = results.content;
    expect(keys(block)).toEqual(['content', 'tool_use_id', 'type']);
    expect(block.content.map(keys)).toEqual([['text', 'type'], ['source', 'type']]);
    expect(keys(block.content[1].source)).toEqual(['data', 'media_type', 'type']);
  });

  it('sends text and a base64 or URL image inside a tool_result, leaves anything else out, and reports the tool_result once', () => {
    const original = { type: 'tool_result', tool_use_id: 'toolu_1', content: [
      { type: 'text', text: 'kept', cache_control: MARK, citations: null },
      { type: 'tool_use', id: 'inner', name: 'snap', input: {} },
      null,
      { type: 'redacted_thinking', data: 'RW5j' },
      { type: 'audio', source: { type: 'base64', mediaType: 'audio/wav', data: 'UklG' } },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PDF } },
      { type: 'search_result', source: 'https://example.com', title: 'r', content: [{ type: 'text', text: 'hit' }] },
      { type: 'image', source: { type: 'file', file_id: 'file_011' } },
      { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' }, cache_control: MARK },
    ] };
    const altered: unknown[] = [];
    const request = build(wire, [{ role: 'user', content: [original] }], (block) => altered.push(block));
    expect(request.messages[0].content[0].content).toEqual([
      { type: 'text', text: 'kept' },
      { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
    ]);
    expect(altered).toEqual([original]);
    expect(altered[0]).toBe(original);
  });

  it("removes whitespace text inside a tool_result and reports its tool_result, but not for text that's exactly empty", () => {
    const blank = { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'kept' }, { type: 'text', text: ' \n' }] };
    const empty = { type: 'tool_result', tool_use_id: 'toolu_2', content: [{ type: 'text', text: 'kept' }, { type: 'text', text: '' }] };
    const altered: unknown[] = [];
    const [blankResult, emptyResult] = build(wire, [{ role: 'user', content: [blank, empty] }], (block) => altered.push(block)).messages[0].content;
    expect(blankResult.content).toEqual([{ type: 'text', text: 'kept' }]);
    expect(emptyResult.content).toEqual([{ type: 'text', text: 'kept' }]);
    expect(altered).toEqual([blank]);
  });

  it('sends only text in an error result, an image there as a note, and one note for an error result with nothing to send, whether it held nothing or nothing it could carry', () => {
    const svg = { type: 'image', source: { type: 'base64', media_type: 'image/svg+xml', data: Buffer.from('<svg/>').toString('base64') } };
    const withText = { type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: [
      { type: 'text', text: 'it failed' },
      { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'note' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG }, cache_control: MARK },
    ] };
    const failed = { type: 'tool_result', tool_use_id: 'toolu_2', is_error: true, content: [
      { type: 'tool_use', id: 'inner', name: 'snap', input: {} },
      { type: 'text', text: '  ' },
    ] };
    const succeeded = { type: 'tool_result', tool_use_id: 'toolu_3', content: [{ type: 'tool_use', id: 'inner', name: 'snap', input: {} }] };
    const empty = { type: 'tool_result', tool_use_id: 'toolu_4', is_error: true, content: [] };
    const blank = { type: 'tool_result', tool_use_id: 'toolu_5', is_error: true, content: [{ type: 'text', text: ' \n' }] };
    const none = { type: 'tool_result', tool_use_id: 'toolu_6', is_error: true };
    const placeholder = { type: 'tool_result', tool_use_id: 'toolu_7', is_error: true, content: [{ type: 'text', text: 'see' }, svg] };
    const holdsNull = { type: 'tool_result', tool_use_id: 'toolu_8', is_error: true, content: [null] };
    const emptyString = { type: 'tool_result', tool_use_id: 'toolu_9', is_error: true, content: '' };
    const nullContent = { type: 'tool_result', tool_use_id: 'toolu_10', is_error: true, content: null };
    // count_tokens takes an error result whose content is a string of whitespace.
    const blankString = { type: 'tool_result', tool_use_id: 'toolu_11', is_error: true, content: ' \n' };
    const failedString = { type: 'tool_result', tool_use_id: 'toolu_12', is_error: true, content: 'tool failed' };
    const emptyText = { type: 'tool_result', tool_use_id: 'toolu_13', is_error: true, content: [{ type: 'text', text: '' }] };
    const altered: unknown[] = [];
    const results = build(wire, [{ role: 'user', content: [
      withText, failed, succeeded, empty, blank, none, placeholder, holdsNull, emptyString, nullContent, blankString, failedString, emptyText,
    ] }], (block) => altered.push(block)).messages[0].content;
    expect(results.map((b: any) => b.content)).toEqual([
      [{ type: 'text', text: 'it failed' }, { type: 'text', text: ERROR_IMAGE_NOTE }],
      [{ type: 'text', text: EMPTY_ERROR_NOTE }],
      [],
      [{ type: 'text', text: EMPTY_ERROR_NOTE }],
      [{ type: 'text', text: EMPTY_ERROR_NOTE }],
      [{ type: 'text', text: EMPTY_ERROR_NOTE }],
      [{ type: 'text', text: 'see' }, { type: 'text', text: expect.stringContaining('its data is not a JPEG, PNG, GIF or WebP image') }],
      [{ type: 'text', text: EMPTY_ERROR_NOTE }],
      [{ type: 'text', text: EMPTY_ERROR_NOTE }],
      [{ type: 'text', text: EMPTY_ERROR_NOTE }],
      ' \n',
      'tool failed',
      [{ type: 'text', text: EMPTY_ERROR_NOTE }],
    ]);
    expect(altered).toEqual([withText, failed, succeeded, empty, blank, none, placeholder, holdsNull, emptyString, nullContent, emptyText]);
  });

  it('labels an image by what its bytes show, at the top and in a tool_result', () => {
    const mislabelled = () => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: PNG } });
    const [image, block] = build(wire, [{ role: 'user', content: [mislabelled(), ...result([mislabelled()])[0].content] }]).messages[0].content;
    expect(image.source.media_type).toBe('image/png');
    expect(block.content[0].source.media_type).toBe('image/png');
  });

  it("sends a document's or an image's source of another type at the top as it came, and keeps a document's own title over its filename", () => {
    const file = { type: 'file', file_id: 'file_011' };
    const text = { type: 'text', media_type: 'text/plain', data: 'hello' };
    const contentSource = { type: 'content', content: [{ type: 'text', text: 'a' }] };
    const sources = structuredClone([file, text, contentSource]);
    const [image, document, sourced, titled] = build(wire, [{ role: 'user', content: [
      { type: 'image', source: file },
      { type: 'document', source: text },
      { type: 'document', source: contentSource },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PDF }, title: 'Q3 report', filename: 'q3.pdf' },
    ] }]).messages[0].content;
    expect(JSON.stringify([image.source, document.source, sourced.source])).toBe(JSON.stringify(sources));
    expect([file, text, contentSource]).toEqual(sources);
    expect(titled.title).toBe('Q3 report');
  });

  it('names the block handed in when its cleanup drops one the build copied', () => {
    const whitespace = { type: 'text', text: '  ', annotations: { audience: ['user'] } };
    const altered: unknown[] = [];
    build(wire, [{ role: 'user', content: [{ type: 'text', text: 'hi' }, whitespace] }], (block) => altered.push(block));
    expect(altered).toEqual([whitespace]);
    expect(altered[0]).toBe(whitespace);
  });

  it("names the caller's own block in input_transformations for a block the build copied", () => {
    const converted = { type: 'image', data: PNG, mimeType: 'image/png' };
    const text = { type: 'text', text: 'see', annotations: { audience: ['user'] } };
    const result = { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'shot', _meta: { server: 't' } }] };
    const other = { type: 'search_result', source: 'https://example.com', title: 'r', content: [{ type: 'text', text: 'hit' }] };
    const sent = build(wire, [{ role: 'user', content: [converted, text, result, other] }]).messages;
    expect(sent[0].content[0].source.media_type).toBe('image/png');
    const { inputTransformations } = readInputTransformations(
      [0, 1, 2, 3].map((index) => ({ type: 'connector_rewritten', path: `messages.0.content.${index}` })),
      sent,
    );
    expect(inputTransformations!.map((entry) => entry.block)).toEqual([converted, text, result, other]);
    inputTransformations!.forEach((entry, index) => expect(entry.block).toBe([converted, text, result, other][index]));
  });

  it('sends a block of another type at the top as it came', () => {
    const other = { type: 'search_result', source: 'https://example.com', title: 'r', content: [{ type: 'text', text: 'hit' }], foo: 'bar' };
    const asGiven = structuredClone(other);
    const [sent] = build(wire, [{ role: 'user', content: [other] }]).messages[0].content;
    expect(JSON.stringify(sent)).toBe(JSON.stringify(asGiven));
    expect(other).toEqual(asGiven);
  });

  it('leaves out and reports a block that is not an object at the top of a message', () => {
    const altered: unknown[] = [];
    const [message] = build(wire, [{ role: 'user', content: [null, { type: 'text', text: 'kept' }, 'loose'] }], (block) => altered.push(block)).messages;
    expect(message.content).toEqual([{ type: 'text', text: 'kept' }]);
    expect(altered).toEqual([null, 'loose']);
  });
});

describe('the wires that differ', () => {
  it('Bedrock leaves out cache_control.ttl at the top, on a tool_result and on a block of another type; Anthropic keeps it', () => {
    const ttl = { type: 'ephemeral', ttl: '1h' };
    const messages = () => [{ role: 'user', content: [
      { type: 'text', text: 'see', cache_control: ttl },
      { type: 'tool_result', tool_use_id: 'toolu_1', cache_control: ttl, content: [{ type: 'text', text: 'shot' }] },
      { type: 'search_result', source: 'https://example.com', title: 'r', content: [{ type: 'text', text: 'hit' }], cache_control: ttl },
    ] }];
    expect(build('Bedrock', messages()).messages[0].content.map((b: any) => b.cache_control)).toEqual([MARK, MARK, MARK]);
    expect(build('Anthropic', messages()).messages[0].content.map((b: any) => b.cache_control)).toEqual([ttl, ttl, ttl]);
  });

  it("Anthropic names the caller's tool_addition when it flattens its schema's root union, in its report and in input_transformations", () => {
    const anyOf = { anyOf: [
      { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
      { type: 'object', properties: { b: { type: 'string' } }, required: ['b'] },
    ] };
    const addition = { type: 'tool_addition', tool: { type: 'tool_definition', definition: { name: 'pick', description: 'Pick.', input_schema: anyOf } } };
    const altered: unknown[] = [];
    const sent = build('Anthropic', [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'system', content: [addition] },
    ], (block) => altered.push(block)).messages;
    expect(sent[1].content[0].tool.definition.input_schema.anyOf).toBeUndefined();
    expect(altered).toEqual([addition]);
    expect(altered[0]).toBe(addition);
    const { inputTransformations } = readInputTransformations([{ type: 'connector_rewritten', path: 'messages.1.content.0' }], sent);
    expect(inputTransformations![0]!.block).toBe(addition);
  });

  it("lays out each block as its wire's adapter always did, so a request that went out before keeps its bytes", () => {
    const image = (source: object) => ({ type: 'image', source });
    const wireFirst = { type: 'base64', media_type: 'image/png', data: PNG };
    const dataFirst = { type: 'base64', data: PNG, media_type: 'image/png' };
    const membraneForm = { type: 'base64', data: PNG, mediaType: 'image/png' };
    const document = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PDF } };
    const dataUrl = { type: 'url', url: `data:image/png;base64,${PNG}` };
    const messages = () => [{ role: 'user', content: [
      image(wireFirst), image(dataFirst), image(membraneForm), document, image(dataUrl),
      { type: 'tool_result', tool_use_id: 'toolu_1', content: [
        image(wireFirst), image(dataFirst), image(membraneForm), { text: 'given in its own order', type: 'text' }, image(dataUrl),
      ] },
    ] }];
    const sent = (wire: Wire) => build(wire, messages()).messages[0].content.map((b: unknown) => JSON.stringify(b));
    const asSent = (blocks: unknown[]) => blocks.map((b) => JSON.stringify(b));
    expect(sent('Anthropic')).toEqual(asSent([
      image(wireFirst), image(dataFirst), image(dataFirst), document, image(wireFirst),
      { type: 'tool_result', tool_use_id: 'toolu_1', content: [
        image(wireFirst), image(wireFirst), image(wireFirst), { type: 'text', text: 'given in its own order' }, image(wireFirst),
      ] },
    ]));
    expect(sent('Bedrock')).toEqual(asSent([
      image(dataFirst), image(dataFirst), image(dataFirst), document, image(wireFirst),
      { type: 'tool_result', tool_use_id: 'toolu_1', content: [
        image(dataFirst), image(dataFirst), image(dataFirst), { text: 'given in its own order', type: 'text' }, image(wireFirst),
      ] },
    ]));
  });

  it("toAnthropicContent sends a tool_result's text and images, an error result's text only, and a note for one with nothing to send", () => {
    const [block] = toAnthropicContent([{ type: 'tool_result', toolUseId: 'toolu_1', content: [
      { type: 'text', text: 'see' },
      { type: 'image', source: { type: 'base64', data: PNG, mediaType: 'image/png' } },
      { type: 'document', source: { type: 'base64', mediaType: 'application/pdf', data: PDF }, filename: 'a.pdf' },
      { type: 'tool_use', id: 'inner', name: 'snap', input: {} },
    ] } as ContentBlock]) as any[];
    expect(JSON.stringify(block.content)).toBe(JSON.stringify([
      { type: 'text', text: 'see' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
    ]));
    const [failed, imaged, empty, plain, blank, emptyText] = toAnthropicContent([
      { type: 'tool_result', toolUseId: 'toolu_2', isError: true, content: [{ type: 'tool_use', id: 'inner', name: 'snap', input: {} }] },
      { type: 'tool_result', toolUseId: 'toolu_3', isError: true, content: [{ type: 'image', source: { type: 'base64', data: PNG, mediaType: 'image/png' } }] },
      { type: 'tool_result', toolUseId: 'toolu_4', isError: true, content: '' },
      { type: 'tool_result', toolUseId: 'toolu_5', content: 'done' },
      { type: 'tool_result', toolUseId: 'toolu_6', isError: true, content: [{ type: 'text', text: ' \n' }] },
      { type: 'tool_result', toolUseId: 'toolu_7', isError: true, content: [{ type: 'text', text: '' }] },
    ] as ContentBlock[]) as any[];
    expect(failed.content).toEqual([{ type: 'text', text: EMPTY_ERROR_NOTE }]);
    expect(imaged.content).toEqual([{ type: 'text', text: ERROR_IMAGE_NOTE }]);
    expect(empty.content).toEqual([{ type: 'text', text: EMPTY_ERROR_NOTE }]);
    expect(plain.content).toBe('done');
    expect(blank.content).toEqual([{ type: 'text', text: EMPTY_ERROR_NOTE }]);
    expect(emptyText.content).toEqual([{ type: 'text', text: EMPTY_ERROR_NOTE }]);
  });
});

describe('through Membrane with the native formatter', () => {
  const capture = () => {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: unknown, init?: { body?: string }) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({
        id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { headers: { 'content-type': 'application/json' } });
    }));
    return bodies;
  };

  it.each(wires)('%s: a stored tool result and stamped thinking reach the wire with the API\'s fields only', async (wire) => {
    const bodies = capture();
    const messages: NormalizedMessage[] = [
      { participant: 'User', content: [{ type: 'text', text: 'look' }] },
      { participant: 'Claude', content: [
        { type: 'thinking', thinking: 'x', signature: 'c2ln', tokenEstimate: 7 },
        { type: 'redacted_thinking', data: 'RW5j', tokenEstimate: 5 },
        { type: 'tool_use', id: 'toolu_1', name: 'snap', input: {} },
      ] as any },
      { participant: 'User', content: [{ type: 'tool_result', toolUseId: 'toolu_1', content: [
        { type: 'text', text: 'shot', annotations: { audience: ['user'] }, _meta: { server: 't' } },
        { type: 'image', source: { type: 'base64', data: PNG, mediaType: 'image/png' }, sourceUrl: 'https://example.com/a.png', tokenEstimate: 9 },
      ] }] as any },
    ];
    await new Membrane(adapters[wire]() as any, { formatter: new NativeFormatter(), retry: { maxRetries: 0 } }).complete({
      messages, toolMode: 'native', assistantParticipant: 'Claude',
      tools: [{ name: 'snap', description: 'Take a snapshot.', inputSchema: { type: 'object', properties: {} } }],
      config: { model: 'claude-sonnet-4-5', maxTokens: 64, thinking: { enabled: true, budgetTokens: 1024 } },
    } as any);
    expect(bodies).toHaveLength(1);
    const blocks = bodies[0].messages.flatMap((m: any) => m.content);
    const block = blocks.find((b: any) => b.type === 'tool_result');
    expect(block.content).toEqual([
      { type: 'text', text: 'shot' },
      { type: 'image', source: expect.objectContaining({ type: 'base64', media_type: 'image/png', data: PNG }) },
    ]);
    expect(Object.keys(block.content[1].source).sort()).toEqual(['data', 'media_type', 'type']);
    expect(blocks.filter((b: any) => b.type === 'thinking' || b.type === 'redacted_thinking'))
      .toEqual([{ type: 'thinking', thinking: 'x', signature: 'c2ln' }, { type: 'redacted_thinking', data: 'RW5j' }]);
  });
});
