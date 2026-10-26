/**
 * An MCP tool result carries an image or audio clip with its bytes on the
 * block itself: `{ type: 'image', data, mimeType }`. Its `annotations` and
 * `_meta` are protocol metadata, which an API that rejects extra inputs
 * refuses.
 */

const MEDIA_TYPES: ReadonlySet<unknown> = new Set(['image', 'document', 'audio', 'video']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `items` with every media block in MCP's form converted to membrane's. An
 * item is a content block, or anything that holds blocks in a `content` array
 * (a message, a `tool_result`, a `ToolResult`), which is converted at any
 * depth.
 *
 * Copies, not edits: an array holding nothing to convert comes back as the
 * same array, and one that does comes back as a new array, with a new object
 * for each converted block and for each item on the way to one. The objects
 * handed in are never changed, so a caller's request stays as it was.
 */
export function convertMcpMedia<T>(items: T[]): T[] {
  let out: T[] | undefined;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const converted = convertedItem(item);
    if (converted !== item) (out ??= items.slice())[i] = converted as T;
  }
  return out ?? items;
}

/** A media block (image, document, audio or video) with no `source` object:
 *  MCP's form that didn't convert, or media without its source in any form.
 *  No request has a form for it. */
export function isSourcelessMedia(block: unknown): boolean {
  return isRecord(block) && MEDIA_TYPES.has(block.type) && !isRecord(block.source);
}

/**
 * For a builder that reports blocks from inside a reader it hands converted
 * messages: the caller's block at the place in `messages` where `converted`
 * (convertMcpMedia's result for them) holds `block`, or `block` itself where
 * nothing converted. So a report names what the caller handed in, as one
 * about the same media in membrane's form would. The blocks such a reader
 * reports: a message's content blocks, and an item given at the top level,
 * such as a standalone `tool_result`, which it reports itself.
 */
export function blockHandedIn(messages: unknown[], converted: unknown[]): (block: unknown) => unknown {
  const handedIn = new Map<unknown, unknown>();
  converted.forEach((message, i) => {
    const before = messages[i];
    if (message === before || !isRecord(message) || !isRecord(before)) return;
    handedIn.set(message, before);
    if (!Array.isArray(message.content) || !Array.isArray(before.content)) return;
    const original = before.content;
    message.content.forEach((block, j) => {
      if (block !== original[j]) handedIn.set(block, original[j]);
    });
  });
  return (block) => (handedIn.has(block) ? handedIn.get(block) : block);
}

function convertedItem(item: unknown): unknown {
  if (!isRecord(item)) return item;
  if (Array.isArray(item.content)) {
    const content = convertMcpMedia(item.content);
    return content === item.content ? item : { ...item, content };
  }
  if (!MEDIA_TYPES.has(item.type) || isRecord(item.source)) return item;
  // MCP's form carries its media in `data` and `mimeType`; a block with neither
  // is another shape, such as an `image_url` image.
  if (!('data' in item) && !('mimeType' in item)) return item;
  const { data, mimeType, annotations: _annotations, _meta, ...rest } = item;
  const mediaType = typeof mimeType === 'string' && mimeType !== '' ? mimeType : undefined;
  // imageForRequest decides an image's data wherever a request carries it;
  // other media go with their source as it is.
  if (item.type !== 'image' && (typeof data !== 'string' || data === '' || mediaType === undefined)) return item;
  return { ...rest, source: { type: 'base64', data, ...(mediaType === undefined ? {} : { mediaType }) } };
}
