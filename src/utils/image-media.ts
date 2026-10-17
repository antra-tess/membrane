/**
 * Image media-type sanitation shared by every request-build path.
 *
 * sharp-readable but API-rejected formats (image/svg, image/tiff, ...) can
 * enter an agent's event store through permissive ingest surfaces; one such
 * block then 400s EVERY subsequent compile (invalid_request) and hard-downs
 * the agent (LabClaude 2026-07-11: an SVG attachment). Every place that turns
 * a normalized image block into a provider image block must either emit an
 * accepted media type or degrade to a loud text placeholder the agent can see.
 */

export const API_ACCEPTED_IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

/** Resolve supported image signatures before trusting an ingest label.
 * Unknown bytes retain the declared type so callers can still reject unsupported
 * formats. Inspect only the header rather than decoding the entire image. */
export function resolveImageMediaType(data: string | undefined, declared?: string): string | undefined {
  // Malformed blocks can carry non-string fields at runtime; treat them as
  // unknown bytes / no label rather than throwing out of a request build.
  const bytes = Buffer.from((typeof data === 'string' ? data : '').slice(0, 24), 'base64');
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  const header = bytes.toString('latin1');
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) return 'image/gif';
  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') return 'image/webp';
  return typeof declared === 'string' ? declared.toLowerCase() : undefined;
}

export function isAcceptedImageMediaType(mediaType: string | null | undefined): boolean {
  return API_ACCEPTED_IMAGE_MEDIA_TYPES.has((mediaType ?? '').toLowerCase());
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

/** Loud agent-facing stand-in for an image the API would reject. The agent
 *  must be clearly aware an image was stripped — silence here reads as
 *  "there was no image". Also warns on stderr for ops visibility.
 *
 *  `image` is the block being stripped. One that came as a link, or without
 *  its data, gets a note that says so: its media type isn't why it isn't
 *  shown, and no other format would help. */
export function strippedImagePlaceholder(mediaType: unknown, image: unknown): { type: 'text'; text: string } {
  if (cameAsLink(image)) {
    console.warn("[membrane] image block stripped: a URL source, which the XML tool path can't carry");
    const link = notedLink(image);
    return {
      type: 'text',
      text:
        `[system: an image that belongs here was NOT shown to you — it came as a link${link ? ` (${link})` : ''}, ` +
        "which tool results here can't carry. You are not seeing this image.]",
    };
  }
  if (cameWithoutData(image)) {
    console.warn('[membrane] image block stripped: no data');
    return {
      type: 'text',
      text:
        '[system: an image that belongs here was NOT shown to you — it came without its data. ' +
        'You are not seeing this image.]',
    };
  }
  console.warn(
    `[membrane] image block stripped: unsupported media type "${String(mediaType)}"`,
  );
  return {
    type: 'text',
    text:
      `[system: an image that belongs here was NOT shown to you — its media type ` +
      `"${String(mediaType)}" is not accepted by the model API (only jpeg/png/gif/webp are). ` +
      `You are not seeing this image. If it matters, ask for it in a supported format.]`,
  };
}

/** An image block whose source is a URL. The xml tool path's results carry
 *  no links, so such an image reaches the note there. */
function cameAsLink(image: unknown): boolean {
  const source = typeof image === 'object' && image !== null ? (image as { source?: unknown }).source : undefined;
  return typeof source === 'object' && source !== null && (source as { type?: unknown }).type === 'url';
}

/** The longest link a note repeats: room for a signed URL, not for a page of
 *  text. */
const MAX_NOTED_LINK_CHARS = 2048;

/** Half of a UTF-16 surrogate pair, which a request's JSON can't carry. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** A link image's URL for its note, so an agent with a fetch or browser tool
 *  can open it: an http or https URL, cut to `MAX_NOTED_LINK_CHARS` between
 *  code points. Any other URL, such as a data URL's payload, isn't repeated,
 *  and nor is one holding half a surrogate pair, since the API refuses the
 *  request's JSON then. */
function notedLink(image: unknown): string | undefined {
  const url = ((image as { source?: { url?: unknown } }).source)?.url;
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || LONE_SURROGATE.test(url)) return undefined;
  if (url.length <= MAX_NOTED_LINK_CHARS) return url;
  const end = /[\uD800-\uDBFF]/.test(url.charAt(MAX_NOTED_LINK_CHARS - 1)) ? MAX_NOTED_LINK_CHARS - 1 : MAX_NOTED_LINK_CHARS;
  return `${url.slice(0, end)}…`;
}

/** An image block with no base64 data, in its source or, with no source
 *  object, on the block (MCP's form). Asked after `cameAsLink`. */
function cameWithoutData(image: unknown): boolean {
  if (typeof image !== 'object' || image === null) return true;
  const block = image as { source?: unknown; data?: unknown };
  const source = typeof block.source === 'object' && block.source !== null
    ? (block.source as { data?: unknown })
    : undefined;
  const data = source ? source.data : block.data;
  return typeof data !== 'string' || data === '';
}
