/**
 * The Anthropic and Bedrock adapters build each block of a type membrane uses
 * from the Messages API's whole field list for its type, at the top of a
 * message and inside a tool_result (utils/anthropic-wire-blocks.ts,
 * membrane#161). The API refuses a block carrying a field it doesn't define
 * ("Extra inputs are not permitted"), and a block in history goes out with
 * every later request, so one stray field gets them all refused. A field the
 * API takes survives, and a request that succeeds today goes out with the
 * same bytes, except where Anthropic's wire now sends what its adapter left
 * out of a tool_result. (The fallback breakpoints a request is handed are
 * the breakpoint budget's, tests/unit/cache-marker-budget.test.ts.)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicAdapter, toAnthropicContent } from '../../src/providers/anthropic.js';
import { BedrockAdapter } from '../../src/providers/bedrock.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { Membrane } from '../../src/membrane.js';
import { blockBuiltFrom } from '../../src/utils/anthropic-wire-blocks.js';
import type { ContentBlock, NormalizedMessage } from '../../src/types/index.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
const PDF = Buffer.from('%PDF-1.4\n%%EOF\n').toString('base64');
const MARK = { type: 'ephemeral' };
/** The notes' exact text, which a history that holds one keeps byte for byte. */
const ERROR_IMAGE_NOTE = '[system: an image in this tool result was NOT shown to you — a tool error reaches this model as text only. You are not seeing this image.]';
const EMPTIED_ERROR_NOTE = '[system: what the tool returned with this error was NOT shown to you — none of it is content this request can carry.]';
const NO_CONTENT_ERROR_NOTE = '[system: this tool error came with no content.]';
/** Fields the API doesn't define, from MCP, membrane and a host. */
const EXTRA = { annotations: { audience: ['user'] }, _meta: { server: 't' }, sourceUrl: 'https://example.com/a.png', tokenEstimate: 7, rawItem: { id: 'x' }, foo: 'bar' };

const adapters = {
  Anthropic: () => new AnthropicAdapter({ apiKey: 'test-key', cacheKeepalive: { enabled: false } }),
  Bedrock: () => new BedrockAdapter({ accessKeyId: 'test-key', secretAccessKey: 'test-secret', region: 'us-west-2' }),
} as const;
type Wire = keyof typeof adapters;
const wires = Object.keys(adapters) as Wire[];
const build = (wire: Wire, messages: unknown[], onContentAltered?: (block?: unknown) => void): any =>
  (adapters[wire]() as any).buildRequest({ model: 'claude-sonnet-4-5', maxTokens: 64, messages }, ...(wire === 'Bedrock' ? [undefined] : []), onContentAltered);
/** One user message holding one tool_result with `content`. */
const result = (content: unknown[], extra: object = {}) =>
  [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', ...extra, content }] }];
const built = (wire: Wire, content: unknown[], extra: object = {}) =>
  build(wire, result(content, extra)).messages[0].content[0].content;

/** A request in the wire's own layout that uses every field the API takes
 *  for each type, as a request that succeeds today can: four breakpoints at
 *  most, the one inside the tool_result on its content's last block, and
 *  citations on every document. Without its thinking blocks, whose
 *  signatures are made up, and with a real PDF in place of PDF's stand-in
 *  bytes, the API takes it (count_tokens). */
const everyField = (wire: Wire) => [
  { role: 'user', content: [
    { type: 'text', text: 'see', cache_control: MARK, citations: null },
    { type: 'image', source: { type: 'base64', data: PNG, media_type: 'image/png' }, cache_control: MARK, transformations: null },
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PDF }, citations: { enabled: true }, context: 'c', title: 't' },
  ] },
  { role: 'assistant', content: [
    { type: 'thinking', thinking: 'x', signature: 'c2ln' },
    { type: 'redacted_thinking', data: 'RW5j' },
    { type: 'tool_use', id: 'toolu_1', name: 'snap', input: {}, cache_control: MARK, caller: { type: 'direct' }, toolset_name: null },
  ] },
  { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'toolu_1', is_error: false, toolset_name: null, content: [
      { type: 'text', text: 'nested', citations: null },
      { type: 'image', source: wire === 'Anthropic'
        ? { type: 'base64', media_type: 'image/png', data: PNG }
        : { type: 'base64', data: PNG, media_type: 'image/png' }, transformations: null },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PDF }, cache_control: MARK, citations: { enabled: true }, context: 'c', title: 't' },
    ] },
  ] },
];

/** A tool_result with a breakpoint of its own, which everyField can't hold
 *  beside its nested one, since the API takes no nested one under it. */
const ownMarker = () => [
  { role: 'user', content: [{ type: 'text', text: 'look' }] },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'snap', input: {} }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', cache_control: MARK, content: [{ type: 'text', text: 'shot' }] }] },
];

describe.each(wires)('%s', (wire) => {
  it('keeps every field the API takes, with the same bytes', () => {
    expect(JSON.stringify(build(wire, everyField(wire)).messages)).toBe(JSON.stringify(everyField(wire)));
    expect(JSON.stringify(build(wire, ownMarker()).messages)).toBe(JSON.stringify(ownMarker()));
  });

  it('leaves behind every field the API refuses, at the top and in a tool_result', () => {
    const request = build(wire, [
      { role: 'user', content: [
        { type: 'text', text: 'see', ...EXTRA },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG, ...EXTRA }, cache_control: MARK, ...EXTRA },
        { type: 'document', source: { type: 'base64', mediaType: 'application/pdf', data: PDF }, filename: 'a.pdf', ...EXTRA },
        { type: 'image', source: { type: 'url', url: 'https://example.com/a.png', ...EXTRA }, ...EXTRA },
      ] },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: 'x', signature: 'c2ln', ...EXTRA },
        { type: 'redacted_thinking', data: 'RW5j', ...EXTRA },
        { type: 'tool_use', id: 'toolu_1', name: 'snap', input: {}, rawXml: '<x/>', unparseableInput: '', ...EXTRA },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', toolName: 'snap', ...EXTRA, content: [
          { type: 'text', text: 'nested', ...EXTRA },
          { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: PNG }, ...EXTRA },
          { type: 'document', source: { type: 'url', url: 'https://example.com/a.pdf', ...EXTRA }, ...EXTRA },
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PDF }, ...EXTRA },
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
    // Membrane's own form becomes the wire's: media_type, and filename as title.
    expect(user.content[2]).toEqual({ type: 'document', source: { type: 'base64', data: PDF, media_type: 'application/pdf' }, title: 'a.pdf' });
    expect(user.content[3].source).toEqual({ type: 'url', url: 'https://example.com/a.png' });
    expect(assistant.content.map(keys)).toEqual([
      ['signature', 'thinking', 'type'],
      ['data', 'type'],
      ['id', 'input', 'name', 'type'],
    ]);
    const [block] = results.content;
    expect(keys(block)).toEqual(['content', 'tool_use_id', 'type']);
    expect(block.content.map(keys)).toEqual([
      ['text', 'type'],
      ['source', 'type'],
      ['source', 'type'],
      ['source', 'type'],
    ]);
    expect(keys(block.content[1].source)).toEqual(['data', 'media_type', 'type']);
    expect(block.content[2].source).toEqual({ type: 'url', url: 'https://example.com/a.pdf' });
  });

  it('leaves out, and reports, a block of a type the API refuses inside a tool_result', () => {
    const original = { type: 'tool_result', tool_use_id: 'toolu_1', content: [
      { type: 'text', text: 'kept' },
      { type: 'tool_use', id: 'inner', name: 'snap', input: {} },
      null,
      { type: 'redacted_thinking', data: 'RW5j' },
      { type: 'audio', source: { type: 'base64', mediaType: 'audio/wav', data: 'UklG' } },
    ] };
    const altered: unknown[] = [];
    const request = build(wire, [{ role: 'user', content: [original] }], (block) => altered.push(block));
    expect(request.messages[0].content[0].content.map((b: any) => b.type)).toEqual(['text']);
    expect(altered).toEqual([original]);
    expect(altered[0]).toBe(original);
  });

  it('sends a search result or a tool reference only in content all of its own type, as the API takes them', () => {
    const search = { type: 'search_result', source: 'https://example.com', title: 'r', content: [{ type: 'text', text: 'hit' }] };
    const reference = { type: 'tool_reference', tool_name: 'snap' };
    const alone = [
      { type: 'tool_result', tool_use_id: 'toolu_1', content: [search, search] },
      { type: 'tool_result', tool_use_id: 'toolu_2', content: [reference] },
    ];
    const leftOut = [
      { type: 'tool_result', tool_use_id: 'toolu_3', content: [{ type: 'text', text: 'kept' }, search] },
      { type: 'tool_result', tool_use_id: 'toolu_4', content: [reference, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }] },
      { type: 'tool_result', tool_use_id: 'toolu_5', content: [search, reference] },
    ];
    // Alone once what the API refuses there is left out, and once the
    // empty-text cleanup has removed what holds no text.
    const aloneAfter = [
      { type: 'tool_result', tool_use_id: 'toolu_6', content: [search, { type: 'tool_use', id: 'inner', name: 'snap', input: {} }] },
      { type: 'tool_result', tool_use_id: 'toolu_7', content: [search, { type: 'text', text: '  ' }] },
    ];
    const altered: unknown[] = [];
    const results = build(wire, [{ role: 'user', content: [...alone, ...leftOut, ...aloneAfter] }], (block) => altered.push(block)).messages[0].content;
    expect(results[0].content).toEqual([search, search]);
    expect(results[0].content[0]).toBe(search);
    expect(results[1].content[0]).toBe(reference);
    expect(results.slice(2).map((b: any) => b.content.map((c: any) => c.type))).toEqual([['text'], ['image'], [], ['search_result'], ['search_result']]);
    expect(altered).toEqual([...leftOut, aloneAfter[0], aloneAfter[1].content[1]]);
  });

  it("sends a browser state only in a browser toolset member's result, one at most, and only text and images beside it", () => {
    const browser = { type: 'browser_state', tabs: [{ tab_id: 't1', title: 'tab', url: 'https://example.com/', active: true }] };
    const member = { type: 'tool_result', tool_use_id: 'toolu_1', toolset_name: 'browser', content: [
      browser,
      { type: 'text', text: 'page' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
    ] };
    const withDocument = { type: 'tool_result', tool_use_id: 'toolu_2', toolset_name: 'browser', content: [
      browser,
      { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'note' } },
    ] };
    const twice = { type: 'tool_result', tool_use_id: 'toolu_3', toolset_name: 'browser', content: [browser, { type: 'browser_state', tabs: [] }] };
    const custom = { type: 'tool_result', tool_use_id: 'toolu_4', content: [{ type: 'text', text: 'page' }, browser] };
    const altered: unknown[] = [];
    const results = build(wire, [{ role: 'user', content: [member, withDocument, twice, custom] }], (block) => altered.push(block)).messages[0].content;
    expect(results.map((b: any) => b.content.map((c: any) => c.type))).toEqual([
      ['browser_state', 'text', 'image'],
      ['browser_state'],
      ['browser_state'],
      ['text'],
    ]);
    expect(results[0].content[0]).toBe(browser);
    expect(results[2].content[0]).toBe(browser);
    expect(altered).toEqual([withDocument, twice, custom]);
  });

  it('sends only text in an error result, an image there as a note, and a note for an error result left with nothing', () => {
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG }, cache_control: MARK };
    const svg = { type: 'image', source: { type: 'base64', media_type: 'image/svg+xml', data: Buffer.from('<svg/>').toString('base64') } };
    const withText = { type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: [
      { type: 'text', text: 'it failed' },
      { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'note' } },
      // No form the API takes, so left out rather than given the note.
      { type: 'image', source: {} },
      image,
    ] };
    const failed = { type: 'tool_result', tool_use_id: 'toolu_2', is_error: true, content: [
      { type: 'tool_use', id: 'inner', name: 'snap', input: {} },
      { type: 'search_result', source: 'https://example.com', title: 'r', content: [{ type: 'text', text: 'hit' }], cache_control: MARK },
      { type: 'text', text: '  ' },
    ] };
    const succeeded = { type: 'tool_result', tool_use_id: 'toolu_3', content: [{ type: 'tool_use', id: 'inner', name: 'snap', input: {} }] };
    const empty = { type: 'tool_result', tool_use_id: 'toolu_4', is_error: true, content: [] };
    const blank = { type: 'tool_result', tool_use_id: 'toolu_5', is_error: true, content: [{ type: 'text', text: ' \n' }] };
    const none = { type: 'tool_result', tool_use_id: 'toolu_6', is_error: true };
    // Data that is no image the API accepts goes as the placeholder, as it did.
    const placeholder = { type: 'tool_result', tool_use_id: 'toolu_7', is_error: true, content: [{ type: 'text', text: 'see' }, svg] };
    const altered: unknown[] = [];
    const results = build(wire, [{ role: 'user', content: [withText, failed, succeeded, empty, blank, none, placeholder] }], (block) => altered.push(block)).messages[0].content;
    expect(results[0].content).toEqual([
      { type: 'text', text: 'it failed' },
      { type: 'text', text: ERROR_IMAGE_NOTE, cache_control: MARK },
    ]);
    // What it held was all left out; the note keeps the last block's breakpoint.
    expect(results[1].content).toEqual([{ type: 'text', text: EMPTIED_ERROR_NOTE, cache_control: MARK }]);
    // An empty result that isn't an error, the API takes as it is.
    expect(results[2].content).toEqual([]);
    // One that came with nothing, or with nothing but whitespace, says so.
    expect(results[3].content).toEqual([{ type: 'text', text: NO_CONTENT_ERROR_NOTE }]);
    expect(results[4].content).toEqual([{ type: 'text', text: NO_CONTENT_ERROR_NOTE }]);
    expect(results[5].content).toEqual([{ type: 'text', text: NO_CONTENT_ERROR_NOTE }]);
    expect(results[6].content).toEqual([
      { type: 'text', text: 'see' },
      { type: 'text', text: expect.stringContaining('its data is not a JPEG, PNG, GIF or WebP image') },
    ]);
    // The cleanup removes the whitespace the builder left in place, and
    // reports it, after the builder's own reports.
    expect(altered).toEqual([withText, failed, succeeded, empty, blank, none, placeholder, failed.content[2], blank.content[0]]);

    // An image that becomes the note is reported. Under the tool_result's own
    // breakpoint, the note takes none. Text the cleanup removes is left to
    // it with its breakpoint, which the cleanup warns of.
    const imaged = { type: 'tool_result', tool_use_id: 'toolu_8', is_error: true, content: [
      { type: 'text', text: 'see' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
    ] };
    const ownMarked = { type: 'tool_result', tool_use_id: 'toolu_9', is_error: true, cache_control: MARK, content: [
      { type: 'tool_use', id: 'inner', name: 'snap', input: {} },
      { type: 'search_result', source: 'https://example.com', title: 'r', content: [{ type: 'text', text: 'hit' }], cache_control: MARK },
    ] };
    const blankMarked = { type: 'tool_result', tool_use_id: 'toolu_10', is_error: true, content: [{ type: 'text', text: ' \n', cache_control: MARK }] };
    // Left out by the source check, or as no block at all: the emptied note.
    const sourceless = { type: 'tool_result', tool_use_id: 'toolu_11', is_error: true, content: [{ type: 'image', source: {} }] };
    const holdsNull = { type: 'tool_result', tool_use_id: 'toolu_12', is_error: true, content: [null] };
    // Content that isn't an array: an empty string or null is no content,
    // which the API refuses; any other string goes as it came, whitespace too.
    const emptyString = { type: 'tool_result', tool_use_id: 'toolu_13', is_error: true, content: '' };
    const nullContent = { type: 'tool_result', tool_use_id: 'toolu_14', is_error: true, content: null };
    const failedString = { type: 'tool_result', tool_use_id: 'toolu_15', is_error: true, content: 'tool failed' };
    const blankString = { type: 'tool_result', tool_use_id: 'toolu_16', is_error: true, content: ' \n' };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const more: unknown[] = [];
    const [imagedResult, ownMarkedResult, blankMarkedResult, ...rest] = build(wire, [{ role: 'user', content: [
      imaged, ownMarked, blankMarked, sourceless, holdsNull, emptyString, nullContent, failedString, blankString,
    ] }], (block) => more.push(block)).messages[0].content;
    expect(imagedResult.content).toEqual([{ type: 'text', text: 'see' }, { type: 'text', text: ERROR_IMAGE_NOTE }]);
    expect(ownMarkedResult).toEqual({ ...ownMarked, content: [{ type: 'text', text: EMPTIED_ERROR_NOTE }] });
    expect(blankMarkedResult.content).toEqual([{ type: 'text', text: NO_CONTENT_ERROR_NOTE }]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/removed 1 cache_control marker/));
    expect(rest.map((b: any) => b.content)).toEqual([
      [{ type: 'text', text: EMPTIED_ERROR_NOTE }],
      [{ type: 'text', text: EMPTIED_ERROR_NOTE }],
      [{ type: 'text', text: NO_CONTENT_ERROR_NOTE }],
      [{ type: 'text', text: NO_CONTENT_ERROR_NOTE }],
      'tool failed',
      ' \n',
    ]);
    expect(more).toEqual([imaged, ownMarked, blankMarked, sourceless, holdsNull, emptyString, nullContent, blankMarked.content[0]]);
  });

  it('labels an image by what its bytes show, at the top and in a tool_result', () => {
    const mislabelled = () => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: PNG } });
    const [image, block] = build(wire, [{ role: 'user', content: [mislabelled(), ...result([mislabelled()])[0].content] }]).messages[0].content;
    expect(image.source.media_type).toBe('image/png');
    expect(block.content[0].source.media_type).toBe('image/png');
  });

  it('leaves out, and reports, media whose source has no type the API names, wherever it is', () => {
    const shapeless = { type: 'image', source: {} };
    const bogus = { type: 'document', source: { type: 'bogus', data: PDF } };
    const nested = { type: 'tool_result', tool_use_id: 'toolu_1', content: [
      { type: 'text', text: 'kept' },
      { type: 'image', source: { type: 'bogus', data: PNG } },
      { type: 'document', source: {} },
    ] };
    const altered: unknown[] = [];
    const request = build(wire, [{ role: 'user', content: [{ type: 'text', text: 'see' }, shapeless, bogus, nested] }], (block) => altered.push(block));
    const [message] = request.messages;
    expect(message.content.map((b: any) => b.type)).toEqual(['text', 'tool_result']);
    expect(message.content[1].content).toEqual([{ type: 'text', text: 'kept' }]);
    expect(altered).toHaveLength(3);
    expect(altered[0]).toBe(shapeless);
    expect(altered[1]).toBe(bogus);
    expect(altered[2]).toBe(nested);
  });

  it('sends a source of a type the API names that membrane doesn\'t build as it came', () => {
    const file = { type: 'file', file_id: 'file_011' };
    const text = { type: 'text', media_type: 'text/plain', data: 'hello' };
    const fileDocument = { type: 'file', file_id: 'file_012' };
    const request = build(wire, [{ role: 'user', content: [
      { type: 'image', source: file },
      { type: 'document', source: text },
      { type: 'document', source: fileDocument },
      ...result([{ type: 'image', source: file }, { type: 'document', source: text }, { type: 'document', source: fileDocument }])[0].content,
    ] }]);
    const [image, document, documentFile, block] = request.messages[0].content;
    expect(image.source).toBe(file);
    expect(document.source).toBe(text);
    expect(documentFile.source).toBe(fileDocument);
    expect(block.content.map((b: any) => b.source)).toEqual([file, text, fileDocument]);
    expect(block.content[1].source).toBe(text);
    expect(block.content[2].source).toBe(fileDocument);
  });

  it("builds a document's content source as the API takes it: text and images from their fields, anything else left out and reported", () => {
    const source = () => ({ type: 'content', media_type: 'text/plain', content: [
      { type: 'text', text: 'a', ...EXTRA },
      { type: 'image', source: { type: 'base64', data: PNG, mediaType: 'image/png' }, ...EXTRA },
      { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'x' } },
      { type: 'search_result', source: 's', title: 't', content: [{ type: 'text', text: 'x' }] },
      { type: 'image', source: {} },
      'stray',
    ] });
    const document = { type: 'document', title: 'notes', source: source() };
    const nested = { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'document', title: 'notes', source: source() }] };
    const altered: unknown[] = [];
    const [top, block] = build(wire, [{ role: 'user', content: [document, nested] }], (b) => altered.push(b)).messages[0].content;
    const expected = { type: 'content', content: [
      { type: 'text', text: 'a' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
    ] };
    expect(top.source).toEqual(expected);
    expect(block.content[0].source).toEqual(expected);
    // Each reported once, as the block handed in.
    expect(altered).toHaveLength(2);
    expect(altered[0]).toBe(document);
    expect(altered[1]).toBe(nested);
    // A content source that is a string goes as it is.
    const plain = { type: 'document', source: { type: 'content', content: 'plain notes' } };
    expect(build(wire, [{ role: 'user', content: [plain] }]).messages[0].content[0].source).toEqual({ type: 'content', content: 'plain notes' });
  });

  it('leaves out, and reports, a document whose content source holds nothing the API takes, wherever it is', () => {
    const empties = [
      { type: 'document', source: { type: 'content', content: [] } },
      { type: 'document', source: { type: 'content', content: '' } },
      { type: 'document', source: { type: 'content', content: [{ type: 'search_result', source: 's', title: 't', content: [] }, { type: 'image', source: {} }] } },
      { type: 'document', source: { type: 'content' } },
    ];
    const nested = { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'kept' }, ...empties] };
    const altered: unknown[] = [];
    const [message] = build(wire, [{ role: 'user', content: [{ type: 'text', text: 'see' }, ...empties, nested] }], (b) => altered.push(b)).messages;
    expect(message.content.map((b: any) => b.type)).toEqual(['text', 'tool_result']);
    expect(message.content[1].content).toEqual([{ type: 'text', text: 'kept' }]);
    expect(altered).toHaveLength(empties.length + 1);
    empties.forEach((empty, i) => expect(altered[i]).toBe(empty));
    expect(altered.at(-1)).toBe(nested);
  });

  it("keeps a breakpoint in a document's content source only on its last block, only when the document has none, and in a tool_result only where the document's own would stay", () => {
    const doc = (marks: number[], own = false) => ({
      type: 'document', title: 'notes', ...(own ? { cache_control: MARK } : {}),
      source: { type: 'content', content: [0, 1, 2].map((i) => ({ type: 'text', text: `part ${i}`, ...(marks.includes(i) ? { cache_control: MARK } : {}) })) },
    });
    const marks = (d: any) => [d.cache_control, ...d.source.content.map((b: any) => b.cache_control)];
    const atTop = (d: object) => build(wire, [{ role: 'user', content: [d] }]).messages[0].content[0];
    expect(marks(atTop(doc([0, 1, 2])))).toEqual([undefined, undefined, undefined, MARK]);
    expect(marks(atTop(doc([0, 2], true)))).toEqual([MARK, undefined, undefined, undefined]);
    // In a tool_result, the API takes the source's last breakpoint as the document's own.
    expect(marks(built(wire, [{ type: 'text', text: 'a' }, doc([1, 2])])[1])).toEqual([undefined, undefined, undefined, MARK]);
    expect(marks(built(wire, [doc([2]), { type: 'text', text: 'b' }])[0])).toEqual([undefined, undefined, undefined, undefined]);
    expect(marks(built(wire, [doc([2])], { cache_control: MARK })[0])).toEqual([undefined, undefined, undefined, undefined]);
    // The caller's document keeps its breakpoints.
    const given = doc([0, 2], true);
    atTop(given);
    built(wire, [given, { type: 'text', text: 'b' }]);
    expect(marks(given)).toEqual([MARK, MARK, undefined, MARK]);
    // An error result's note stands in for a document whose source's last
    // block carried the breakpoint, as for any block it held.
    expect(built(wire, [doc([2])], { is_error: true })).toEqual([{ type: 'text', text: EMPTIED_ERROR_NOTE, cache_control: MARK }]);
  });

  it("reads a content source as it will be built: the last block it takes keeps the breakpoint, and a null or an image the API doesn't take reports its document, while one built as given reports nothing", () => {
    const svg = Buffer.from('<svg/>').toString('base64');
    const search = { type: 'search_result', source: 's', title: 't', content: [{ type: 'text', text: 'x' }] };
    const source = (content: unknown[]) => ({ type: 'document', source: { type: 'content', content } });
    // The last block that ships keeps its breakpoint, though one the build
    // leaves out comes after it.
    expect(built(wire, [source([{ type: 'text', text: 'a', cache_control: MARK }, search])])[0].source.content)
      .toEqual([{ type: 'text', text: 'a', cache_control: MARK }]);
    // An error result's note takes the breakpoint the build would keep, and
    // not that of a block it would leave out.
    expect(built(wire, [source([{ type: 'text', text: 'a', cache_control: MARK }, search])], { is_error: true }))
      .toEqual([{ type: 'text', text: EMPTIED_ERROR_NOTE, cache_control: MARK }]);
    expect(built(wire, [source([{ type: 'text', text: 'a' }, { ...search, cache_control: MARK }])], { is_error: true }))
      .toEqual([{ type: 'text', text: EMPTIED_ERROR_NOTE }]);
    const withNull = source([null, { type: 'text', text: 'a' }]);
    const withSvg = source([{ type: 'text', text: 'a' }, { type: 'image', source: { type: 'base64', media_type: 'image/svg+xml', data: svg }, cache_control: MARK }]);
    const plain = source([{ type: 'text', text: 'as given' }]);
    const altered: unknown[] = [];
    const [nullDocument, svgDocument, plainDocument] = build(wire, [{ role: 'user', content: [withNull, withSvg, plain] }], (b) => altered.push(b)).messages[0].content;
    expect(nullDocument.source.content).toEqual([{ type: 'text', text: 'a' }]);
    expect(svgDocument.source.content.map((b: any) => [b.type, b.cache_control])).toEqual([['text', undefined], ['text', MARK]]);
    expect(plainDocument).toEqual(plain);
    expect(altered).toHaveLength(2);
    expect(altered[0]).toBe(withNull);
    expect(altered[1]).toBe(withSvg);
  });

  it("keeps a document's own title over its filename", () => {
    const [document] = build(wire, [{ role: 'user', content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PDF }, title: 'Q3 report', filename: 'q3.pdf' },
    ] }]).messages[0].content;
    expect(document.title).toBe('Q3 report');
  });

  it("keeps a breakpoint inside a tool_result only on its content's last block, and only when the tool_result has none", () => {
    const content = [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG }, cache_control: MARK },
      { type: 'text', text: 'a', cache_control: MARK },
      { type: 'text', text: 'b', cache_control: null },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PDF }, cache_control: MARK },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG }, cache_control: MARK },
    ];
    const kept = built(wire, content);
    expect(kept.map((b: any) => b.cache_control)).toEqual([undefined, undefined, null, undefined, MARK]);
    // A block whose breakpoint is left out is a copy, which names the block
    // handed in; the caller's block keeps its breakpoint.
    expect(blockBuiltFrom(kept[1])).toBe(content[1]);
    expect(content[1].cache_control).toEqual(MARK);
    // The last block that ships: the empty-text cleanup removes text with
    // nothing in it after the build.
    expect(built(wire, [
      { type: 'text', text: 'a', cache_control: MARK },
      { type: 'text', text: '  ' },
    ])).toEqual([{ type: 'text', text: 'a', cache_control: MARK }]);
    // Under the tool_result's own breakpoint, the API takes none in its content.
    expect(built(wire, [
      { type: 'text', text: 'a' },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PDF }, cache_control: MARK },
    ], { cache_control: MARK }).map((b: any) => b.cache_control)).toEqual([undefined, undefined]);
    // A breakpoint of null is none, so it doesn't stop the content's last one.
    expect(built(wire, [{ type: 'text', text: 'a', cache_control: MARK }], { cache_control: null })[0].cache_control).toEqual(MARK);
    // An image whose data the API doesn't accept goes as the placeholder text
    // with the breakpoint it would have had.
    const placeholders = built(wire, [
      { type: 'image', source: { type: 'base64', media_type: 'image/svg+xml', data: Buffer.from('<svg/>').toString('base64') }, cache_control: MARK },
      { type: 'image', source: { type: 'base64', media_type: 'image/svg+xml', data: Buffer.from('<svg/>').toString('base64') }, cache_control: MARK },
    ]);
    expect(placeholders.map((b: any) => [b.type, b.cache_control])).toEqual([['text', undefined], ['text', MARK]]);
  });

  it('names the block handed in when its cleanup drops one the build copied, at the top and in a tool_result', () => {
    // A breakpoint with a ttl makes Bedrock's last step copy the block again.
    const whitespace = { type: 'text', text: '  ', annotations: { audience: ['user'] }, cache_control: { type: 'ephemeral', ttl: '1h' } };
    const nested = { type: 'text', text: ' ', cache_control: { type: 'ephemeral', ttl: '1h' } };
    const altered: unknown[] = [];
    build(wire, [{ role: 'user', content: [
      { type: 'text', text: 'hi' },
      whitespace,
      ...result([{ type: 'text', text: 'kept' }, nested])[0].content,
    ] }], (block) => altered.push(block));
    expect(altered).toHaveLength(2);
    expect(altered[0]).toBe(whitespace);
    expect(altered[1]).toBe(nested);
  });

  it("names the caller's own block for one MCP's conversion copied, at the top and in a tool_result", () => {
    const top = { type: 'image', data: PNG, mimeType: 'image/png' };
    const inner = { type: 'image', data: PNG, mimeType: 'image/png', annotations: { audience: ['user'] } };
    const request = build(wire, [{ role: 'user', content: [top, ...result([{ type: 'text', text: 'shot' }, inner])[0].content] }]);
    const [image, block] = request.messages[0].content;
    expect(blockBuiltFrom(image)).toBe(top);
    expect(blockBuiltFrom(block.content[1])).toBe(inner);
  });
});

describe('the wires that differ', () => {
  it('Bedrock leaves out cache_control.ttl at the top and on every kind of block inside a tool_result; Anthropic keeps it', () => {
    const ttl = { type: 'ephemeral', ttl: '1h' };
    const svg = Buffer.from('<svg/>').toString('base64');
    const lasts = [
      { type: 'text', text: 'nested', cache_control: ttl },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PDF }, cache_control: ttl },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG }, cache_control: ttl },
      { type: 'image', source: { type: 'base64', media_type: 'image/svg+xml', data: svg }, cache_control: ttl },
      { type: 'search_result', source: 'https://example.com', title: 'r', content: [{ type: 'text', text: 'hit' }], cache_control: ttl },
      { type: 'tool_reference', tool_name: 'snap', cache_control: ttl },
      { type: 'browser_state', tabs: [{ tab_id: 't1', title: 'tab', url: 'https://example.com/', active: true }], cache_control: ttl },
    ];
    // Each one the last block of a tool_result of its own, where a breakpoint
    // goes: a browser state's, a browser toolset member's. Last, an error
    // result whose note takes the breakpoint of the document it stands in for.
    const messages = () => [{ role: 'user', content: [
      { type: 'text', text: 'see', cache_control: ttl },
      ...lasts.map((last, i) => ({
        type: 'tool_result', tool_use_id: `toolu_${i}`, ...(last.type === 'browser_state' ? { toolset_name: 'browser' } : {}), content: [last],
      })),
      { type: 'tool_result', tool_use_id: 'toolu_error', is_error: true, content: [lasts[1]] },
    ] }];
    const [bedrockText, ...bedrockResults] = build('Bedrock', messages()).messages[0].content;
    expect(bedrockText.cache_control).toEqual(MARK);
    expect(bedrockResults.map((b: any) => b.content[0].cache_control)).toEqual([...lasts.map(() => MARK), MARK]);
    expect(bedrockResults.at(-1).content[0].text).toBe(EMPTIED_ERROR_NOTE);
    const [, ...anthropicResults] = build('Anthropic', messages()).messages[0].content;
    expect(anthropicResults.map((b: any) => b.content[0].cache_control)).toEqual([...lasts.map(() => ttl), ttl]);
  });

  // Every request here is one main sent, and sent with these bytes.
  it('lays out each block as its wire\'s adapter always did, so a request that went out before keeps its bytes', () => {
    const image = (source: object) => ({ type: 'image', source });
    const wireFirst = { type: 'base64', media_type: 'image/png', data: PNG };
    const dataFirst = { type: 'base64', data: PNG, media_type: 'image/png' };
    const membraneForm = { type: 'base64', data: PNG, mediaType: 'image/png' };
    const document = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PDF } };
    const dataUrl = { type: 'url', url: `data:image/png;base64,${PNG}` };
    const messages = () => [{ role: 'user', content: [
      // NativeFormatter builds an image's source media_type first.
      image(wireFirst), image(dataFirst), image(membraneForm), document, image(dataUrl),
      { type: 'tool_result', tool_use_id: 'toolu_1', content: [
        image(wireFirst), image(dataFirst), image(membraneForm), { text: 'given in its own order', type: 'text' }, image(dataUrl),
      ] },
    ] }];
    const sent = (wire: Wire) => build(wire, messages()).messages[0].content.map((b: unknown) => JSON.stringify(b));
    const asSent = (blocks: unknown[]) => blocks.map((b) => JSON.stringify(b));
    // Anthropic's adapter set media_type in place at the top and built a
    // tool_result's content afresh in the API's own order.
    expect(sent('Anthropic')).toEqual(asSent([
      image(wireFirst), image(dataFirst), image(dataFirst), document, image(wireFirst),
      { type: 'tool_result', tool_use_id: 'toolu_1', content: [
        image(wireFirst), image(wireFirst), image(wireFirst), { type: 'text', text: 'given in its own order' }, image(wireFirst),
      ] },
    ]));
    // Bedrock's put an image's media_type last, at the top and in a
    // tool_result, and sent everything else in its own order. Both built a
    // data: URL's image as base64 data with media_type first.
    expect(sent('Bedrock')).toEqual(asSent([
      image(dataFirst), image(dataFirst), image(dataFirst), document, image(wireFirst),
      { type: 'tool_result', tool_use_id: 'toolu_1', content: [
        image(dataFirst), image(dataFirst), image(dataFirst), { text: 'given in its own order', type: 'text' }, image(wireFirst),
      ] },
    ]));
  });

  it("lays out a document's content source as each wire's adapter sent it, and Bedrock leaves out a ttl there", () => {
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } };
    const given = { title: 'notes', type: 'document', source: { content: [{ text: 'a', type: 'text' }, image], type: 'content' } };
    // Bedrock's adapter sent a tool_result's content source as it came.
    expect(JSON.stringify(built('Bedrock', [given]))).toBe(JSON.stringify([given]));
    // Anthropic's left a tool_result's document out, and it now goes in the
    // API's own key order.
    expect(JSON.stringify(built('Anthropic', [given]))).toBe(JSON.stringify([
      { type: 'document', source: { type: 'content', content: [{ type: 'text', text: 'a' }, image] }, title: 'notes' },
    ]));
    const ttl = { type: 'ephemeral', ttl: '1h' };
    const marked = { type: 'document', source: { type: 'content', content: [{ type: 'text', text: 'a', cache_control: ttl }] } };
    expect(built('Bedrock', [marked])[0].source.content[0].cache_control).toEqual(MARK);
    expect(built('Anthropic', [marked])[0].source.content[0].cache_control).toEqual(ttl);
    // And at the top of a message.
    const top = (wire: Wire) => build(wire, [{ role: 'user', content: [marked] }]).messages[0].content[0];
    expect(top('Bedrock').source.content[0].cache_control).toEqual(MARK);
    expect(top('Anthropic').source.content[0].cache_control).toEqual(ttl);
  });

  it("toAnthropicContent sends a tool_result's document, which it used to leave out, in the API's key order", () => {
    const [block] = toAnthropicContent([{ type: 'tool_result', toolUseId: 'toolu_1', content: [
      { type: 'text', text: 'see' },
      { type: 'image', source: { type: 'base64', data: PNG, mediaType: 'image/png' } },
      { type: 'document', source: { type: 'base64', mediaType: 'application/pdf', data: PDF }, filename: 'a.pdf' },
      { type: 'tool_use', id: 'inner', name: 'snap', input: {} },
    ] } as ContentBlock]) as any[];
    expect(JSON.stringify(block.content)).toBe(JSON.stringify([
      { type: 'text', text: 'see' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PDF }, title: 'a.pdf' },
    ]));
    const [failed, imaged, empty, plain] = toAnthropicContent([
      { type: 'tool_result', toolUseId: 'toolu_2', isError: true, content: [{ type: 'tool_use', id: 'inner', name: 'snap', input: {} }] },
      { type: 'tool_result', toolUseId: 'toolu_3', isError: true, content: [{ type: 'image', source: { type: 'base64', data: PNG, mediaType: 'image/png' } }] },
      { type: 'tool_result', toolUseId: 'toolu_4', isError: true, content: '' },
      { type: 'tool_result', toolUseId: 'toolu_5', content: 'done' },
    ] as ContentBlock[]) as any[];
    expect(failed.content).toEqual([{ type: 'text', text: EMPTIED_ERROR_NOTE }]);
    expect(imaged.content).toEqual([{ type: 'text', text: ERROR_IMAGE_NOTE }]);
    expect(empty.content).toEqual([{ type: 'text', text: NO_CONTENT_ERROR_NOTE }]);
    expect(plain.content).toBe('done');
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
        // An MCP text block, and an image in membrane's form with fields of its own.
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
