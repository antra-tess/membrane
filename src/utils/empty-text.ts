/**
 * Anthropic text blocks must contain non-whitespace text. Keep valid strings
 * byte-for-byte: trimming them would change prompts and cached prefixes.
 */
export function hasNonEmptyText(text: unknown): text is string {
  return typeof text === 'string' && text.trim().length > 0;
}

/** Filter text blocks only. Empty tool results and opaque non-text blocks are
 * meaningful, so keep their envelopes even when all nested text is removed. */
export function stripEmptyTextBlocks<T>(blocks: readonly T[]): T[] {
  return blocks.filter(block => {
    const value = block as { type?: string; text?: unknown } | null;
    return value?.type !== 'text' || hasNonEmptyText(value.text);
  }).map(block => {
    const value = block as { type?: string; content?: unknown } | null;
    if (value?.type === 'tool_result' && Array.isArray(value.content)) {
      return { ...block, content: stripEmptyTextBlocks(value.content) };
    }
    return block;
  });
}

/** Drop message envelopes that have no content after text filtering. */
export function stripEmptyTextMessages<T extends { content: unknown }>(messages: readonly T[]): T[] {
  const result: T[] = [];
  for (const message of messages) {
    if (Array.isArray(message.content)) {
      const content = stripEmptyTextBlocks(message.content);
      if (content.length > 0) result.push({ ...message, content });
    } else if (typeof message.content !== 'string' || hasNonEmptyText(message.content)) {
      result.push(message);
    }
  }
  return result;
}

/** Run after provider-specific passthrough parameters have been applied so
 * overrides cannot bypass the wire-boundary cleanup. This mutates only the
 * newly built request; caller-owned message and content objects stay intact. */
export function stripEmptyTextRequest<T extends { messages: { content: unknown }[]; system?: unknown }>(request: T): void {
  request.messages = stripEmptyTextMessages(request.messages);
  if (Array.isArray(request.system)) {
    const system = stripEmptyTextBlocks(request.system);
    if (system.length > 0) request.system = system;
    else delete request.system;
  } else if (typeof request.system === 'string' && !hasNonEmptyText(request.system)) {
    delete request.system;
  }
}
