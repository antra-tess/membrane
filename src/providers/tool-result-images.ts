import { carriesInlineImageData, textOnlyToolResultContent, TEXT_ONLY_TOOL_RESULT_IMAGE_PLACEHOLDER } from './utils.js';
import { imageBytesMediaType, isAcceptedImageMediaType } from '../utils/image-media.js';

/**
 * Request-side image handling for tool outputs. Image-free outputs keep their
 * historical serialization; image bytes must only appear in media fields.
 */
export type ToolOutputPart =
  | { type: 'text'; text: string }
  | { type: 'image'; source: any; block: unknown };

export type ChatToolOutputPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } };

function isSourceImage(block: any): boolean {
  return block?.type === 'image' && block.source && typeof block.source === 'object'
    && typeof block.source.type === 'string';
}

/** Explicit source blocks are media; arbitrary tool data named "image" is not. */
export function hasToolResultImages(content: unknown): boolean {
  return Array.isArray(content) && content.some(isSourceImage);
}

/** null lets the adapter retain the exact legacy image-free wire form. */
export function toolOutputParts(content: unknown, isError = false): ToolOutputPart[] | null {
  if (!Array.isArray(content) || !hasToolResultImages(content)) return null;
  const parts: ToolOutputPart[] = isError ? [{ type: 'text', text: '[Tool result error]' }] : [];
  for (const block of content) {
    if (isSourceImage(block)) {
      parts.push({ type: 'image', source: block.source, block });
    } else if (carriesInlineImageData(block)) {
      // Keep #84's omission protection for MCP/generated_image payloads even
      // when a normalized image in the same result activates media conversion.
      parts.push({ type: 'text', text: TEXT_ONLY_TOOL_RESULT_IMAGE_PLACEHOLDER });
    } else {
      parts.push({
        type: 'text',
        text: typeof block === 'string' ? block
          : block?.type === 'text' ? block.text
          : JSON.stringify(block) ?? String(block),
      });
    }
  }
  return parts;
}

/** OpenRouter accepts images directly in ChatToolMessage.content. */
export function chatToolResultContent(block: any, media = false): string | ChatToolOutputPart[] {
  if (!media) return omittedToolResultContent(block.content);
  const parts = toolOutputParts(block.content, block.is_error ?? block.isError);
  if (!parts) return textOnlyToolResultContent(block.content);
  const converted: ChatToolOutputPart[] = parts.map(part => {
    if (part.type === 'text') return part;
    const url = chatToolImageUrl(part.source);
    if (url) return { type: 'image_url', image_url: { url } };
    // Only bytes are omitted. A source without bytes that the wire can't take
    // as an image keeps the block's own JSON text, as main sends it and as
    // omission keeps it, address included.
    return holdsImageBytes(part.source)
      ? { type: 'text', text: '[image omitted: unsupported image source or media type]' }
      : { type: 'text', text: JSON.stringify(part.block) };
  });
  // Keep all-omission results in the native string form so exported-helper
  // output can re-enter an adapter without losing the tool-call ID.
  return converted.some(part => part.type === 'image_url')
    ? converted
    : converted.map(part => part.type === 'text' ? part.text : '').join('\n');
}

/** Omission removes image bytes, which must never become text: base64 data
 * and data URLs. A source without bytes keeps its text, address included. */
export function omittedToolResultContent(content: unknown): string {
  if (!Array.isArray(content) || !content.some(holdsBytes)) return textOnlyToolResultContent(content);
  return textOnlyToolResultContent(content.map(block => holdsBytes(block)
    ? { type: 'text', text: TEXT_ONLY_TOOL_RESULT_IMAGE_PLACEHOLDER } : block));
}

/** Image bytes in a source: a data string, or a data URL. Any other source is
 * a reference, an address or descriptor with no bytes to omit. */
export function holdsImageBytes(source: any): boolean {
  return typeof source?.data === 'string'
    || (source?.type === 'url' && typeof source.url === 'string' && /^data:/i.test(parsedUrlText(source.url)));
}

/** A URL's text as the URL parser reads it: leading and trailing C0 controls
 * and spaces stripped, and tabs and newlines removed. */
function parsedUrlText(url: string): string {
  return url.replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '').replace(/[\t\n\r]/g, '');
}

/** The bytes a source carries as base64, with the type it declares: a base64
 * source's data, or the payload of a base64 data URL (parameters before
 * `;base64` allowed). Undefined when there are none a transport could send. */
export function inlineImageBytes(source: any): { data: string; declared?: unknown } | undefined {
  if (source?.type === 'base64') {
    return typeof source.data === 'string' && source.data
      ? { data: source.data, declared: source.media_type ?? source.mediaType }
      : undefined;
  }
  if (source?.type !== 'url' || typeof source.url !== 'string') return undefined;
  const dataUrl = /^data:([^,]*),([\s\S]*)$/i.exec(parsedUrlText(source.url));
  const meta = dataUrl?.[1]!.split(';') ?? [];
  if (!dataUrl?.[2] || meta.length < 2 || meta.at(-1)!.trim().toLowerCase() !== 'base64') return undefined;
  return { data: dataUrl[2], declared: meta[0] || undefined };
}

function holdsBytes(block: any): boolean {
  return isSourceImage(block) && holdsImageBytes(block.source);
}

/** Validate caller-owned native media with the same policy as tool media: a
 * part Chat can't take as an image becomes a notice when it holds bytes, and
 * otherwise keeps its own JSON text, address included. */
export function validatedChatImagePart(part: any): ChatToolOutputPart {
  const source = { type: 'url', url: part.image_url?.url };
  const url = chatToolImageUrl(source);
  if (url) return { ...part, image_url: { ...part.image_url, url } };
  return holdsImageBytes(source)
    ? { type: 'text', text: '[image omitted: unsupported image source or media type]' }
    : { type: 'text', text: JSON.stringify(part) };
}

/** Native tool media still has provenance, unlike relocated native user images.
 * Omission removes only bytes: a reference keeps its own JSON text. */
export function nativeChatToolContent(content: any[], media: boolean): string | any[] {
  const parts = content.map(part => part?.type !== 'image_url' ? part
    : media ? validatedChatImagePart(part)
    : holdsImageBytes({ type: 'url', url: part.image_url?.url })
      ? { type: 'text', text: TEXT_ONLY_TOOL_RESULT_IMAGE_PLACEHOLDER }
      : { type: 'text', text: JSON.stringify(part) });
  // Preserve caller-owned audio/other native parts; only all-text output can
  // collapse to a string without losing a sibling carrier.
  return parts.every(part => part?.type === 'text') ? parts.map(part => part.text).join('\n') : parts;
}

/** Inline media is validated here: a direct adapter call bypasses the formatter,
 * and the formatter passes URL sources, data URLs included, through unchecked. */
function chatToolImageUrl(source: any): string | undefined {
  if (source?.type === 'url' && typeof source.url === 'string' && !/^data:/i.test(parsedUrlText(source.url))) {
    try {
      // Send the URL as the parser read it, without surrounding whitespace,
      // tabs or newlines.
      const url = new URL(source.url);
      return url.protocol === 'https:' || url.protocol === 'http:' ? parsedUrlText(source.url) : undefined;
    } catch {
      return undefined;
    }
  }
  const inline = inlineImageBytes(source);
  const mediaType = inline && imageBytesMediaType(inline.data, inline.declared);
  return mediaType && isAcceptedImageMediaType(mediaType) ? 'data:' + mediaType + ';base64,' + inline!.data : undefined;
}

/**
 * OpenAI Chat Completions (and the generic compatible contract) only accepts
 * text in tool messages. Keep a reference at each image's original position,
 * and carry the pixels in a labelled user message AFTER all contiguous tool
 * responses, including results supplied in separate normalized envelopes.
 * Never insert a user message between an assistant's parallel tool results.
 */
export function relocateToolImages<T extends { role: string; content?: unknown; tool_call_id?: string }>(
  messages: T[],
): T[] {
  const output: T[] = [];
  let attachments: ChatToolOutputPart[] = [];
  const flush = () => {
    if (attachments.length) {
      output.push({ role: 'user', content: attachments } as T);
      attachments = [];
    }
  };
  for (const message of messages) {
    if (message.role !== 'tool') flush();
    if (message.role !== 'tool' || !Array.isArray(message.content)
      || !message.content.some(p => p?.type === 'image_url')) {
      output.push(message);
      continue;
    }
    let imageIndex = 0;
    const parts = (message.content as any[]).map(part => {
      if (part?.type !== 'image_url') return part;
      const label = 'Image ' + (++imageIndex) + ' from tool result ' + JSON.stringify(message.tool_call_id);
      attachments.push({ type: 'text', text: '[' + label + ']' }, part);
      return { type: 'text', text: '[' + label + ' follows in the next user message.]' };
    });
    const content = parts.every(part => part?.type === 'text')
      ? parts.map(part => part.text).join('\n') : parts;
    output.push({ ...message, content });
  }
  flush();
  return output;
}
