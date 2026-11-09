import { invalidRequestError } from '../types/errors.js';

/**
 * The Anthropic API refuses text blocks that are only whitespace; other text
 * is kept byte for byte, since trimming it would change a cached prefix.
 */
export function hasNonEmptyText(text: unknown): text is string {
  return typeof text === 'string' && text.trim().length > 0;
}

/** A tool_result answers its call even when all its text is removed, so its
 * envelope stays. */
export function stripEmptyTextBlocks<T>(blocks: readonly T[], onDropped?: (block: T) => void): T[] {
  let removedMarkers = 0;
  const result = blocks.filter(block => {
    if (!isEmptyTextBlock(block)) return true;
    const value = block as { text?: unknown; cache_control?: unknown };
    if (value.cache_control) removedMarkers++;
    if (typeof value.text === 'string' && value.text !== '') onDropped?.(block);
    return false;
  }).map(block => {
    const value = block as { type?: string; content?: unknown } | null;
    if (value?.type === 'tool_result' && Array.isArray(value.content)) {
      const held: unknown[] = value.content;
      const content = stripEmptyTextBlocks(held, onDropped as ((nested: unknown) => void) | undefined);
      return content.length === held.length && content.every((nested, i) => nested === held[i]) ? block : { ...block, content };
    }
    return block;
  });
  if (removedMarkers > 0) {
    console.warn(`[membrane] empty-text cleanup removed ${removedMarkers} cache_control marker(s) from invalid text blocks`);
  }
  return result;
}

function isEmptyTextBlock(block: unknown): boolean {
  const value = block as { type?: string; text?: unknown } | null;
  return value?.type === 'text' && !hasNonEmptyText(value.text);
}

/** A request that ends with an assistant message is a prefill to the
 * provider, so the final role can't change. An effort-only system message
 * stays, with its content emptied, since the API refuses whitespace text in
 * it. */
export function stripEmptyTextMessages<T extends { content: unknown }>(
  messages: readonly T[],
  onDropped?: (block: unknown) => void,
): T[] {
  const result: T[] = [];
  for (const message of messages) {
    if (Array.isArray(message.content)) {
      const content = stripEmptyTextBlocks(message.content, onDropped);
      if (content.length > 0 || isEffortOnlyMessage(message)) result.push({ ...message, content });
    } else if (typeof message.content !== 'string' || hasNonEmptyText(message.content)) {
      result.push(message);
    } else {
      if (message.content !== '') onDropped?.(undefined);
      if (isEffortOnlyMessage(message)) result.push(message.content === '' ? message : { ...message, content: '' });
    }
  }
  const finalRole = lastTurnRole(messages);
  const retainedRole = lastTurnRole(result);
  if (result.length > 0 && typeof finalRole === 'string' && typeof retainedRole === 'string' && finalRole !== retainedRole) {
    throw invalidRequestError(`Removing empty final ${finalRole} content would change the request's final role to ${retainedRole}.`);
  }
  return result;
}

export function isEffortOnlyMessage(message: unknown): boolean {
  if (message === null || typeof message !== 'object') return false;
  const { role, output_config, content } = message as { role?: unknown; output_config?: unknown; content?: unknown };
  const empty = Array.isArray(content) ? content.every(isEmptyTextBlock) : typeof content === 'string' && !hasNonEmptyText(content);
  return role === 'system' && output_config != null && empty;
}

export function lastTurnRole(messages: readonly unknown[]): unknown {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: unknown } | undefined;
    if (!isEffortOnlyMessage(message)) return message?.role;
  }
  return undefined;
}

export function stripEmptyTextAfterPassthrough<T extends { messages: { content: unknown }[]; system?: unknown }>(
  request: T,
  onDropped?: (block: unknown) => void,
): void {
  request.messages = stripEmptyTextMessages(request.messages, onDropped);
  if (Array.isArray(request.system)) {
    const system = stripEmptyTextBlocks(request.system);
    if (system.length > 0) request.system = system;
    else delete request.system;
  } else if (typeof request.system === 'string' && !hasNonEmptyText(request.system)) {
    delete request.system;
  }
}
