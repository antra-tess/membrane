import type { ProviderRequest } from '../types/index.js';
import { resolveImageMediaType } from '../utils/image-media.js';
import type { OpenAIResponsesInputItem } from './openai-responses-api.js';

type JsonObject = Record<string, unknown>;

/**
 * Most agent turns arrive already formatted as provider-native Responses
 * items. Internal maintenance calls, however, can bypass that formatter and
 * carry Membrane's normalized `text`/`image`/tool blocks. Normalize at the
 * final transport boundary so every call shape accepted by ProviderAdapter is
 * valid on the Codex Responses endpoint.
 */
export function normalizeResponsesInput(
  messages: ProviderRequest['messages'],
  /**
   * Hears each content block this normalization leaves out, and each tool
   * result whose nested content it can't carry as it was.
   */
  onDropped?: () => void,
): OpenAIResponsesInputItem[] {
  const output: unknown[] = [];

  for (const rawMessage of messages as unknown[]) {
    if (!isObject(rawMessage)) {
      output.push(rawMessage);
      continue;
    }
    if (rawMessage.type !== 'message' && rawMessage.role === undefined) {
      output.push(normalizeStandaloneItem(rawMessage, onDropped));
      continue;
    }

    // Native messages (including phase, status and developer/system roles)
    // must survive replay verbatim. Only translate normalized content blocks.
    if (Array.isArray(rawMessage.content) && !rawMessage.content.some((block) =>
      isObject(block) && ['text', 'image', 'tool_use', 'tool_result', 'redacted_thinking'].includes(asString(block.type))
    )) {
      output.push(rawMessage);
      continue;
    }
    const role = typeof rawMessage.role === 'string' ? rawMessage.role : 'user';
    const blocks = Array.isArray(rawMessage.content)
      ? rawMessage.content
      : typeof rawMessage.content === 'string'
        ? [{ type: 'text', text: rawMessage.content }]
        : [];
    let parts: unknown[] = [];
    const flush = () => {
      if (parts.length === 0) return;
      output.push({
        type: 'message',
        ...rawMessage,
        role,
        content: parts,
      });
      parts = [];
    };

    for (const rawBlock of blocks) {
      if (!isObject(rawBlock)) {
        onDropped?.();
        continue;
      }
      if (rawBlock.type === 'text') {
        parts.push({ type: role === 'assistant' ? 'output_text' : 'input_text', text: asString(rawBlock.text) });
      } else if (rawBlock.type === 'image') {
        const imageUrl = responsesImageUrl(rawBlock);
        if (imageUrl && role !== 'assistant') parts.push({ type: 'input_image', image_url: imageUrl });
        else onDropped?.();
      } else if (rawBlock.type === 'tool_use') {
        flush();
        output.push(normalizeStandaloneItem(rawBlock));
      } else if (rawBlock.type === 'tool_result') {
        flush();
        output.push(normalizeStandaloneItem(rawBlock, onDropped));
      } else if (rawBlock.type === 'redacted_thinking') {
        flush();
        output.push(reasoningInputItem(rawBlock));
      } else {
        // Already-native input_text/output_text/input_image/refusal parts.
        parts.push(rawBlock);
      }
    }
    flush();
  }

  return output as OpenAIResponsesInputItem[];
}

function normalizeStandaloneItem(item: JsonObject, onDropped?: () => void): unknown {
  if (item.type === 'tool_use') {
    return {
      type: 'function_call',
      call_id: asString(item.id),
      name: asString(item.name),
      arguments: JSON.stringify(isObject(item.input) ? item.input : {}),
    };
  }
  if (item.type === 'tool_result') {
    const content = item.content;
    // A nested value the output can't carry is stringified or replaced by a note.
    if (responsesToolOutputLoses(content)) onDropped?.();
    return {
      type: 'function_call_output',
      call_id: asString(item.toolUseId) || asString(item.tool_use_id),
      output: typeof content === 'string'
        ? content
        : responsesToolOutputParts(content) ?? JSON.stringify(content ?? null),
    };
  }
  if (item.type === 'redacted_thinking') {
    return reasoningInputItem(item);
  }
  return item;
}

/** Replay a captured reasoning carrier as a Responses input item.
 *
 * Prefer the provider-native item verbatim when the block still carries it
 * (`rawItem` from response parsing). Otherwise reconstruct the minimum the
 * Responses API accepts: `summary` is a REQUIRED field on reasoning input
 * items (empty array = "no summaries") — omitting it 400s with
 * "Missing required parameter: 'input[N].summary'". */
function reasoningInputItem(block: JsonObject): unknown {
  const raw = block.rawItem;
  if (isObject(raw) && raw.type === 'reasoning') return raw;
  return { type: 'reasoning', summary: [], encrypted_content: asString(block.data) };
}

/**
 * Whether a tool result's content loses something on its way to a Responses
 * `function_call_output`: a nested block that is neither text nor an image
 * the output can carry (it is JSON-stringified or replaced by a note).
 */
export function responsesToolOutputLoses(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    if (typeof block === 'string') return false;
    if (!isObject(block)) return true;
    if (block.type === 'text' || block.type === 'input_text' || block.type === 'input_image') return false;
    if (block.type === 'image') return !responsesImageUrl(block);
    return true;
  });
}

/**
 * `function_call_output.output` as a native content-part array, for tool
 * results that carry images. Responses accepts `output` as a string OR an
 * array of input_text / input_image parts; stringifying an image-bearing
 * result hands the model its base64 as TEXT — no vision, and ~1 token per
 * 2 base64 chars (a 760 KB snapshot ≈ 500k input tokens; probed live on the
 * Codex backend 2026-10-02: array form = 526 tokens and the model describes
 * the image). Returns null for image-free content so callers keep their
 * legacy string form and existing replay bytes don't change.
 */
export function responsesToolOutputParts(content: unknown): unknown[] | null {
  if (!Array.isArray(content)) return null;
  if (!content.some((block) => isObject(block) && (block.type === 'image' || block.type === 'input_image'))) {
    return null;
  }
  const parts: unknown[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push({ type: 'input_text', text: block });
    } else if (!isObject(block)) {
      continue;
    } else if (block.type === 'text') {
      parts.push({ type: 'input_text', text: asString(block.text) });
    } else if (block.type === 'image') {
      const imageUrl = responsesImageUrl(block);
      parts.push(imageUrl
        ? { type: 'input_image', image_url: imageUrl }
        : { type: 'input_text', text: '[image omitted: unsupported image source]' });
    } else if (block.type === 'input_text' || block.type === 'input_image') {
      parts.push(block);
    } else {
      parts.push({ type: 'input_text', text: JSON.stringify(block) });
    }
  }
  return parts;
}

function responsesImageUrl(block: JsonObject): string | undefined {
  const source = isObject(block.source) ? block.source : undefined;
  if (!source) return typeof block.image_url === 'string' ? block.image_url : undefined;
  if (source.type === 'url') return asString(source.url) || undefined;
  if (source.type !== 'base64') return undefined;
  const data = asString(source.data);
  const declared = asString(source.mediaType) || asString(source.media_type) || 'image/png';
  const mediaType = resolveImageMediaType(data, declared);
  return data ? `data:${mediaType};base64,${data}` : undefined;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
