/**
 * Image handling shared by every request-build path.
 *
 * A provider refuses a whole request when one of its images is data it
 * doesn't accept, and an image in an agent's history goes out with every
 * later request, so one such block fails every compile until it is removed
 * (LabClaude 2026-07-11: an SVG attachment). Ingest labels can't be trusted
 * to catch it: an SVG arrives as image/svg+xml, but a text file renamed
 * `notes.png` arrives as image/png. So every place that turns image data
 * into a provider image, base64 data or a `data:` URL, asks
 * `imageForRequest` with its destination's accepted formats. The decision
 * recognizes each format by its header: an accepted image is labelled by
 * what its header shows, and anything else becomes a text placeholder the
 * agent can see. A header is not proof the rest decodes. A remote image URL
 * goes out as it is, for the provider to fetch, where the request can carry
 * one; an xml tool loop's results can't, and give the link note instead
 * (linkImageNote).
 */

import { copyBlockTree } from './cache-marker-budget.js';

export type RasterImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
export type ImageMediaType = RasterImageMediaType | 'image/heic' | 'image/heif';

/** What the request builders send as images, and what every destination
 *  takes unless it documents otherwise. */
export const RASTER_IMAGE_TYPES: ReadonlySet<RasterImageMediaType> =
  new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/** Gemini's image formats as its image-understanding docs list them
 *  (ai.google.dev/gemini-api/docs/image-understanding, read 2026-10-12):
 *  PNG, JPEG, WebP, HEIC and HEIF, and no GIF. */
export const GEMINI_IMAGE_TYPES: ReadonlySet<ImageMediaType> =
  new Set(['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif']);

/** What OpenAI's image edits take from the GPT image models: PNG, WebP and
 *  JPEG, and no GIF (openai-node's images.ts, ImageEditParamsBase.image, as
 *  of 2026-10-06). */
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

/** The format whose header the data starts with, if any. Only the first 18
 *  bytes are decoded, which hold every header recognized here. */
function formatOf(data: unknown): ImageMediaType | undefined {
  // Malformed blocks can carry non-string fields at runtime; treat them as
  // data that is no image rather than throwing out of a request build.
  // Leading whitespace, which the decoder skips, would use up the window.
  const bytes = Buffer.from((typeof data === 'string' ? data : '').trimStart().slice(0, 24), 'base64');
  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  const header = bytes.toString('latin1');
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) return 'image/gif';
  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') return 'image/webp';
  if (header.slice(4, 8) === 'ftyp') return HEIF_BRANDS[header.slice(8, 12)];
  return undefined;
}

/** Whether `data` holds an image of one of the four raster formats the
 *  request builders send: the test `imageForRequest` applies by default,
 *  without its placeholder or its warning, for a caller that only needs to
 *  know whether an image will be sent. */
export function isAcceptedImage(data: unknown): boolean {
  const format = formatOf(data);
  return format !== undefined && (RASTER_IMAGE_TYPES as ReadonlySet<ImageMediaType>).has(format);
}

export type ImageForRequest<T extends ImageMediaType = RasterImageMediaType> =
  | { mediaType: T; placeholder?: undefined }
  | { mediaType?: undefined; placeholder: { type: 'text'; text: string } };

/**
 * What a request carries for base64 image data: the media type its header
 * shows, whatever label it arrived with, when that format is one `accepted`
 * holds; otherwise a text placeholder in its place. An image whose data is
 * missing, empty or not a string gets a note that says it came without its
 * data; any other gets one naming the formats the request can carry.
 * `accepted` is what the destination takes, the four raster formats unless
 * it documents otherwise.
 * `declared` is the label the data arrived with; it only goes into the
 * placeholder and the warning.
 *
 * The placeholder is loud on purpose: the agent must be clearly aware an
 * image was withheld, since silence reads as "there was no image". Each one
 * also warns on stderr for ops visibility.
 */
export function imageForRequest<T extends ImageMediaType = RasterImageMediaType>(
  data: unknown,
  declared: unknown,
  accepted: ReadonlySet<T> = RASTER_IMAGE_TYPES as ReadonlySet<ImageMediaType> as ReadonlySet<T>,
): ImageForRequest<T> {
  // An image that came without its data: no format would help, so the note
  // says what happened instead of naming formats.
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
  // The label comes from ingest and goes into a system note, so it is quoted
  // and cut short: a quote, a newline or a bracket in it stays inside quotes.
  const label = typeof declared === 'string' && declared !== ''
    ? ` (it was labelled ${JSON.stringify(declared.slice(0, 64))})`
    : '';
  const names = FORMAT_NAMES
    .filter(([type]) => (accepted as ReadonlySet<ImageMediaType>).has(type))
    .map(([, name]) => name);
  const formats = names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}` : names.join('');
  // The formats named are this request path's, which can be stricter than
  // what the provider itself takes: a builder sends only the four raster
  // formats even to an API that also takes HEIC.
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
 * The image a `data:` URL holds inline: its bytes as base64 data, the type it
 * was labelled with, and whether its bytes came as base64 (the alternative is
 * percent-encoded). Undefined for any other URL, whose image is at the URL.
 * A `data:` URL without the comma that starts its data holds none: its data
 * is empty. The payload is percent-decoded first, a base64 one too, as the
 * fetch spec's `data:` URL processor decodes it: a URL may escape base64's
 * padding as `%3D`. Valid base64 holds no `%`, so it comes through as it is.
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

/**
 * What a request carries for an image given by URL. A `data:` URL holds its
 * image inline, so its bytes take `imageForRequest`'s decision: an accepted
 * image comes back with its media type, its base64 data and a `data:` URL
 * labelled by its header (the same URL when it already was), and anything
 * else comes back as the placeholder. Any other URL comes back as it is,
 * for the provider to fetch.
 */
export function urlImageForRequest(url: string): UrlImageForRequest {
  const inline = dataUrlImage(url);
  if (!inline) return { url };
  const image = imageForRequest(inline.data, inline.declared);
  if (image.placeholder) return { placeholder: image.placeholder };
  // A URL already labelled by its header goes out as it came; only one whose
  // label disagrees, or whose bytes are percent-encoded, base64 ones with an
  // escape among them included, is rewritten.
  const labelled = inline.base64 && inline.declared?.trim().toLowerCase() === image.mediaType
    && url.endsWith(`,${inline.data}`);
  return { url: labelled ? url : `data:${image.mediaType};base64,${inline.data}`, mediaType: image.mediaType, data: inline.data };
}

/** Tool-result content as a request carries it, under the builders' formats:
 *  each base64 image labelled by its header, an image in a `data:` URL the
 *  same way, and anything else replaced by `imageForRequest`'s placeholder. An
 *  image may carry its data in a `source`, or MCP-style as `data` and
 *  `mimeType`; either way an accepted one comes back with a base64 `source`.
 *  A remote URL image goes as it is, other blocks keep their fields,
 *  non-array content is returned as it is, and nothing handed in is changed.
 *  Each block comes back as its own object, copied as deep as the
 *  cache-marker budget walks (copyBlockTree: a search result's content, a
 *  document's content source), since the budget's clamp strips markers in
 *  place and would otherwise strip the caller's own. So an adapter's report
 *  about one names exactly one occurrence, and `onAltered` hears each
 *  placeholder substitution. */
export function toolResultContentForRequest(content: unknown, onAltered?: () => void): unknown {
  if (!Array.isArray(content)) return content;
  const placeholder = (note: { type: 'text'; text: string }) => {
    onAltered?.();
    return note;
  };
  return content.map((given) => {
    const item = copyBlockTree(given, 1);
    if (!item || typeof item !== 'object') return item;
    if ((item as { type?: unknown }).type !== 'image') return item;
    const block = item as { source?: { type?: string; url?: unknown; data?: unknown; mediaType?: unknown; media_type?: unknown }; data?: unknown; mimeType?: unknown };
    const src = block.source;
    if (src?.type === 'url') {
      const image = urlImageForRequest(src.url as string);
      if (image.placeholder) return placeholder(image.placeholder);
      if (!image.data) return { ...item };
      return { ...item, source: { type: 'base64', media_type: image.mediaType, data: image.data } };
    }
    if (!src && typeof block.data === 'string') {
      // MCP-shaped image content, which some tool results carry as it came.
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

/** Requests are also capped by SIZE (~32MB serialized) independent of token
 *  count — token math is blind to base64 bulk, so an image-heavy window can
 *  pass the context budget yet draw 413 request_too_large (Mythos 2026-07-12:
 *  47 inline images = 34.3MB). Default cap leaves headroom for system/tools
 *  and JSON overhead; override via MEMBRANE_MAX_REQUEST_BYTES. */
export const DEFAULT_MAX_REQUEST_BYTES = 28 * 1024 * 1024;

/** The effective request byte cap. */
export function requestByteCap(capBytes?: number): number {
  return capBytes ?? (Number(process.env.MEMBRANE_MAX_REQUEST_BYTES) || DEFAULT_MAX_REQUEST_BYTES);
}

/** Serialized byte size of the messages array (JSON length ≈ wire size). */
export function serializedMessageBytes(messages: Array<{ content?: unknown }>): number {
  return JSON.stringify(messages).length;
}

/**
 * FAIL LOUDLY when the serialized messages exceed the byte cap (2026-07-12).
 * Silent content mutation at the transport layer is a diagnosis trap: every
 * layer above believes it sent a different context than the wire carried.
 * Callers that can genuinely tolerate losing old images must OWN that policy
 * by setting `shedOversizeImages` on the request — everything else fails
 * here, before the API round-trip, with the full breakdown.
 */
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

/** Shed inline images, OLDEST first, until the serialized messages fit the
 *  byte cap. Mutates content arrays in place, replacing shed image blocks
 *  (including ones nested in tool_result content) with loud agent-facing
 *  placeholders. Returns the number of images shed.
 *
 *  ONLY runs for callers that explicitly opted in (`shedOversizeImages`) —
 *  and even then it reports at error grade: an exercised opt-in is a signal
 *  the upstream byte wall is misconfigured. */
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
/** The note for an image that came as a link where the request can't carry
 *  one, as in an xml tool loop's results: it says so and gives the link, so
 *  an agent with a fetch or browser tool can open it. The image's format
 *  isn't why it isn't shown, so the note names none. A `data:` URL isn't a
 *  link: its bytes decide it (dataUrlImage). */
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

/** The longest link a note repeats: room for a signed URL, not for a page of
 *  text. */
const MAX_NOTED_LINK_CHARS = 2048;

/** Half of a UTF-16 surrogate pair, which a request's JSON can't carry. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** A link for a note: an http or https URL, cut to `MAX_NOTED_LINK_CHARS`
 *  between code points. Any other URL isn't repeated, and nor is one holding
 *  half a surrogate pair, since the API refuses the request's JSON then. */
function notedLink(url: unknown): string | undefined {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || LONE_SURROGATE.test(url)) return undefined;
  if (url.length <= MAX_NOTED_LINK_CHARS) return url;
  const end = /[\uD800-\uDBFF]/.test(url.charAt(MAX_NOTED_LINK_CHARS - 1)) ? MAX_NOTED_LINK_CHARS - 1 : MAX_NOTED_LINK_CHARS;
  return `${url.slice(0, end)}…`;
}
