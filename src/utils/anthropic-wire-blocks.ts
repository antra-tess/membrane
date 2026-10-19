/**
 * Content blocks as the Anthropic Messages API takes them, for the two
 * adapters that send its wire: AnthropicAdapter and BedrockAdapter. Bedrock
 * is taken to accept what the Messages API does here, which nobody has run
 * against Bedrock itself; what it refuses beyond that (`cache_control.ttl`)
 * is its adapter's own last step (`finish`).
 *
 * The API refuses a block that carries a field it doesn't define ("Extra
 * inputs are not permitted"). A block in a conversation's history goes out
 * with every later request, so one stray field gets them all refused. Fields
 * reach a block from many places: MCP's `annotations` and `_meta`, membrane's
 * own (`sourceUrl`, `tokenEstimate`, `rawItem`, a tool call's `rawXml`), and
 * whatever a host stores beside them. So each block type the API defines and
 * membrane uses (text, image, document, tool_use, tool_result, thinking and
 * redacted_thinking) is built from the API's whole list of fields for that
 * type, and anything else on the block stays behind. A block of another
 * type, such as a server-tool block the API produced, goes as it came. So
 * does audio, video or a generated image, which the API has no block for.
 *
 * An image's or a document's source is of a type the API names for it, or
 * the block has no form the API takes: one whose source has another type, or
 * none, or that has no source object at all, is left out and reported,
 * wherever it is. A source of a type the API names that membrane doesn't
 * build, such as a file id, goes as it came.
 *
 * A document's content source holds blocks of its own, and the API takes
 * only text and images there ("does not match any of the expected tags:
 * 'text', 'image'"), so they are built as text and images are anywhere, and
 * anything else there is left out and reported. A content source with
 * nothing the API takes in it, an empty string or no such block, gives its
 * document no form the API takes ("document content cannot be empty"). The
 * API takes a cache breakpoint there on the source's last block only, and on
 * none when the document carries its own ("Instead, place it directly on
 * `document`"), so one anywhere else stays behind. It takes that one as the
 * document's own, so inside a tool_result the rules below read it as the
 * document's.
 *
 * Inside a tool_result, the API takes six block types, as its own refusal of
 * any other lists them: text, image, document, search_result, tool_reference
 * and browser_state. Text, images and documents are built as at the top of a
 * message, and the other three aren't membrane's and go as they came. The
 * API states further rules that the tool_result itself decides, and each is
 * applied here: a search result or a tool reference only in content all of
 * its own type; a browser state only in the result of a browser toolset
 * member, as its `toolset_name` says, and one at most; such a result
 * carries only text, images and browser states; and an error result carries
 * only text, so an image there goes as a note saying so, as membrane sends
 * text for an image it can't send. A block one of these rules leaves out, or
 * of any other type, is left out and reported. The API takes no error result
 * without content, so one that would go with none carries a note saying why:
 * that what it held was left out, or that it came with nothing. The API takes
 * a cache breakpoint there on the content's last block only, and on none when
 * the tool_result carries its own, so a breakpoint anywhere else stays
 * behind, whatever the block's type. Each of these rules reads the content
 * as it will ship: text the empty-text cleanup removes (utils/empty-text.ts),
 * which runs after the build in both buildRequests, counts toward none of
 * them, and is left in place, its breakpoint with it, for the cleanup to
 * remove and report. (toAnthropicContent cleans its blocks before building
 * them.)
 *
 * Membrane's own spellings become the wire's: a base64 source's `mediaType`
 * becomes `media_type`, and a document's `filename` becomes its `title`
 * unless it has one. An image's data is decided by imageForRequest, as
 * everywhere a request carries one: it goes labelled by what its bytes show,
 * or as the placeholder text when it's no image the API accepts. The
 * placeholder keeps the image's cache breakpoint, as the image would have.
 *
 * A request that succeeds today goes out with the same bytes, so prompt
 * caches keep their prefixes, except where Anthropic's wire now sends what
 * its adapter used to leave out of a tool_result
 * (changelog.d/161-wire-fields.changed.md). That is what this module builds
 * from what it's handed: the fallback breakpoints on the system prompt and
 * the tool list are decided before the build, by the breakpoint budget's
 * count (utils/cache-marker-budget.ts), which a breakpoint in a document's
 * content source now joins. Each wire lays a block out as its adapter always
 * did: in the block's own key order, except a tool_result's content on
 * Anthropic's wire, which its adapter built in the API's own order
 * (`nestedInApiOrder`), and an image's base64 source on Bedrock's, whose
 * adapter put `media_type` last (`imageMediaTypeLast`), but in a document's
 * content source, which it sent as it came. An image given as a data: URL
 * goes as base64 data with `media_type` first on both, as both adapters
 * built it.
 */

import { hasNonEmptyText } from './empty-text.js';
import { imageForRequest, urlImageForRequest } from './image-media.js';
import { convertMcpMedia, isSourcelessMedia } from './mcp-media.js';

type Block = Record<string, unknown>;

/** The Messages API's fields for each block type built here: its whole list,
 *  as `@anthropic-ai/sdk` 0.126's `*BlockParam` types give them, each checked
 *  against the API itself (count_tokens). The SDK this repository pins is
 *  older, and its types lack some of them, such as an image's
 *  `transformations` and `toolset_name`. */
const FIELDS = new Map<unknown, readonly string[]>([
  ['text', ['type', 'text', 'cache_control', 'citations']],
  ['image', ['type', 'source', 'cache_control', 'transformations']],
  ['document', ['type', 'source', 'cache_control', 'citations', 'context', 'title']],
  ['tool_use', ['type', 'id', 'name', 'input', 'cache_control', 'caller', 'toolset_name']],
  ['tool_result', ['type', 'tool_use_id', 'cache_control', 'content', 'is_error', 'toolset_name']],
  ['thinking', ['type', 'thinking', 'signature']],
  ['redacted_thinking', ['type', 'data']],
]);

/** The block types the API takes inside a tool_result's content, as its own
 *  refusal of any other lists them, but browser_state, which it takes only in
 *  a toolset member's result (TOOLSET_CONTENT_TYPES). */
const TOOL_RESULT_CONTENT_TYPES: ReadonlySet<unknown> = new Set([
  'text', 'image', 'document', 'search_result', 'tool_reference',
]);

/** The block types a toolset member's result takes instead, by the toolset
 *  name its `toolset_name` carries (the API holds it to its tool_use's), as
 *  the API's refusals state them: "browser_toolset_20260801 member
 *  tool_result content must be image, text, or browser_state blocks only",
 *  and "a browser_state block is only accepted on a tool_result answering a
 *  browser toolset member tool_use". */
const TOOLSET_CONTENT_TYPES = new Map<unknown, ReadonlySet<unknown>>([
  ['browser', new Set(['text', 'image', 'browser_state'])],
]);

/** The block types an error result's content takes: "all content must be
 *  type `text` if `is_error` is true". An image there goes as
 *  ERROR_IMAGE_NOTE, as membrane sends text for an image it can't send. */
const ERROR_CONTENT_TYPES: ReadonlySet<unknown> = new Set(['text']);

/** An image in an error result, as the text the API takes there. Constant,
 *  so a history that holds it keeps its bytes. */
const ERROR_IMAGE_NOTE =
  '[system: an image in this tool result was NOT shown to you — a tool error reaches this model as text only. You are not seeing this image.]';

/** What an error result carries when what it holds was all left out here,
 *  since the API refuses one with no content ("content cannot be empty if
 *  `is_error` is true"). */
const EMPTIED_ERROR_NOTE =
  '[system: what the tool returned with this error was NOT shown to you — none of it is content this request can carry.]';

/** What an error result carries when it came with no content, so a model
 *  doesn't look for something that was never there. */
const NO_CONTENT_ERROR_NOTE = '[system: this tool error came with no content.]';

/** Whether `block` ships: the empty-text cleanup (utils/empty-text.ts), which
 *  runs after the build, removes text with nothing but whitespace in it. */
function ships(block: Block): boolean {
  return block.type !== 'text' || hasNonEmptyText(block.text);
}

/** The block types the API takes in a tool_result only in content that is
 *  all of their own type: "if any blocks in a tool result are of type
 *  `search_result`, all blocks must be of that type", and a `tool_reference`
 *  "cannot be mixed with other content". */
const ALONE_TYPES: ReadonlySet<unknown> = new Set(['search_result', 'tool_reference']);

/** The source types the API names for an image and for a document, at the
 *  top of a message and inside a tool_result alike: its whole lists, as its
 *  refusal of any other names them ("does not match any of the expected
 *  tags"). */
const SOURCE_TYPES = new Map<unknown, ReadonlySet<unknown>>([
  ['image', new Set(['base64', 'file', 'url'])],
  ['document', new Set(['base64', 'content', 'file', 'text', 'url'])],
]);

/** The block types the API takes in a document's content source, as its
 *  refusal of any other lists them. */
const CONTENT_SOURCE_TYPES: ReadonlySet<unknown> = new Set(['text', 'image']);

/** A content source's fields: its whole list, as the API's refusal of any
 *  other ("Extra inputs are not permitted") holds it. */
const CONTENT_SOURCE_FIELDS: readonly string[] = ['type', 'content'];

/** Media with no form the API takes (see the module doc): media with no
 *  source object, an image or a document whose source is of no type the API
 *  names for it, or a document whose content source holds nothing the API
 *  takes there. */
function hasNoWireForm(block: Block): boolean {
  if (isSourcelessMedia(block)) return true;
  const types = SOURCE_TYPES.get(block.type);
  if (types === undefined) return false;
  const source = block.source as Block;
  if (!types.has(source.type)) return true;
  return block.type === 'document' && source.type === 'content' && holdsNothing(source);
}

/** Whether `item` is a block a document's content source can carry: text, or
 *  an image with a form the API takes. */
function takenInContentSource(item: unknown): item is Block {
  return isRecord(item) && CONTENT_SOURCE_TYPES.has(item.type) && !hasNoWireForm(item);
}

/** Whether a content source would go with nothing in it: an empty string, or
 *  no block the API takes there. */
function holdsNothing(source: Block): boolean {
  if (typeof source.content === 'string') return source.content === '';
  return !Array.isArray(source.content) || !source.content.some(takenInContentSource);
}

/** A document's content source's blocks, if it has a content source holding
 *  an array of them. */
function contentSourceBlocks(block: Block): unknown[] | undefined {
  if (block.type !== 'document' || !isRecord(block.source)) return undefined;
  const source = block.source;
  return source.type === 'content' && Array.isArray(source.content) ? source.content : undefined;
}

/** Each built block's original, for a report about it made after the build
 *  (blockBuiltFrom). Weak, so it holds nothing past the request. */
const handedIn = new WeakMap<object, unknown>();

function isRecord(value: unknown): value is Block {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `block`'s own fields among `fields`: in its own order, or in `fields`'
 *  order with `apiOrder`. */
function pick(block: Block, fields: readonly string[], apiOrder: boolean): Block {
  const out: Block = {};
  for (const key of apiOrder ? fields : Object.keys(block)) {
    if (fields.includes(key) && Object.hasOwn(block, key)) out[key] = block[key];
  }
  return out;
}

/** How a wire lays out what it sends, as its adapter always laid it out, so a
 *  request that went out before keeps its bytes. */
interface Layout {
  /** A block's fields in the API's own order, rather than the block's. */
  apiOrder: boolean;
  /** An image's base64 source with `media_type` after its other fields,
   *  rather than where the source had it. */
  imageMediaTypeLast: boolean;
}

/** A source in a form membrane uses, as the API takes it: base64 data with
 *  its `media_type` (`mediaType` in membrane's spelling, or `label` when
 *  given), or a URL. A source of another form, such as a file id, goes as it
 *  came. */
function wireSource(source: Block, apiOrder: boolean, options: { label?: unknown; mediaTypeLast?: boolean } = {}): Block {
  if (source.type === 'url') return pick(source, ['type', 'url'], apiOrder);
  if (source.type !== 'base64') return source;
  const mediaType = options.label ?? source.media_type ?? source.mediaType;
  if (apiOrder) return { type: 'base64', ...(mediaType !== undefined ? { media_type: mediaType } : {}), data: source.data };
  // Set in place, so a wire-shaped source keeps its key order and one in
  // membrane's spelling gains a trailing media_type; or set last.
  const built = pick(source, options.mediaTypeLast ? ['type', 'data'] : ['type', 'media_type', 'data'], false);
  if (mediaType !== undefined) built.media_type = mediaType;
  return built;
}

/** An image with `fields`, its data decided by imageForRequest, or the
 *  placeholder text, with the image's cache breakpoint, when the data is no
 *  image the API accepts. `onPlaceholder` hears each placeholder. */
function wireImage(block: Block, fields: readonly string[], onPlaceholder: () => void, layout: Layout): Block {
  const built = pick(block, fields, layout.apiOrder);
  const source = block.source as Block;
  const placeholder = (note: Block): Block => {
    onPlaceholder();
    return block.cache_control ? { ...note, cache_control: block.cache_control } : note;
  };
  if (source.type === 'url') {
    // A data: URL holds its image inline, so it goes as base64 data labelled
    // by its header, or as the placeholder. Any other URL is the API's to
    // fetch.
    const image = urlImageForRequest(source.url as string);
    if (image.placeholder) return placeholder(image.placeholder);
    built.source = image.data
      ? { type: 'base64', media_type: image.mediaType, data: image.data }
      : wireSource(source, layout.apiOrder);
    return built;
  }
  if (source.type !== 'base64') return built;
  const image = imageForRequest(source.data, source.media_type ?? source.mediaType);
  if (image.placeholder) return placeholder(image.placeholder);
  built.source = wireSource(source, layout.apiOrder, { label: image.mediaType, mediaTypeLast: layout.imageMediaTypeLast });
  return built;
}

/** A document as the API takes it. `onAltered` hears each block its content
 *  source loses, and each image there that goes as the placeholder. */
function wireDocument(block: Block, layout: Layout, onAltered: () => void, finish: Finish): Block {
  const built = pick(block, FIELDS.get('document')!, layout.apiOrder);
  const source = block.source as Block;
  built.source = source.type === 'content'
    ? wireContentSource(source, hasMarker(block), onAltered, finish, layout)
    : wireSource(source, layout.apiOrder);
  if (built.title === undefined && typeof block.filename === 'string' && block.filename !== '') {
    built.title = block.filename;
  }
  return built;
}

/** A content source as the API takes it (see the module doc): a string as it
 *  is, or its blocks built as text and images, anything else left out, and a
 *  breakpoint kept only on the last block, and there only when the document
 *  carries none (`documentMarked`). */
function wireContentSource(
  source: Block,
  documentMarked: boolean,
  onAltered: () => void,
  finish: Finish,
  layout: Layout,
): Block {
  const built = pick(source, CONTENT_SOURCE_FIELDS, layout.apiOrder);
  if (!Array.isArray(source.content)) return built;
  // Bedrock's adapter sent a content source as it came, so an image there
  // keeps its source's own layout rather than Bedrock's media_type last.
  const inner: Layout = { apiOrder: layout.apiOrder, imageMediaTypeLast: false };
  const blocks = source.content.flatMap((item) => {
    if (!takenInContentSource(item)) {
      onAltered();
      return [];
    }
    const block = item.type === 'image'
      ? wireImage(item, FIELDS.get('image')!, onAltered, inner)
      : pick(item, FIELDS.get('text')!, inner.apiOrder);
    return [{ block, original: item }];
  });
  built.content = blocks.map(({ block, original }, index) => finish(
    hasMarker(block) && (index < blocks.length - 1 || documentMarked) ? withoutOwnMarker(block) : block,
    original,
  ));
  return built;
}

/** Each step after a block is built, given the block the caller handed in. */
type Finish = (built: Block, handedIn: Block) => Block;

/** Whether `block` carries a cache breakpoint: a `cache_control` that isn't
 *  null, which the API takes as none. */
function hasMarker(block: Block): boolean {
  return block.cache_control !== undefined && block.cache_control !== null;
}

/** `block` without its own `cache_control`. */
function withoutOwnMarker(block: Block): Block {
  const { cache_control: _marker, ...rest } = block;
  return rest;
}

/** The cache breakpoint `block` carries, if any: its own, or, for a
 *  document, the one on the last block of its content source that the build
 *  takes, which the API takes as the document's own. */
function breakpointOf(block: Block): unknown {
  if (hasMarker(block)) return block.cache_control;
  const last = contentSourceBlocks(block)?.filter(takenInContentSource).at(-1);
  return last !== undefined && hasMarker(last) ? last.cache_control : undefined;
}

/** `block` without the breakpoint breakpointOf finds: its own, and its
 *  content source's last block's. It is given built blocks, whose content
 *  source holds only blocks the build takes, so its last block is the one
 *  breakpointOf reads. */
function withoutBreakpoint(block: Block): Block {
  const out = hasMarker(block) ? withoutOwnMarker(block) : block;
  const blocks = contentSourceBlocks(out);
  const last = blocks?.at(-1);
  if (!blocks || !isRecord(last) || !hasMarker(last)) return out;
  return { ...out, source: { ...(out.source as Block), content: [...blocks.slice(0, -1), withoutOwnMarker(last)] } };
}

/** A tool_result's content as the API takes it there (see the module doc).
 *  `given` is the content the caller handed in, place for place with
 *  `content`, which is `given` with MCP's media converted. `result` is the
 *  tool_result as built, whose own `cache_control`, `toolset_name` and
 *  `is_error` the rules read. `onAltered` hears each block left out, and each
 *  image that goes as the placeholder. */
function toolResultContent(
  content: readonly unknown[],
  given: readonly unknown[],
  result: Block,
  onAltered: () => void,
  finish: Finish,
  layout: Layout,
): unknown[] {
  const error = result.is_error === true;
  const types = error ? ERROR_CONTENT_TYPES : TOOLSET_CONTENT_TYPES.get(result.toolset_name) ?? TOOL_RESULT_CONTENT_TYPES;
  let leftOut = false;
  const leaveOut = () => {
    leftOut = true;
    onAltered();
  };
  const taken: Array<{ block: Block; original: Block }> = [];
  content.forEach((item, index) => {
    if (!isRecord(item) || hasNoWireForm(item)) {
      leaveOut();
      return;
    }
    // An image in an error result goes as text, the one type taken there.
    const block = error && item.type === 'image' ? errorImage(item, onAltered, layout) : item;
    if (!types.has(block.type)) {
      leaveOut();
      return;
    }
    taken.push({ block, original: (given[index] ?? item) as Block });
  });
  // The rules read the content as it will ship, without the text the
  // empty-text cleanup removes.
  const mixed = new Set(taken.filter(({ block }) => ships(block)).map(({ block }) => block.type)).size > 1;
  // The API takes "at most one browser_state block per tool_result": the
  // first one stays.
  let browserStates = 0;
  const built = taken.flatMap(({ block, original }) => {
    if ((mixed && ALONE_TYPES.has(block.type)) || (block.type === 'browser_state' && ++browserStates > 1)) {
      leaveOut();
      return [];
    }
    return [{ block: nestedBlock(block, onAltered, finish, layout), original }];
  });
  // The API takes a breakpoint inside a tool_result on the content's last
  // block only, and on none when the tool_result carries its own. A block the
  // cleanup will remove keeps its own, for the cleanup to report with it.
  let lastShipped = built.length - 1;
  while (lastShipped >= 0 && !ships(built[lastShipped]!.block)) lastShipped--;
  const sent = built.map(({ block, original }, index) => {
    const keepsMarker = !ships(block) || (index === lastShipped && !hasMarker(result));
    if (keepsMarker || breakpointOf(block) === undefined) return finish(block, original);
    return finish(withoutBreakpoint(block), original);
  });
  if (!error || lastShipped >= 0) return sent;
  // An error result that would go with no content, which the API refuses,
  // carries a note saying why, after the text the cleanup will remove. The
  // note stands in for what was left out, so it takes the breakpoint of the
  // last block it held, left out or not, other than text the cleanup
  // removes, as a placeholder takes its image's.
  onAltered();
  const last = [...content].reverse().find((item): item is Block => isRecord(item) && ships(item));
  const note: Block = { type: 'text', text: leftOut ? EMPTIED_ERROR_NOTE : NO_CONTENT_ERROR_NOTE };
  const breakpoint = last === undefined ? undefined : breakpointOf(last);
  if (breakpoint !== undefined && !hasMarker(result)) note.cache_control = breakpoint;
  return [...sent, finish(note, note)];
}

/** An image in an error result as text: the placeholder, when its data is no
 *  image the API accepts, as it always went; otherwise ERROR_IMAGE_NOTE. Each
 *  keeps the image's cache breakpoint. `onPlaceholder` hears either. */
function errorImage(block: Block, onPlaceholder: () => void, layout: Layout): Block {
  const built = wireImage(block, FIELDS.get('image')!, onPlaceholder, layout);
  if (built.type !== 'image') return built;
  onPlaceholder();
  const note: Block = { type: 'text', text: ERROR_IMAGE_NOTE };
  return block.cache_control ? { ...note, cache_control: block.cache_control } : note;
}

/** One block of a tool_result's content, of a type the API takes there. */
function nestedBlock(block: Block, onAltered: () => void, finish: Finish, layout: Layout): Block {
  if (block.type === 'image') return wireImage(block, FIELDS.get('image')!, onAltered, layout);
  if (block.type === 'document') return wireDocument(block, layout, onAltered, finish);
  if (block.type === 'text') return pick(block, FIELDS.get('text')!, layout.apiOrder);
  return block;
}

/**
 * A tool_result's content as the API takes it there (see the module doc), in
 * the API's own key order, for a converter that reports nothing
 * (toAnthropicContent): a string as it is, or a note for an error result's
 * with nothing in it (none, null or an empty string). `result` is the
 * tool_result it builds around it, with no breakpoint or toolset of its own.
 */
export function anthropicToolResultContent(content: unknown, result: { is_error?: unknown } = {}): unknown {
  if (!Array.isArray(content)) return withoutEmptyError(content, result);
  return toolResultContent(content, content, result, () => {}, (built) => built, { apiOrder: true, imageMediaTypeLast: false });
}

/** A tool_result's content that isn't an array of blocks: as it is, but for
 *  an error result's with nothing in it (none, null or an empty string),
 *  which the API refuses, and which carries NO_CONTENT_ERROR_NOTE instead. */
function withoutEmptyError(content: unknown, result: { is_error?: unknown }): unknown {
  if (result.is_error !== true || (content !== undefined && content !== null && content !== '')) return content;
  return [{ type: 'text', text: NO_CONTENT_ERROR_NOTE }];
}

/**
 * The block a caller handed in where a request built by anthropicWireMessages
 * holds `block`, a built copy at the top of a message or in a tool_result's
 * content, or `block` itself. So a report about a block made after the build
 * (the empty-text cleanup's, a provider's report of what it did with the
 * request's input) names the one the caller handed in, which the build that
 * made it can attribute.
 */
export function blockBuiltFrom(block: unknown): unknown {
  return isRecord(block) && handedIn.has(block) ? handedIn.get(block) : block;
}

/**
 * `messages`, each content block as the Messages API takes it (see the
 * module doc). Media in MCP's form becomes membrane's first, for a caller
 * that builds a request directly (Membrane's own builds have converted it
 * already, utils/mcp-media.ts). Media with no form the API takes is left
 * out, at the top of a message or in a tool_result.
 * `onContentAltered` hears, with the block the caller handed in, each block
 * left out at the top, each image there that goes as the placeholder, each
 * document there whose content source lost a block or an image to the
 * placeholder, and each tool_result whose content lost a block, or an image
 * to the placeholder or a note, anywhere in it, or that carries a note in
 * place of content it couldn't send or never had. `finish`, when given, is
 * the wire's last step for every block that goes, at the top, in a
 * tool_result and in a document's content source: Bedrock's leaves out
 * `cache_control.ttl`. The rest lay the blocks out as the wire's adapter
 * always did: `nestedInApiOrder` builds a tool_result's content in the API's
 * own key order, as Anthropic's did, and `imageMediaTypeLast` puts an image's
 * `media_type` after the rest of its source, as Bedrock's did, but in a
 * document's content source, which Bedrock's sent as it came. Nothing handed
 * in is changed.
 */
export function anthropicWireMessages(
  messages: readonly unknown[],
  options: {
    onContentAltered?: (block?: unknown) => void;
    finish?: (block: Block) => Block;
    nestedInApiOrder?: boolean;
    imageMediaTypeLast?: boolean;
  } = {},
): unknown[] {
  const finish: Finish = (built, original) => {
    const done = options.finish ? options.finish(built) : built;
    if (done !== original) handedIn.set(done, original);
    return done;
  };
  const top: Layout = { apiOrder: false, imageMediaTypeLast: options.imageMediaTypeLast === true };
  const nested: Layout = { ...top, apiOrder: options.nestedInApiOrder === true };
  return messages.map((message) => {
    if (!isRecord(message) || !Array.isArray(message.content)) return message;
    const converted = convertMcpMedia(message.content as unknown[]);
    return {
      ...message,
      content: (message.content as unknown[]).flatMap((original, index) => {
        const block = converted[index];
        if (!isRecord(block)) return [block];
        const report = () => options.onContentAltered?.(original);
        if (hasNoWireForm(block)) {
          report();
          return [];
        }
        return [finish(wireBlock(block, original as Block, report, finish, top, nested), original as Block)];
      }),
    };
  });
}

/** `block` (`original` with MCP's media converted) as the API takes it at
 *  the top of a message. */
function wireBlock(block: Block, original: Block, report: () => void, finish: Finish, top: Layout, nested: Layout): Block {
  if (block.type === 'image') return wireImage(block, FIELDS.get('image')!, report, top);
  if (block.type === 'document') {
    let altered = false;
    const built = wireDocument(block, top, () => { altered = true; }, finish);
    if (altered) report();
    return built;
  }
  if (block.type === 'tool_result') {
    const built = pick(block, FIELDS.get('tool_result')!, false);
    if (!Array.isArray(block.content)) {
      const content = withoutEmptyError(block.content, built);
      if (content !== block.content) {
        built.content = content;
        report();
      }
      return built;
    }
    const given = Array.isArray(original.content) ? original.content : block.content;
    let altered = false;
    built.content = toolResultContent(block.content, given, built, () => { altered = true; }, finish, nested);
    if (altered) report();
    return built;
  }
  const fields = FIELDS.get(block.type);
  return fields ? pick(block, fields, false) : block;
}
