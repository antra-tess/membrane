import type { ProviderRequest } from '../types/index.js';
import { imageForRequest, urlImageForRequest } from '../utils/image-media.js';
import { carriesAnthropicServerBlock } from '../utils/anthropic-server-blocks.js';
import type { OpenAIResponsesInputItem } from './openai-responses-api.js';

type JsonObject = Record<string, unknown>;

function isNormalizedPart(block: unknown): boolean {
  return isObject(block) && (
    ['text', 'image', 'tool_use', 'tool_result', 'redacted_thinking'].includes(asString(block.type))
    || carriesAnthropicServerBlock(block)
  );
}

export function normalizeResponsesInput(
  messages: ProviderRequest['messages'],
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

    if (Array.isArray(rawMessage.content) && !rawMessage.content.some(isNormalizedPart)) {
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
    // A function_call_output has no error flag, so a failed result reads as a plain one.
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

/** `summary` is a required field on a Responses reasoning input item (an
 * empty array means no summaries); omitting it 400s with
 * "Missing required parameter: 'input[N].summary'". */
function reasoningInputItem(block: JsonObject): unknown {
  const raw = block.rawItem;
  if (isObject(raw) && raw.type === 'reasoning') return raw;
  return { type: 'reasoning', summary: [], encrypted_content: asString(block.data) };
}

/**
 * Responses accepts a `function_call_output`'s `output` as a string or as an
 * array of input_text / input_image parts. A stringified image reaches the
 * model as base64 text: no vision, and about a token per two characters.
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

const UNUSABLE_IMAGE_SOURCE_TEXT =
  '[system: an image in this tool result was NOT shown to you. This request couldn\'t carry it, ' +
  'so you are not seeing it.]';

type ResponsesImagePart = { type: 'input_image'; image_url: string } | { type: 'input_text'; text: string };

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

function urlPart(url: string): ResponsesImagePart {
  const image = urlImageForRequest(url);
  return image.placeholder ? { type: 'input_text', text: image.placeholder.text } : { type: 'input_image', image_url: image.url };
}

function nativePart(part: JsonObject): JsonObject {
  if (part.type !== 'input_image' || typeof part.image_url !== 'string' || !part.image_url) return part;
  const image = urlImageForRequest(part.image_url);
  return image.placeholder ? { type: 'input_text', text: image.placeholder.text } : part;
}

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
