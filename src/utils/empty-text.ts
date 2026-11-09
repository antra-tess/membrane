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
    const value = block as { type?: string; text?: unknown; cache_control?: unknown } | null;
    if (value?.type !== 'text' || hasNonEmptyText(value.text)) return true;
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

/** A request that ends with an assistant message is a prefill to the
 * provider, so the final role can't change. An effort-only system message,
 * whose `output_config` is what it sends, stays though its content is empty,
 * and the final role is read past it (lastTurnRole). */
export function stripEmptyTextMessages<T extends { content: unknown }>(
  messages: readonly T[],
  onDropped?: (block: unknown) => void,
): T[] {
  const result: T[] = [];
  for (const message of messages) {
    if (Array.isArray(message.content)) {
      const content = stripEmptyTextBlocks(message.content, onDropped);
      if (content.length > 0 || carriesOutputConfig(message)) result.push({ ...message, content });
    } else if (typeof message.content !== 'string' || hasNonEmptyText(message.content) || carriesOutputConfig(message)) {
      result.push(message);
    } else if (message.content !== '') {
      onDropped?.(undefined);
    }
  }
  const finalRole = lastTurnRole(messages);
  const retainedRole = lastTurnRole(result);
  if (result.length > 0 && typeof finalRole === 'string' && typeof retainedRole === 'string' && finalRole !== retainedRole) {
    throw invalidRequestError(`Removing empty final ${finalRole} content would change the request's final role to ${retainedRole}.`);
  }
  return result;
}

function carriesOutputConfig(message: unknown): boolean {
  return (message as { output_config?: unknown }).output_config != null;
}

/** The role of the last message that isn't an effort-only system message: the turn the request ends on. */
export function lastTurnRole(messages: readonly unknown[]): unknown {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: unknown } | undefined;
    if (!(message?.role === 'system' && carriesOutputConfig(message))) return message?.role;
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
