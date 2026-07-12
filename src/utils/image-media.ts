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
