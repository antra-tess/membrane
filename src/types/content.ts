/**
 * Content block types for normalized messages
 */

import type { ToolCallNotice } from './tools.js';

// ============================================================================
// Cache Control (Anthropic prompt caching)
// ============================================================================

export interface CacheControl {
  type: 'ephemeral';
  /** TTL for cache - '5m' (default) or '1h' for extended caching */
  ttl?: '5m' | '1h';
}

// ============================================================================
// Media Source
// ============================================================================

export interface Base64Source {
  type: 'base64';
  data: string;
  mediaType: string;
}

export interface UrlSource {
  type: 'url';
  url: string;
}

export type MediaSource = Base64Source | UrlSource;

// ============================================================================
// Text Content
// ============================================================================

export interface TextContent {
  type: 'text';
  text: string;
  /** Cache control for Anthropic prompt caching */
  cache_control?: CacheControl;
  /**
   * Opaque provider-native item this block was derived from (e.g. an OpenAI
   * Responses output item). Provider-native formatters replay it verbatim;
   * other providers must ignore it. A zero-width carrier (`text: ''` plus
   * `rawItem`) has no normalized equivalent and must be filtered out of
   * requests for providers that reject empty text blocks (Anthropic).
   */
  rawItem?: unknown;
}

// ============================================================================
// Media Input Content
// ============================================================================

export interface ImageContent {
  type: 'image';
  source: MediaSource;
  tokenEstimate?: number;
  /** Original URL of the image (e.g., Discord CDN). Used by providers that
   *  can auto-fetch URLs from text (like Gemini 3.x) when inlineData is
   *  not viable (e.g., missing thought_signature on model-role images). */
  sourceUrl?: string;
  /** See {@link TextContent.rawItem}. */
  rawItem?: unknown;
}

export interface DocumentContent {
  type: 'document';
  source: Base64Source;
  filename?: string;
  /** See {@link TextContent.rawItem}. */
  rawItem?: unknown;
}

export interface AudioContent {
  type: 'audio';
  source: Base64Source;
  duration?: number; // seconds
  /** See {@link TextContent.rawItem}. */
  rawItem?: unknown;
}

export interface VideoContent {
  type: 'video';
  source: Base64Source;
  duration?: number; // seconds
  /** See {@link TextContent.rawItem}. */
  rawItem?: unknown;
}

// ============================================================================
// Media Output Content (Generated)
// ============================================================================

export interface GeneratedImageContent {
  type: 'generated_image';
  data: string;
  mimeType: string;
  isPreview?: boolean; // Streaming: preview vs final
  /** See {@link TextContent.rawItem}. */
  rawItem?: unknown;
}

// ============================================================================
// Tool Content
// ============================================================================

export interface ToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  /**
   * Verbatim document text this call was parsed from in prefill/XML mode:
   * the full `<function_calls>…</function_calls>` block, shared by every
   * invoke parsed from that block. Prefill formatters replay it exactly
   * instead of synthesizing a rendering — in prefill mode the context IS
   * the document the agent authored, and a paraphrase of its own action
   * both corrupts the record and teaches the model a syntax the parser
   * does not accept (membrane#36). Analogous to `signature` on a thinking
   * block. Absent on native-tools blocks and on legacy stored blocks.
   */
  rawXml?: string;
  /**
   * Raw accumulated argument text that FAILED to parse as JSON, kept verbatim.
   *
   * Present only when the provider's streamed `input_json_delta` fragments did
   * not assemble into valid JSON — a call truncated mid-arguments (max_tokens)
   * is the usual cause. `input` then holds whatever the provider's
   * content_block_start carried, which for Anthropic is `{}`: a wire-valid
   * tool call with empty arguments, indistinguishable from a genuine no-arg
   * call once it is written to durable history. Presence of this field means
   * `input` is NOT the model's arguments, so a consumer can refuse the block
   * (or attempt its own repair) instead of trusting a plausible `{}`.
   */
  unparseableInput?: string;

  /** See {@link TextContent.rawItem}. */
  rawItem?: unknown;
}

export interface ToolResultContent {
  type: 'tool_result';
  toolUseId: string;
  /**
   * Tool name, persisted so XML replay can reconstruct the legacy
   * `<tool_name>` element byte-identically to the live injection.
   */
  toolName?: string;
  content: string | ContentBlock[];
  isError?: boolean;
  /**
   * Verbatim document text this result was parsed from in prefill/XML mode:
   * the full `<function_results>…</function_results>` block as the harness
   * originally placed it in the document, shared by every result parsed
   * from that block. Replayed exactly on the prefill path (membrane#36).
   */
  rawXml?: string;
  /** See {@link TextContent.rawItem}. */
  rawItem?: unknown;
}

/**
 * A `<function_calls>` block, in prefill/XML mode, that dispatched nothing:
 * the parser refused every invoke in it (see {@link ToolNoticeContent}).
 *
 * It is the model's own text, kept so replay shows the attempt exactly as
 * written. It is not a call — nothing ran, and no tool_result answers it — so
 * it is never a tool_use, and it is not prose either: it is never outward
 * speech. When at least one invoke in a block is a call (dispatched, or
 * eligible for dispatch), the tool_use blocks carry the block's `rawXml`
 * instead and no tool_attempt is needed.
 * Prefill formatters replay `rawXml` verbatim; other formatters render it as
 * the assistant's text.
 */
export interface ToolAttemptContent {
  type: 'tool_attempt';
  /** The full `<function_calls>…</function_calls>` block, exactly as written. */
  rawXml: string;
}

/**
 * The harness's notice about a `<function_calls>` block's refused or warned
 * invokes: what the model read, inside the `<function_results>` that answered
 * the block, after every result.
 *
 * It is the harness speaking — like tool_result, not like the assistant — and
 * it sits after the round's tool_result blocks. Prefill formatters render it
 * back into the same `<function_results>` envelope the live loop wrote; other
 * formatters render it as attributed text on the harness side, after any
 * tool_result blocks. It is never passed to a provider as a block of its own.
 */
export interface ToolNoticeContent {
  type: 'tool_notice';
  notices: ToolCallNotice[];
}

// ============================================================================
// Thinking Content
// ============================================================================

export interface ThinkingContent {
  type: 'thinking';
  thinking: string;
  signature?: string;
  /** See {@link TextContent.rawItem}. */
  rawItem?: unknown;
}

export interface RedactedThinkingContent {
  type: 'redacted_thinking';
  /**
   * Encrypted reasoning payload from the provider. Opaque — must be
   * round-tripped verbatim in assistant turns or the block is worthless
   * (the API decrypts it to reconstruct prior reasoning).
   */
  data: string;
  /** See {@link TextContent.rawItem}. */
  rawItem?: unknown;
}

// ============================================================================
// Union Type
// ============================================================================

export type ContentBlock =
  // Text
  | TextContent
  // Media Input
  | ImageContent
  | DocumentContent
  | AudioContent
  | VideoContent
  // Media Output
  | GeneratedImageContent
  // Tools
  | ToolUseContent
  | ToolResultContent
  | ToolAttemptContent
  | ToolNoticeContent
  // Thinking
  | ThinkingContent
  | RedactedThinkingContent;

// ============================================================================
// Type Guards
// ============================================================================

export function isTextContent(block: ContentBlock): block is TextContent {
  return block.type === 'text';
}

export function isImageContent(block: ContentBlock): block is ImageContent {
  return block.type === 'image';
}

export function isDocumentContent(block: ContentBlock): block is DocumentContent {
  return block.type === 'document';
}

export function isAudioContent(block: ContentBlock): block is AudioContent {
  return block.type === 'audio';
}

export function isVideoContent(block: ContentBlock): block is VideoContent {
  return block.type === 'video';
}

export function isGeneratedImageContent(block: ContentBlock): block is GeneratedImageContent {
  return block.type === 'generated_image';
}

export function isToolUseContent(block: ContentBlock): block is ToolUseContent {
  return block.type === 'tool_use';
}

export function isToolResultContent(block: ContentBlock): block is ToolResultContent {
  return block.type === 'tool_result';
}

export function isToolAttemptContent(block: ContentBlock): block is ToolAttemptContent {
  return block.type === 'tool_attempt';
}

export function isToolNoticeContent(block: ContentBlock): block is ToolNoticeContent {
  return block.type === 'tool_notice';
}

export function isThinkingContent(block: ContentBlock): block is ThinkingContent {
  return block.type === 'thinking';
}

export function isRedactedThinkingContent(block: ContentBlock): block is RedactedThinkingContent {
  return block.type === 'redacted_thinking';
}

export function isMediaContent(
  block: ContentBlock
): block is ImageContent | DocumentContent | AudioContent | VideoContent {
  return ['image', 'document', 'audio', 'video'].includes(block.type);
}
