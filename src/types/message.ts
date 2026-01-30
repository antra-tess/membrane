/**
 * Normalized message types
 */

import type { ContentBlock, CacheControl } from './content.js';

// Re-export CacheControl for consumers
export type { CacheControl } from './content.js';

// ============================================================================
// Message Metadata
// ============================================================================

export interface MessageMetadata {
  /** Original timestamp */
  timestamp?: Date;
  
  /** Source ID from originating system (Discord message ID, UI message ID, etc.) */
  sourceId?: string;
  
  /** Cache control for this message */
  cacheControl?: CacheControl;
  
  /** Stream routing (for VEIL/connectome compatibility) */
  streamId?: string;
  
  /** Additional metadata (pass-through) */
  [key: string]: unknown;
}

// ============================================================================
// Normalized Message
// ============================================================================

/**
 * A message from a single participant.
 * This is the core abstraction - no artificial "user" vs "assistant" roles.
 */
export interface NormalizedMessage {
  /** Participant name: "Alice", "Bob", "Claude", etc. */
  participant: string;

  /** Content blocks */
  content: ContentBlock[];

  /** Message metadata */
  metadata?: MessageMetadata;

  /**
   * Cache breakpoint for Anthropic prompt caching.
   * When true, content up to and including this message will have cache_control applied.
   * Multiple messages can have cacheBreakpoint for multiple cache points.
   */
  cacheBreakpoint?: boolean;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Create a simple text message
 */
export function textMessage(participant: string, text: string, metadata?: MessageMetadata): NormalizedMessage {
  return {
    participant,
    content: [{ type: 'text', text }],
    metadata,
  };
}

/**
 * Extract all text content from a message
 */
export function extractText(message: NormalizedMessage): string {
  return message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/**
 * Check if message has any media content
 */
export function hasMedia(message: NormalizedMessage): boolean {
  return message.content.some((block) =>
    ['image', 'document', 'audio', 'video'].includes(block.type)
  );
}

/**
 * Check if message has tool use
 */
export function hasToolUse(message: NormalizedMessage): boolean {
  return message.content.some((block) => block.type === 'tool_use');
}
