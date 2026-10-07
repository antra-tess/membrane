import { invalidRequestError } from '../types/errors.js';

/**
 * Retain non-whitespace text under the Anthropic/Bedrock cleanup policy.
 * Keep remaining strings byte-for-byte: trimming them changes cached prefixes.
 */
export function hasNonEmptyText(text: unknown): text is string {
  return typeof text === 'string' && text.trim().length > 0;
}

/** Filter text blocks only. Empty tool results and opaque non-text blocks are
 * meaningful, so keep their envelopes even when all nested text is removed.
 * `onDropped` hears each removed block that held whitespace (an exactly
 * empty '' block carried nothing): the removal is the cleanup policy, but the
 * text it held did not reach the provider. */
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
      return { ...block, content: stripEmptyTextBlocks(value.content, onDropped as ((nested: unknown) => void) | undefined) };
    }
    return block;
  });
  if (removedMarkers > 0) {
    console.warn(`[membrane] empty-text cleanup removed ${removedMarkers} cache_control marker(s) from invalid text blocks`);
  }
  return result;
}

/** Drop empty envelopes, but refuse to turn a reply request into a prefill
 * (or the reverse) by changing the final retained role. */
export function stripEmptyTextMessages<T extends { content: unknown }>(
  messages: readonly T[],
  onDropped?: (block: unknown) => void,
): T[] {
  const result: T[] = [];
  for (const message of messages) {
    if (Array.isArray(message.content)) {
      const content = stripEmptyTextBlocks(message.content, onDropped);
      if (content.length > 0) result.push({ ...message, content });
    } else if (typeof message.content !== 'string' || hasNonEmptyText(message.content)) {
      result.push(message);
    } else if (message.content !== '') {
      onDropped?.(undefined);
    }
  }
  const finalRole = (messages.at(-1) as { role?: unknown } | undefined)?.role;
  const retainedRole = (result.at(-1) as { role?: unknown } | undefined)?.role;
  if (result.length > 0 && typeof finalRole === 'string' && typeof retainedRole === 'string' && finalRole !== retainedRole) {
    throw invalidRequestError(`Removing empty final ${finalRole} content would change the request's final role to ${retainedRole}.`);
  }
  return result;
}

/** Run after provider-specific passthrough parameters have been applied so
 * overrides cannot bypass the wire-boundary cleanup. This mutates only the
 * newly built request; caller-owned message and content objects stay intact. */
export function stripEmptyTextRequest<T extends { messages: { content: unknown }[]; system?: unknown }>(
  request: T,
  /** Hears each message block removed that held whitespace (the system prompt is not a message). */
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
