import { carriesInlineImageData, textOnlyToolResultContent, TEXT_ONLY_TOOL_RESULT_IMAGE_PLACEHOLDER } from './utils.js';
import { isAcceptedImageMediaType, resolveImageMediaType } from '../utils/image-media.js';

/**
 * Request-side image handling for tool outputs. Image-free outputs keep their
 * historical serialization; image bytes must only appear in media fields.
 */
export type ToolOutputPart =
  | { type: 'text'; text: string }
  | { type: 'image'; source: any };

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
      parts.push({ type: 'image', source: block.source });
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
    return url
      ? { type: 'image_url', image_url: { url } }
      : { type: 'text', text: '[image omitted: unsupported image source or media type]' };
  });
  // Keep all-omission results in the native string form so exported-helper
  // output can re-enter an adapter without losing the tool-call ID.
  return converted.some(part => part.type === 'image_url')
    ? converted
    : converted.map(part => part.type === 'text' ? part.text : '').join('\n');
}

/** Omit normalized sources too, including data URLs that must never become text. */
export function omittedToolResultContent(content: unknown): string {
  return textOnlyToolResultContent(Array.isArray(content)
    ? content.map(block => isSourceImage(block)
      ? { type: 'text', text: TEXT_ONLY_TOOL_RESULT_IMAGE_PLACEHOLDER } : block)
    : content);
}

/** Validate caller-owned native user media with the same policy as tool media. */
export function validatedChatImagePart(part: any): ChatToolOutputPart {
  const url = chatToolImageUrl({ type: 'url', url: part.image_url?.url });
  return url
    ? { ...part, image_url: { ...part.image_url, url } }
    : { type: 'text', text: '[image omitted: unsupported image source or media type]' };
}

/** Native tool media still has provenance, unlike relocated native user images. */
export function nativeChatToolContent(content: any[], media: boolean): string | ChatToolOutputPart[] {
  const parts: ChatToolOutputPart[] = content.map(part => part?.type !== 'image_url' ? part
    : media ? validatedChatImagePart(part)
    : { type: 'text', text: TEXT_ONLY_TOOL_RESULT_IMAGE_PLACEHOLDER });
  return parts.some(part => part.type === 'image_url') ? parts : parts.map(part => part.type === 'text' ? part.text : '').join('\n');
}

/** Inline media is validated here because live tools bypass formatter sanitation. */
function chatToolImageUrl(source: any): string | undefined {
  if (source?.type === 'url' && typeof source.url === 'string' && source.url) {
    if (!/^data:/i.test(source.url)) {
      try {
        const url = new URL(source.url);
        return url.protocol === 'https:' || url.protocol === 'http:' ? source.url : undefined;
      } catch {
        return undefined;
      }
    }
    const inline = /^data:([^;,]*);base64,([\s\S]*)$/i.exec(source.url);
    return inline ? chatToolImageUrl({ type: 'base64', mediaType: inline[1], data: inline[2] }) : undefined;
  }
  if (source?.type !== 'base64' || typeof source.data !== 'string' || !source.data) return undefined;
  const mediaType = resolveImageMediaType(source.data, source.media_type ?? source.mediaType);
  if (!isAcceptedImageMediaType(mediaType)) return undefined;
  return 'data:' + mediaType + ';base64,' + source.data;
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
    const text = (message.content as ChatToolOutputPart[]).map(part => {
      if (part.type === 'text') return part.text;
      const label = 'Image ' + (++imageIndex) + ' from tool result ' + JSON.stringify(message.tool_call_id);
      attachments.push({ type: 'text', text: '[' + label + ']' }, part);
      return '[' + label + ' follows in the next user message.]';
    }).join('\n');
    output.push({ ...message, content: text });
  }
  flush();
  return output;
}
