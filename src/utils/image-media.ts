/**
 * A provider refuses a whole request when one of its images is data it
 * doesn't accept, and an image in an agent's history goes out with every
 * later request. Ingest labels can't be trusted to catch it: an SVG arrives as
 * image/svg+xml, but a text file renamed `notes.png` arrives as image/png.
 */

export type RasterImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
export type ImageMediaType = RasterImageMediaType | 'image/heic' | 'image/heif';

export const RASTER_IMAGE_TYPES: ReadonlySet<RasterImageMediaType> =
  new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/** Gemini's image formats as its image-understanding docs list them
 *  (ai.google.dev/gemini-api/docs/image-understanding): PNG, JPEG, WebP, HEIC
 *  and HEIF, and no GIF. */
export const GEMINI_IMAGE_TYPES: ReadonlySet<ImageMediaType> =
  new Set(['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif']);

/** What OpenAI's image edits take from the GPT image models: PNG, WebP and
 *  JPEG, and no GIF (openai-node's images.ts, ImageEditParamsBase.image). */
export const OPENAI_IMAGE_EDIT_TYPES: ReadonlySet<ImageMediaType> =
  new Set(['image/png', 'image/jpeg', 'image/webp']);

const FORMAT_NAMES: ReadonlyArray<[ImageMediaType, string]> = [
  ['image/jpeg', 'JPEG'], ['image/png', 'PNG'], ['image/gif', 'GIF'],
  ['image/webp', 'WebP'], ['image/heic', 'HEIC'], ['image/heif', 'HEIF'],
];

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** HEIF still images by their `ftyp` box's major brand (ISO/IEC 23008-12):
 *  heic and heix are HEVC-coded images, mif1 any HEIF image. Image sequences
 *  have brands of their own and aren't images here. */
const HEIF_BRANDS: Readonly<Record<string, ImageMediaType>> = {
  heic: 'image/heic', heix: 'image/heic', mif1: 'image/heif',
};

const HEADER_BYTES = 18;

function formatOf(data: unknown): ImageMediaType | undefined {
  // Node's base64 decoder skips leading whitespace, which would use up the window.
  const bytes = Buffer.from((typeof data === 'string' ? data : '').trimStart().slice(0, (HEADER_BYTES / 3) * 4), 'base64');
  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  const header = bytes.toString('latin1');
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) return 'image/gif';
  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') return 'image/webp';
  if (header.slice(4, 8) === 'ftyp') return HEIF_BRANDS[header.slice(8, 12)];
  return undefined;
}

export function isAcceptedImage(data: unknown): boolean {
  const format = formatOf(data);
  return format !== undefined && (RASTER_IMAGE_TYPES as ReadonlySet<ImageMediaType>).has(format);
}

export type ImageForRequest<T extends ImageMediaType = RasterImageMediaType> =
  | { mediaType: T; placeholder?: undefined }
  | { mediaType?: undefined; placeholder: { type: 'text'; text: string } };

export function imageForRequest<T extends ImageMediaType = RasterImageMediaType>(
  data: unknown,
  declared: unknown,
  accepted: ReadonlySet<T> = RASTER_IMAGE_TYPES as ReadonlySet<ImageMediaType> as ReadonlySet<T>,
): ImageForRequest<T> {
  if (typeof data !== 'string' || data === '') {
    console.warn('[membrane] image block stripped: no data');
    return {
      placeholder: {
        type: 'text',
        text:
          '[system: an image that belongs here was NOT shown to you — it came without its data. ' +
          'You are not seeing this image.]',
      },
    };
  }
  const format = formatOf(data);
  if (format && (accepted as ReadonlySet<ImageMediaType>).has(format)) return { mediaType: format as T };
  const label = typeof declared === 'string' && declared !== ''
    ? ` (it was labelled ${JSON.stringify(declared.slice(0, 64))})`
    : '';
  const names = FORMAT_NAMES
    .filter(([type]) => (accepted as ReadonlySet<ImageMediaType>).has(type))
    .map(([, name]) => name);
  const formats = names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}` : names.join('');
  console.warn(`[membrane] image block stripped: its data is not a ${formats} image${label}`);
  return {
    placeholder: {
      type: 'text',
      text:
        `[system: an image that belongs here was NOT shown to you — its data is not a ${formats} ` +
        `image, the formats this request can carry${label}. You are not seeing this image. ` +
        `If it matters, ask for it in one of those formats.]`,
    },
  };
}

const DATA_URL = /^data:([^,]*),/i;

export type UrlImageForRequest =
  | { url: string; mediaType?: RasterImageMediaType; data?: string; placeholder?: undefined }
  | { placeholder: { type: 'text'; text: string }; url?: undefined; mediaType?: undefined; data?: undefined };

/**
 * The fetch spec's `data:` URL processor percent-decodes the payload, a base64
 * one too, so a URL may escape base64's padding as `%3D`; valid base64 holds
 * no `%`.
 */
export function dataUrlImage(url: unknown): { data: string; declared: string | undefined; base64: boolean } | undefined {
  if (typeof url !== 'string' || !/^data:/i.test(url)) return undefined;
  const head = DATA_URL.exec(url);
  if (!head) return { data: '', declared: url.slice(5).split(';')[0] || undefined, base64: false };
  const [type = '', ...params] = head[1]!.split(';');
  const payload = url.slice(head[0].length)
    .replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  const base64 = params.some((param) => param.trim().toLowerCase() === 'base64');
  const data = base64 ? payload : Buffer.from(payload, 'latin1').toString('base64');
  return { data, declared: type || undefined, base64 };
}

export function urlImageForRequest(url: string): UrlImageForRequest {
  const inline = dataUrlImage(url);
  if (!inline) return { url };
  const image = imageForRequest(inline.data, inline.declared);
  if (image.placeholder) return { placeholder: image.placeholder };
  const labelled = inline.base64 && inline.declared?.trim().toLowerCase() === image.mediaType
    && url.endsWith(`,${inline.data}`);
  return { url: labelled ? url : `data:${image.mediaType};base64,${inline.data}`, mediaType: image.mediaType, data: inline.data };
}

export function toolResultContentForRequest(content: unknown, onAltered?: () => void): unknown {
  if (!Array.isArray(content)) return content;
  const placeholder = (note: { type: 'text'; text: string }) => {
    onAltered?.();
    return note;
  };
  return content.map((item) => {
    if (!item || typeof item !== 'object') return item;
    if ((item as { type?: unknown }).type !== 'image') return { ...item };
    const block = item as { source?: { type?: string; url?: unknown; data?: unknown; mediaType?: unknown; media_type?: unknown }; data?: unknown; mimeType?: unknown };
    const src = block.source;
    if (src?.type === 'url') {
      const image = urlImageForRequest(src.url as string);
      if (image.placeholder) return placeholder(image.placeholder);
      if (!image.data) return { ...item };
      return { ...item, source: { type: 'base64', media_type: image.mediaType, data: image.data } };
    }
    if (!src && typeof block.data === 'string') {
      const image = imageForRequest(block.data, block.mimeType);
      if (image.placeholder) return placeholder(image.placeholder);
      const { data, mimeType: _declared, ...rest } = block;
      return { ...rest, source: { type: 'base64', media_type: image.mediaType, data } };
    }
    const image = imageForRequest(src?.data, src?.mediaType ?? src?.media_type);
    if (image.placeholder) return placeholder(image.placeholder);
    const { mediaType: _declared, ...source } = src ?? {};
    return { ...item, source: { ...source, media_type: image.mediaType } };
  });
}

/** The API caps a request by size (~32MB serialized), apart from its token
 *  count, and refuses one over it with 413 request_too_large. This caps the
 *  messages alone, below that limit, so the system prompt and tools fit. */
export const DEFAULT_MAX_REQUEST_BYTES = 28 * 1024 * 1024;

export function requestByteCap(capBytes?: number): number {
  return capBytes ?? (Number(process.env.MEMBRANE_MAX_REQUEST_BYTES) || DEFAULT_MAX_REQUEST_BYTES);
}

export function serializedMessageBytes(messages: Array<{ content?: unknown }>): number {
  return JSON.stringify(messages).length;
}

export function assertWithinByteBudget(
  messages: Array<{ content?: unknown }>,
  capBytes: number | undefined,
  site: string,
): void {
  const cap = requestByteCap(capBytes);
  const size = serializedMessageBytes(messages);
  if (size <= cap) return;
  let images = 0;
  let imageBytes = 0;
  const walk = (content: unknown[]): void => {
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      const typed = b as { type?: string; content?: unknown };
      if (typed.type === 'image') {
        images++;
        imageBytes += JSON.stringify(b).length;
      } else if (typed.type === 'tool_result' && Array.isArray(typed.content)) {
        walk(typed.content);
      }
    }
  };
  for (const m of messages) if (Array.isArray(m.content)) walk(m.content);
  throw new Error(
    `[membrane] request exceeds the byte cap at ${site}: ${Math.round(size / 1e6)}MB > ` +
      `cap ${Math.round(cap / 1e6)}MB (${images} inline image(s), ~${Math.round(imageBytes / 1e6)}MB of them). ` +
      `Refusing to silently drop content. Either the compile must respect the byte wall ` +
      `(context-manager maxLiveImageBytes), or the caller must explicitly own image loss ` +
      `by setting shedOversizeImages on the request.`,
  );
}

export function shedImagesToFitByteBudget(
  messages: Array<{ content?: unknown }>,
  capBytes?: number,
  site = 'unknown-site',
): number {
  const cap = requestByteCap(capBytes);
  let size = JSON.stringify(messages).length;
  if (size <= cap) return 0;

  const placeholder = (): { type: 'text'; text: string } => ({
    type: 'text',
    text:
      `[system: an image that belongs here was dropped from THIS request only — the ` +
      `request exceeded the API's total size limit, and older images are dropped first. ` +
      `You are not seeing this image right now; it remains in your history and recent ` +
      `images are kept.]`,
  });

  let shed = 0;
  const shedInArray = (content: unknown[]): boolean => {
    for (let i = 0; i < content.length; i++) {
      const b = content[i];
      if (!b || typeof b !== 'object') continue;
      const typed = b as { type?: string; content?: unknown };
      if (typed.type === 'image') {
        const before = JSON.stringify(b).length;
        content[i] = placeholder();
        size -= before - JSON.stringify(content[i]).length;
        shed++;
        if (size <= cap) return true;
      } else if (typed.type === 'tool_result' && Array.isArray(typed.content)) {
        if (shedInArray(typed.content)) return true;
      }
    }
    return false;
  };

  for (const msg of messages) {
    if (Array.isArray(msg.content) && shedInArray(msg.content)) break;
  }
  console.error(
    `[membrane-oversize] shed ${shed} inline image(s) at ${site} to fit the request byte cap ` +
      `(${Math.round(size / 1e6)}MB / cap ${Math.round(cap / 1e6)}MB). This opt-in firing means ` +
      `the upstream compile exceeded the byte wall — check maxLiveImageBytes / image policy.`,
  );
  return shed;
}
export function linkImageNote(url: unknown): { type: 'text'; text: string } {
  console.warn("[membrane] image block stripped: a URL source, which the XML tool path can't carry");
  const link = notedLink(url);
  return {
    type: 'text',
    text:
      `[system: an image that belongs here was NOT shown to you — it came as a link${link ? ` (${link})` : ''}, ` +
      "which tool results here can't carry. You are not seeing this image.]",
  };
}

const MAX_NOTED_LINK_CHARS = 2048;

/** Half of a UTF-16 surrogate pair, which the API refuses in a request's JSON. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function notedLink(url: unknown): string | undefined {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || LONE_SURROGATE.test(url)) return undefined;
  if (url.length <= MAX_NOTED_LINK_CHARS) return url;
  const end = /[\uD800-\uDBFF]/.test(url.charAt(MAX_NOTED_LINK_CHARS - 1)) ? MAX_NOTED_LINK_CHARS - 1 : MAX_NOTED_LINK_CHARS;
  return `${url.slice(0, end)}…`;
}
