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

/** null lets the adapter retain the exact legacy image-free wire form. */
export function toolOutputParts(content: unknown, isError = false): ToolOutputPart[] | null {
  if (!Array.isArray(content) || !content.some(b => b?.type === 'image')) return null;
  const parts: ToolOutputPart[] = isError ? [{ type: 'text', text: '[Tool result error]' }] : [];
  for (const block of content) {
    if (block?.type === 'image') {
      parts.push({ type: 'image', source: block.source });
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
export function chatToolResultContent(block: any): string | ChatToolOutputPart[] {
  const parts = toolOutputParts(block.content, block.is_error ?? block.isError);
  if (!parts) return typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
  return parts.map(part => {
    if (part.type === 'text') return part;
    const source = part.source;
    const url = source?.type === 'base64' && typeof source.data === 'string' && source.data
      ? 'data:' + (source.media_type ?? source.mediaType ?? 'image/png') + ';base64,' + source.data
      : source?.type === 'url' && typeof source.url === 'string' && source.url ? source.url : undefined;
    return url
      ? { type: 'image_url', image_url: { url } }
      : { type: 'text', text: '[image omitted: unsupported image source]' };
  });
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
