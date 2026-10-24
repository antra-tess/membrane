/**
 * What kind of HTTP 400 a provider sent, as a closed vocabulary: a template
 * id for its message, and the field path the message opens with. Neither
 * carries text from the request or the error, so an observer can count 400s
 * by kind without holding anything a request said.
 */

import { extractProviderErrorFields } from '../types/errors.js';

/** One kind of 400, by the provider's own wording of it. */
export interface BadRequestTemplate {
  /** A stable id for the kind. */
  id: string;
  /**
   * Matched against the provider's message after any field path it opens
   * with (`messages.1.content.0: `), or the whole message when it opens
   * with none.
   */
  pattern: RegExp;
}

/**
 * The Anthropic API's wordings, in a 400, for a model that takes no
 * mid-conversation system message or no tool change in one (live runs, Oct 19
 * 2026). AnthropicAdapter marks such a 400 `systemChangeRefused`.
 */
export const SYSTEM_CHANGE_REFUSALS: readonly string[] = [
  "role 'system' is not supported on this model",
  'tool_addition/tool_removal requires a model that supports mid-conversation system content',
  'tool_addition/tool_removal is not supported on this model',
];

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The 400 kinds membrane knows, in the order they're tried: the first whose
 * pattern matches names the 400. They are the Anthropic API's wordings for
 * the request shapes membrane's own code guards against and those its users'
 * requests have met, plus the API's generic validation messages, whose field
 * path says where, and two shapes of OpenAI's.
 */
export const BAD_REQUEST_TEMPLATES: readonly BadRequestTemplate[] = [
  // The model and its parameters.
  { id: 'prefill_unsupported', pattern: /^This model does not support assistant message prefill\b/ },
  { id: 'sampling_parameter_deprecated', pattern: /^`(?:temperature|top_p|top_k)` is deprecated for this model\b/ },
  // Anywhere in the message, as isSystemChangeRefusal reads it.
  { id: 'system_change_unsupported', pattern: new RegExp(SYSTEM_CHANGE_REFUSALS.map(escapeRegExp).join('|')) },
  { id: 'thinking_type_unsupported', pattern: /^(?:"thinking\.type\.\w+" is not supported for this model|adaptive thinking is not supported on this model)\b/ },
  { id: 'effort_unsupported', pattern: /^output_config\.effort requires a model that supports per-turn effort\b/ },
  { id: 'tool_choice_unsupported', pattern: /^type "tool" and "any" are not supported for this model\b/ },
  { id: 'max_tokens_not_above_thinking_budget', pattern: /^`max_tokens` must be greater than `thinking\.budget_tokens`/ },
  { id: 'prompt_too_long', pattern: /^prompt is too long: \d+ tokens > \d+ maximum\b/ },
  // Thinking blocks sent back.
  { id: 'thinking_bound_elsewhere', pattern: /^Invalid `signature` in `thinking` block\. The block is bound to a different conversation\b/ },
  { id: 'thinking_signature_invalid', pattern: /^Invalid `signature` in `thinking` block\b/ },
  { id: 'redacted_thinking_data_invalid', pattern: /^Invalid `data` in `redacted_thinking` block\b/ },
  { id: 'thinking_blocks_modified', pattern: /^`thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified\b/ },
  { id: 'thinking_last_in_assistant', pattern: /^The final block in an assistant message cannot be `thinking`/ },
  // Tool calls and their results.
  { id: 'tool_use_without_result', pattern: /^`tool_use` ids were found without `tool_result` blocks immediately after\b/ },
  { id: 'server_tool_use_without_result', pattern: /^`\w+`(?: tool use)? with id `[^`]*` was found without a corresponding `\w+` block\b/ },
  { id: 'tool_result_without_use', pattern: /^unexpected `tool_use_id` found in `\w+` blocks\b/ },
  { id: 'tool_use_ids_duplicate', pattern: /^`(?:tool_use|server_tool_use)` ids must be unique\b/ },
  { id: 'tool_result_error_empty', pattern: /^content cannot be empty if `is_error` is true\b/ },
  { id: 'tool_result_error_not_text', pattern: /^all content must be type `text` if `is_error` is true\b/ },
  { id: 'tool_names_not_unique', pattern: /^Tool names must be unique\b/ },
  { id: 'tool_schema_root_combinator', pattern: /^input_schema does not support oneOf, allOf, or anyOf at the top level\b/ },
  // Cache markers.
  { id: 'cache_control_limit', pattern: /^A maximum of \d+ blocks with cache_control may be provided\b/ },
  { id: 'cache_control_nested', pattern: /^cache_control may not be specified within `[^`]+`/ },
  { id: 'cache_ttl_order', pattern: /^a ttl='[^']*' cache_control block must not come after a ttl='[^']*' cache_control block\b/ },
  { id: 'cache_control_on_empty_text', pattern: /^cache_control cannot be set for empty text blocks\b/ },
  // Media.
  { id: 'image_url_unsupported', pattern: /^URL image sources are not supported\b/ },
  { id: 'image_not_its_media_type', pattern: /^The image was specified using the [\w./+-]+ media type, but does not appear to be a valid [\w./+-]+ image\b/ },
  { id: 'image_empty', pattern: /^image cannot be empty\b/ },
  { id: 'document_empty', pattern: /^document content cannot be empty\b/ },
  { id: 'too_many_media', pattern: /^too many images and documents: \d+ \+ \d+ > \d+/ },
  // Messages.
  { id: 'user_content_empty', pattern: /^user messages must have non-empty content\b/ },
  { id: 'messages_empty', pattern: /^at least one message is required\b/ },
  { id: 'final_assistant_trailing_whitespace', pattern: /^final assistant content cannot end with trailing whitespace\b/ },
  // The API's generic validation messages: the field path says where.
  { id: 'field_required', pattern: /^Field required\b/ },
  { id: 'extra_input', pattern: /^Extra inputs are not permitted\b/ },
  { id: 'unknown_tag', pattern: /^Input tag '[^']*' found using '[^']*' does not match any of the expected tags\b/ },
  { id: 'invalid_input', pattern: /^Input should be\b/ },
  // OpenAI.
  { id: 'unsupported_parameter', pattern: /^Unsupported parameter: / },
  { id: 'unsupported_value', pattern: /^Unsupported value: / },
];

/**
 * The field names of the Anthropic Messages API's request schema, which
 * BedrockAdapter's body follows too: its parameters, message and
 * content-block fields, block and source types, and tool and thinking
 * settings. A 400's field path is kept only when every segment that isn't a
 * number is one of these, so a kept path holds nothing but these names and
 * `N`, whatever names a request chose, such as a tool schema's properties.
 */
export const REQUEST_FIELD_NAMES: readonly string[] = [
  // Parameters.
  'model', 'messages', 'system', 'max_tokens', 'metadata', 'user_id', 'stop_sequences', 'stream',
  'temperature', 'top_p', 'top_k', 'tools', 'tool_choice', 'thinking', 'service_tier', 'container',
  'mcp_servers', 'context_management', 'output_config', 'output_format', 'effort',
  // Messages and content blocks.
  'role', 'content', 'type', 'text', 'cache_control', 'ttl', 'citations', 'enabled',
  'image', 'document', 'search_result', 'source', 'data', 'media_type', 'url', 'file_id', 'file',
  'base64', 'title', 'context', 'tool_use', 'tool_result', 'id', 'name', 'input', 'tool_use_id',
  'is_error', 'redacted_thinking', 'signature', 'server_tool_use', 'web_search_tool_result',
  'web_fetch_tool_result', 'code_execution_tool_result', 'bash_code_execution_tool_result',
  'text_editor_code_execution_tool_result', 'tool_search_tool_result', 'mcp_tool_use',
  'mcp_tool_result', 'server_name', 'container_upload', 'tool_reference', 'tool_name',
  // Tools and their choice.
  'custom', 'description', 'input_schema', 'properties', 'required', 'strict', 'defer_loading',
  'disable_parallel_tool_use', 'auto', 'any', 'tool', 'none',
  // Thinking.
  'budget_tokens', 'display', 'adaptive', 'disabled', 'block_binding', 'prefix_mismatch_behavior',
];

const FIELD_NAMES = new Set(REQUEST_FIELD_NAMES);

/** A field path a message opens with, as the Anthropic API writes one: `messages.1.content.0: `. */
const LEADING_PATH = /^([A-Za-z_]\w*(?:\.\w+)*): /;

/**
 * Classify a provider's 400 message: the template it matches, and the field
 * path it opens with when every segment is a number (given as `N`) or a
 * request field name. Each is left out when it doesn't apply.
 */
export function classifyBadRequest(message: string): { template?: string; fieldPath?: string } {
  const leading = LEADING_PATH.exec(message);
  const tail = leading ? message.slice(leading[0].length) : message;
  const template = BAD_REQUEST_TEMPLATES.find(({ pattern }) => pattern.test(tail))?.id;
  const segments = leading ? leading[1]!.split('.') : [];
  const fieldPath = segments.length > 0 && segments.every((s) => /^\d+$/.test(s) || FIELD_NAMES.has(s))
    ? segments.map((s) => (/^\d+$/.test(s) ? 'N' : s)).join('.')
    : undefined;
  return { ...(template ? { template } : {}), ...(fieldPath ? { fieldPath } : {}) };
}

/**
 * The provider's own message on an error membrane typed, from its raw error:
 * the body an SDK error carries as `error` (Anthropic's), or the body a fetch
 * adapter keeps as the raw error itself, parsed or as text (Bedrock's). Behind
 * a router that wraps the provider's error (OpenRouter's `metadata.raw`), it's
 * the provider's message, not the router's. Another Error carries none: its
 * own message is the error's rendering, not the provider's words. So an
 * exception inside a Bedrock stream, which BedrockAdapter keeps only in such
 * a rendering, has no message here, and its 400 no template or path.
 */
export function providerMessageOf(rawError: unknown): string | undefined {
  if (rawError !== null && typeof rawError === 'object') {
    const raw = rawError as Record<string, unknown>;
    // A serialized Error (serializeError keeps its name and message).
    if (typeof raw.name === 'string' && typeof raw.message === 'string') {
      return ownMessage(extractProviderErrorFields(raw.error));
    }
  }
  return ownMessage(extractProviderErrorFields(rawError));
}

function ownMessage(fields: ReturnType<typeof extractProviderErrorFields>): string | undefined {
  return fields.upstreamMessage ?? fields.message;
}
