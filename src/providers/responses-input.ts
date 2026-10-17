import type { ProviderRequest } from '../types/index.js';
import { imageForRequest, urlImageForRequest } from '../utils/image-media.js';
import { carriesAnthropicServerBlock } from '../utils/anthropic-server-blocks.js';
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
   * Hears each content block this normalization leaves out or changes, and
   * each tool result whose nested content or error flag it can't carry as it
   * was: given the request's own block, so membrane can name the message it
   * came from (nothing, for a block that isn't an object).
   */
  onDropped?: (block?: unknown) => void,
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
    // must survive replay verbatim. Only translate normalized content blocks
    // and Anthropic server-tool blocks, which are left out below, and decide
    // an input_image whose data: URL holds no accepted image.
    if (Array.isArray(rawMessage.content) && !rawMessage.content.some((block) =>
      isObject(block) && (
        ['text', 'image', 'tool_use', 'tool_result', 'redacted_thinking'].includes(asString(block.type))
        || carriesAnthropicServerBlock(block)
      )
    )) {
      const content = nativeParts(rawMessage.content, onDropped);
      output.push(content === rawMessage.content ? rawMessage : { ...rawMessage, content });
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
      // An Anthropic server-tool block, bare or on its zero-width carrier (an
      // Anthropic-shaped builder sends one back for its own wire), has no
      // form on this one, so the message loses it.
      if (carriesAnthropicServerBlock(rawBlock)) {
        onDropped?.(rawBlock);
        continue;
      }
      if (rawBlock.type === 'text') {
        parts.push({ type: role === 'assistant' ? 'output_text' : 'input_text', text: asString(rawBlock.text) });
      } else if (rawBlock.type === 'image') {
        const part = responsesImagePart(rawBlock);
        if (part && role !== 'assistant') {
          parts.push(part);
          // The placeholder stands where the image was.
          if (part.type !== 'input_image') onDropped?.(rawBlock);
        } else onDropped?.(rawBlock);
      } else if (rawBlock.type === 'tool_use') {
        flush();
        output.push(normalizeStandaloneItem(rawBlock, onDropped));
      } else if (rawBlock.type === 'tool_result') {
        flush();
        output.push(normalizeStandaloneItem(rawBlock, onDropped));
      } else if (rawBlock.type === 'redacted_thinking') {
        flush();
        output.push(reasoningInputItem(rawBlock));
      } else {
        // Already-native input_text/output_text/input_image/refusal parts.
        const part = nativePart(rawBlock);
        if (part !== rawBlock) onDropped?.(rawBlock);
        parts.push(part);
      }
    }
    flush();
  }

  return output as OpenAIResponsesInputItem[];
}

function normalizeStandaloneItem(item: JsonObject, onDropped?: (block?: unknown) => void): unknown {
  if (item.type === 'tool_use') {
    // Arguments are an object; anything else goes out as {}.
    if (item.input !== undefined && !isObject(item.input)) onDropped?.(item);
    return {
      type: 'function_call',
      call_id: asString(item.id),
      name: asString(item.name),
      arguments: JSON.stringify(isObject(item.input) ? item.input : {}),
    };
  }
  if (item.type === 'tool_result') {
    const { output, loses } = responsesToolOutput(item.content);
    // A nested value the output can't carry is stringified or replaced by a
    // note or the placeholder, and a function_call_output has no error flag,
    // so a failed result reads as a plain one.
    if (loses || item.isError === true || item.is_error === true) onDropped?.(item);
    return {
      type: 'function_call_output',
      call_id: asString(item.toolUseId) || asString(item.tool_use_id),
      output,
    };
  }
  if (item.type === 'redacted_thinking') {
    return reasoningInputItem(item);
  }
  if (item.type === 'function_call_output' && Array.isArray(item.output)) {
    const output = nativeParts(item.output, onDropped);
    return output === item.output ? item : { ...item, output };
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
 * A tool result's content as a Responses `function_call_output` carries it,
 * and whether that loses something on the way.
 *
 * A string goes as it is. Content with an image goes as an array of native
 * input_text / input_image parts: Responses accepts `output` as a string OR
 * an array of those parts, and stringifying an image-bearing result hands
 * the model its base64 as TEXT — no vision, and ~1 token per 2 base64 chars
 * (a 760 KB snapshot ≈ 500k input tokens; probed live on the Codex backend
 * 2026-10-02: array form = 526 tokens and the model describes the image).
 * Any other content keeps the legacy JSON string form, which carries its
 * text, so existing replay bytes don't change.
 *
 * It loses something when a nested block is neither text nor an image the
 * output can carry (it is JSON-stringified, replaced by a note or left out),
 * or when an image's data is none the API accepts (it becomes the
 * placeholder). Each image is decided once, so its warning prints once.
 */
export function responsesToolOutput(content: unknown): { output: unknown; loses: boolean } {
  if (typeof content === 'string') return { output: content, loses: false };
  if (!Array.isArray(content)) return { output: JSON.stringify(content ?? null), loses: false };
  if (!content.some((block) => isObject(block) && (block.type === 'image' || block.type === 'input_image'))) {
    return {
      output: JSON.stringify(content),
      loses: content.some((block) =>
        typeof block !== 'string' && !(isObject(block) && (block.type === 'text' || block.type === 'input_text'))),
    };
  }
  let loses = false;
  const parts: unknown[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push({ type: 'input_text', text: block });
    } else if (!isObject(block)) {
      loses = true;
    } else if (block.type === 'text') {
      parts.push({ type: 'input_text', text: asString(block.text) });
    } else if (block.type === 'image') {
      const part = responsesImagePart(block);
      if (part?.type !== 'input_image') loses = true;
      parts.push(part ?? { type: 'input_text', text: UNUSABLE_IMAGE_SOURCE_TEXT });
    } else if (block.type === 'input_text') {
      parts.push(block);
    } else if (block.type === 'input_image') {
      const part = nativePart(block);
      if (part !== block) loses = true;
      parts.push(part);
    } else {
      loses = true;
      parts.push({ type: 'input_text', text: JSON.stringify(block) });
    }
  }
  return { output: parts, loses };
}

/** Stand-in for a tool-result image with no usable source, worded like
 *  imageForRequest's placeholder: the model must know an image was there. It
 *  names no cause, since several reach it (a source that isn't a URL or
 *  base64 data, an empty URL, or base64 outside `source`), and offers no
 *  remedy, since nothing in the request can show the image. Base64 data in a
 *  source is decided instead, and data that is no accepted image gets
 *  imageForRequest's placeholder. */
const UNUSABLE_IMAGE_SOURCE_TEXT =
  '[system: an image in this tool result was NOT shown to you. This request couldn\'t carry it, ' +
  'so you are not seeing it.]';

type ResponsesImagePart = { type: 'input_image'; image_url: string } | { type: 'input_text'; text: string };

/** An image block as a Responses input part: an input_image for an accepted
 *  image or a remote URL, imageForRequest's placeholder as input_text for
 *  data that is no accepted image, and undefined for a block with no usable
 *  source. */
function responsesImagePart(block: JsonObject): ResponsesImagePart | undefined {
  const source = isObject(block.source) ? block.source : undefined;
  if (!source) return typeof block.image_url === 'string' && block.image_url ? urlPart(block.image_url) : undefined;
  if (source.type === 'url') {
    const url = asString(source.url);
    return url ? urlPart(url) : undefined;
  }
  if (source.type !== 'base64') return undefined;
  const data = asString(source.data);
  const { mediaType, placeholder } = imageForRequest(data, source.mediaType ?? source.media_type);
  return placeholder
    ? { type: 'input_text', text: placeholder.text }
    : { type: 'input_image', image_url: `data:${mediaType};base64,${data}` };
}

/** An image URL as a Responses part: a data: URL's image labelled by its
 *  header, or the placeholder for data the API doesn't accept; any other URL
 *  as it is, for the API to fetch. */
function urlPart(url: string): ResponsesImagePart {
  const image = urlImageForRequest(url);
  return image.placeholder ? { type: 'input_text', text: image.placeholder.text } : { type: 'input_image', image_url: image.url };
}

/** An already-native part as the request carries it. Native parts replay
 *  verbatim, except an input_image whose data: URL holds no accepted image:
 *  the API would refuse it on every request, so it becomes the placeholder. */
function nativePart(part: JsonObject): JsonObject {
  if (part.type !== 'input_image' || typeof part.image_url !== 'string' || !part.image_url) return part;
  const image = urlImageForRequest(part.image_url);
  return image.placeholder ? { type: 'input_text', text: image.placeholder.text } : part;
}

/** Native input items as an API-mode request carries them: replayed
 *  verbatim, except an input_image, in a message's content or a
 *  function_call_output's output, whose data: URL holds no accepted image,
 *  which becomes the placeholder. The same array, and the same items, when
 *  nothing changes, so valid items replay byte for byte. `onAltered` hears
 *  each part that becomes the placeholder, the request's own block. */
export function nativeInputForRequest(
  items: ProviderRequest['messages'],
  onAltered?: (block?: unknown) => void,
): OpenAIResponsesInputItem[] {
  let changed = false;
  const out = (items as unknown[]).map((item) => {
    if (!isObject(item)) return item;
    const key = Array.isArray(item.content) ? 'content'
      : item.type === 'function_call_output' && Array.isArray(item.output) ? 'output' : null;
    if (!key) return item;
    const parts = nativeParts(item[key] as unknown[], onAltered);
    if (parts === item[key]) return item;
    changed = true;
    return { ...item, [key]: parts };
  });
  return (changed ? out : items) as OpenAIResponsesInputItem[];
}

/** nativePart over a native content or output array: the same array when no
 *  part changes, so a valid native item replays verbatim. `onAltered` hears
 *  each part that becomes the placeholder. */
function nativeParts(parts: unknown[], onAltered?: (part: unknown) => void): unknown[] {
  let changed = false;
  const decided = parts.map((part) => {
    if (!isObject(part)) return part;
    const next = nativePart(part);
    if (next !== part) {
      changed = true;
      onAltered?.(part);
    }
    return next;
  });
  return changed ? decided : parts;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
