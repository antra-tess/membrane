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
  /**
   * Opaque provider-native item this block was derived from (e.g. an OpenAI
   * Responses output item, or an Anthropic server-tool block). Formatters
   * for its own wire replay it verbatim; other providers must ignore it. A
   * zero-width carrier (`text: ''` plus `rawItem`) has no normalized
   * equivalent. Membrane's build for an adapter that declares
   * `replaysAnthropicServerBlocks` (AnthropicAdapter) sends one holding an
   * Anthropic server-tool block as that block, in the assistant turn that
   * produced it (`utils/anthropic-server-blocks.ts`), unless the block can't
   * go alone there: a server call with no result after it in its turn, or a
   * result with no call before it, is left out and its message reported, and
   * the request's final message, if it's the assistant's, keeps its lone
   * calls. Membrane's build for any other adapter, Bedrock's included, leaves
   * it out; an adapter's own `buildRequest` sends what it is given. Every
   * Anthropic-shaped build filters out any other carrier, since Anthropic
   * rejects empty text blocks. Text serializations leave it out.
   *
   * Where it is replayed, it goes out in place of this block's other fields,
   * which are not read: a consumer that changes the block's content
   * (compression, redaction) must drop or replace `rawItem` too, or the
   * change won't reach the provider, and round reports count the block as
   * carried when its item is (utils/fidelity.ts). A path that leaves out a
   * zero-width carrier reports its message altered.
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
   *
   * Replayed in place of the block's other fields (`name`, `input`), which
   * the prefill path then doesn't read: a consumer that changes the call
   * (truncating its input, say) must drop or replace `rawXml` too, or the
   * change won't reach the provider, and round reports count the block as
   * carried when its raw text is (utils/fidelity.ts).
   */
  rawXml?: string;
  /**
   * The model's arguments as they came, kept verbatim, when they weren't a
   * JSON object.
   *
   * Present when the argument text a provider sent didn't parse, or parsed to
   * something other than an object (null, a number, a string, a boolean or an
   * array), and when an Anthropic or Bedrock stream ended before a call's
   * block finished (no content_block_stop), whatever had arrived of its
   * arguments, even nothing: then it is the empty string. A call truncated by
   * max_tokens is the usual cause. Where arguments come as a value rather
   * than text (Gemini's, or an `input` that isn't an object), it holds that
   * value as JSON. It is also set on every tool_use block of a streamed
   * Anthropic or Bedrock response whose block events broke the API's order
   * (a block started while another was open or out of index order, a delta
   * or stop while no block was open or for a block other than the open one,
   * or a delta a tool call can't take), holding the arguments the
   * call had, as JSON when they had parsed: such a stream can't vouch for
   * which call any arguments belong to, so none of its calls is taken as
   * complete. (In Bedrock a start above the next index fails the call
   * instead, over the block it skipped.)
   * `input` is then `{}`, or for a streamed Anthropic or Bedrock call
   * whatever its content_block_start carried: a wire-valid tool call with
   * empty arguments, indistinguishable from a genuine no-arg call
   * once it is written to durable history. Presence of this field, the empty
   * string included, means `input` is NOT the model's arguments, so a
   * consumer can refuse the block (or attempt its own repair) instead of
   * trusting a plausible `{}`. The call's ToolCall carries it too. A
   * request sends `input` as stored, so round reports don't count a marked
   * call as altered: this field records the replacement.
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
   * from that block. Replayed exactly on the prefill path (membrane#36), in
   * place of the block's other fields (`content`, `toolName`, `isError`): a
   * consumer that changes the result (truncating it, say) must drop or
   * replace `rawXml` too, or the change won't reach the provider, and round
   * reports count the block as carried when its raw text is
   * (utils/fidelity.ts). Where `rawXmlImagesAt` is set, the replay can also
   * send the images the turn sent, from `content`, at that place (see there).
   */
  rawXml?: string;
  /**
   * Set on the result whose images an XML tool loop sent in a user turn of
   * their own, splitting its results block: the offset in `rawXml` where the
   * split fell. Its `content` then holds what the tool returned, images
   * included. The prefill path replays `rawXml` split at that offset, with
   * the images from `content` that an XML split sends (the accepted image
   * formats) between the two parts, as the turn sent it, and the images are
   * carried with the raw text. It sends `rawXml` whole instead when the
   * offset no longer falls where a result or error in the block closes, or when
   * `content` holds no image a split sends; if `content` still holds an image
   * then, the request leaves it out and the round report counts the message
   * altered. A message that also carries images of its own goes to the
   * provider as one user turn, with these images where the split fell. What
   * the turn added after the block, such as the thinking opener a thinking
   * turn writes there, replays as it did before. A consumer that changes the
   * result, removing an image included, drops this with `rawXml`: the result
   * then renders from `content`, with a note where an image isn't sent.
   * Results with the same `rawXml` replay as one block, its text sent once,
   * for as many results as the parser reads from that text; more results
   * with the same text are another round's, and replay as a block of their
   * own, as does a second result with this mark. The count is the parser's
   * reading today, so it holds while the parser reads the text as the turn's
   * parse did.
   */
  rawXmlImagesAt?: number;
  /** See {@link TextContent.rawItem}. */
  rawItem?: unknown;
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
