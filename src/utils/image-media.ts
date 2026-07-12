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

export function isAcceptedImageMediaType(mediaType: string | null | undefined): boolean {
  return API_ACCEPTED_IMAGE_MEDIA_TYPES.has((mediaType ?? '').toLowerCase());
}

/** Requests are also capped by SIZE (~32MB serialized) independent of token
 *  count — token math is blind to base64 bulk, so an image-heavy window can
 *  pass the context budget yet draw 413 request_too_large (Mythos 2026-07-12:
 *  47 inline images = 34.3MB). Default cap leaves headroom for system/tools
 *  and JSON overhead; override via MEMBRANE_MAX_REQUEST_BYTES. */
export const DEFAULT_MAX_REQUEST_BYTES = 28 * 1024 * 1024;

/** Shed inline images, OLDEST first, until the serialized messages fit the
 *  byte cap. Mutates content arrays in place, replacing shed image blocks
 *  (including ones nested in tool_result content) with loud agent-facing
 *  placeholders. Returns the number of images shed. */
export function shedImagesToFitByteBudget(
  messages: Array<{ content?: unknown }>,
  capBytes?: number,
): number {
  const cap =
    capBytes ?? (Number(process.env.MEMBRANE_MAX_REQUEST_BYTES) || DEFAULT_MAX_REQUEST_BYTES);
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
  console.warn(
    `[membrane] shed ${shed} inline image(s) to fit the request byte cap ` +
      `(${Math.round(size / 1e6)}MB / cap ${Math.round(cap / 1e6)}MB)`,
  );
  return shed;
}

/** Loud agent-facing stand-in for an image the API would reject. The agent
 *  must be clearly aware an image was stripped — silence here reads as
 *  "there was no image". Also warns on stderr for ops visibility. */
export function strippedImagePlaceholder(mediaType: unknown): { type: 'text'; text: string } {
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
