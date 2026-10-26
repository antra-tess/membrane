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

export function convertMcpMedia<T>(items: T[]): T[] {
  let out: T[] | undefined;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const converted = convertedItem(item);
    if (converted !== item) (out ??= items.slice())[i] = converted as T;
  }
  return out ?? items;
}

export function isSourcelessMedia(block: unknown): boolean {
  return isRecord(block) && MEDIA_TYPES.has(block.type) && !isRecord(block.source);
}

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
  if (item.type !== 'image' && (typeof data !== 'string' || data === '' || mediaType === undefined)) return item;
  return { ...rest, source: { type: 'base64', data, ...(mediaType === undefined ? {} : { mediaType }) } };
}
