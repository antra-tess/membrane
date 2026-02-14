/**
 * Content block types for normalized messages
 */

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
}

export interface DocumentContent {
  type: 'document';
  source: Base64Source;
  filename?: string;
}

export interface AudioContent {
  type: 'audio';
  source: Base64Source;
  duration?: number; // seconds
}

export interface VideoContent {
  type: 'video';
  source: Base64Source;
  duration?: number; // seconds
}

// ============================================================================
// Media Output Content (Generated)
// ============================================================================

export interface GeneratedImageContent {
  type: 'generated_image';
  data: string;
  mimeType: string;
  isPreview?: boolean; // Streaming: preview vs final
}

// ============================================================================
// Tool Content
// ============================================================================

export interface ToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultContent {
  type: 'tool_result';
  toolUseId: string;
  content: string | ContentBlock[];
  isError?: boolean;
}

// ============================================================================
// Thinking Content
// ============================================================================

export interface ThinkingContent {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

export interface RedactedThinkingContent {
  type: 'redacted_thinking';
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
