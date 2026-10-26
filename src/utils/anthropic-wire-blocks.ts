/**
 * The Anthropic Messages API refuses a block that carries a field it doesn't
 * define ("Extra inputs are not permitted"), and a block in a conversation's
 * history goes out with every later request, so one stray field gets each of
 * them refused (antra-tess/membrane#161).
 */

import { stripEmptyTextBlocks } from './empty-text.js';
import { imageForRequest, urlImageForRequest } from './image-media.js';
import { convertMcpMedia, isSourcelessMedia } from './mcp-media.js';
import { isUnsignedThinking } from './thinking-carriers.js';

type Block = Record<string, unknown>;

/** The API's whole field list for each block type, as `@anthropic-ai/sdk`
 *  0.126's `*BlockParam` types give them and count_tokens takes them. The SDK
 *  this repository pins lacks some, such as an image's `transformations`. */
const FIELDS = new Map<unknown, readonly string[]>([
  ['text', ['type', 'text', 'cache_control', 'citations']],
  ['image', ['type', 'source', 'cache_control', 'transformations']],
  ['document', ['type', 'source', 'cache_control', 'citations', 'context', 'title']],
  ['tool_use', ['type', 'id', 'name', 'input', 'cache_control', 'caller', 'toolset_name']],
  ['tool_result', ['type', 'tool_use_id', 'cache_control', 'content', 'is_error', 'toolset_name']],
  ['thinking', ['type', 'thinking', 'signature']],
  ['redacted_thinking', ['type', 'data']],
]);

const NESTED_TEXT_FIELDS: readonly string[] = ['type', 'text'];
const NESTED_IMAGE_FIELDS: readonly string[] = ['type', 'source'];

const ERROR_IMAGE_NOTE =
  '[system: an image in this tool result was NOT shown to you — a tool error reaches this model as text only. You are not seeing this image.]';

/** "content cannot be empty if `is_error` is true" */
const EMPTY_ERROR_NOTE = '[system: this tool error carries no content this request can show.]';

const originalOfBuilt = new WeakMap<object, unknown>();

function isRecord(value: unknown): value is Block {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasNoWireForm(block: Block): boolean {
  return isSourcelessMedia(block) || isUnsignedThinking(block);
}

function pick(block: Block, fields: readonly string[], apiOrder: boolean): Block {
  const out: Block = {};
  for (const key of apiOrder ? fields : Object.keys(block)) {
    if (fields.includes(key) && Object.hasOwn(block, key)) out[key] = block[key];
  }
  return out;
}

interface Layout {
  apiOrder: boolean;
  imageMediaTypeLast: boolean;
}

function wireSource(source: Block, apiOrder: boolean, options: { label?: unknown; mediaTypeLast?: boolean } = {}): Block {
  if (source.type === 'url') return pick(source, ['type', 'url'], apiOrder);
  if (source.type !== 'base64') return source;
  const mediaType = options.label ?? source.media_type ?? source.mediaType;
  if (apiOrder) return { type: 'base64', ...(mediaType !== undefined ? { media_type: mediaType } : {}), data: source.data };
  const built = pick(source, options.mediaTypeLast ? ['type', 'data'] : ['type', 'media_type', 'data'], false);
  if (mediaType !== undefined) built.media_type = mediaType;
  return built;
}

function wireImage(block: Block, fields: readonly string[], onPlaceholder: () => void, layout: Layout): Block {
  const built = pick(block, fields, layout.apiOrder);
  const source = block.source as Block;
  const placeholder = (note: Block): Block => {
    onPlaceholder();
    return fields.includes('cache_control') && block.cache_control ? { ...note, cache_control: block.cache_control } : note;
  };
  if (source.type === 'url') {
    const image = urlImageForRequest(source.url as string);
    if (image.placeholder) return placeholder(image.placeholder);
    built.source = image.data
      ? { type: 'base64', media_type: image.mediaType, data: image.data }
      : wireSource(source, layout.apiOrder);
    return built;
  }
  if (source.type !== 'base64') return built;
  const image = imageForRequest(source.data, source.media_type ?? source.mediaType);
  if (image.placeholder) return placeholder(image.placeholder);
  built.source = wireSource(source, layout.apiOrder, { label: image.mediaType, mediaTypeLast: layout.imageMediaTypeLast });
  return built;
}

function wireDocument(block: Block, layout: Layout): Block {
  const built = pick(block, FIELDS.get('document')!, layout.apiOrder);
  const source = block.source as Block;
  built.source = wireSource(source, layout.apiOrder);
  if (built.title === undefined && typeof block.filename === 'string' && block.filename !== '') {
    built.title = block.filename;
  }
  return built;
}

function isNestedImage(block: Block): boolean {
  const source = block.source as Block | undefined;
  return block.type === 'image' && isRecord(source) && (source.type === 'base64' || source.type === 'url');
}

function toolResultContent(content: readonly unknown[], result: { is_error?: unknown }, onAltered: () => void, layout: Layout): unknown[] {
  const error = result.is_error === true;
  const built: Block[] = [];
  for (const item of stripEmptyTextBlocks(content, () => onAltered())) {
    if (!isRecord(item) || hasNoWireForm(item)) {
      onAltered();
      continue;
    }
    if (item.type === 'text') {
      built.push(pick(item, NESTED_TEXT_FIELDS, layout.apiOrder));
      continue;
    }
    if (isNestedImage(item)) {
      const image = wireImage(item, NESTED_IMAGE_FIELDS, onAltered, layout);
      if (error && image.type === 'image') {
        onAltered();
        built.push({ type: 'text', text: ERROR_IMAGE_NOTE });
      } else {
        built.push(image);
      }
      continue;
    }
    onAltered();
  }
  if (!error || built.length > 0) return built;
  onAltered();
  return [{ type: 'text', text: EMPTY_ERROR_NOTE }];
}

function withoutEmptyError(content: unknown, result: { is_error?: unknown }): unknown {
  if (result.is_error !== true || (content !== undefined && content !== null && content !== '')) return content;
  return [{ type: 'text', text: EMPTY_ERROR_NOTE }];
}

export function anthropicToolResultContent(content: unknown, result: { is_error?: unknown } = {}): unknown {
  if (!Array.isArray(content)) return withoutEmptyError(content, result);
  return toolResultContent(content, result, () => {}, { apiOrder: true, imageMediaTypeLast: false });
}

export function blockBuiltFrom(block: unknown): unknown {
  return isRecord(block) && originalOfBuilt.has(block) ? originalOfBuilt.get(block) : block;
}

export function anthropicWireMessages(
  messages: readonly unknown[],
  options: {
    onContentAltered?: (block?: unknown) => void;
    finish?: (block: Block, report: () => void) => Block;
    nestedInApiOrder?: boolean;
    imageMediaTypeLast?: boolean;
  } = {},
): unknown[] {
  const top: Layout = { apiOrder: false, imageMediaTypeLast: options.imageMediaTypeLast === true };
  const nested: Layout = { ...top, apiOrder: options.nestedInApiOrder === true };
  return messages.map((message) => {
    if (!isRecord(message) || !Array.isArray(message.content)) return message;
    const converted = convertMcpMedia(message.content as unknown[]);
    return {
      ...message,
      content: (message.content as unknown[]).flatMap((original, index) => {
        const block = converted[index];
        const report = () => options.onContentAltered?.(original);
        if (!isRecord(block) || hasNoWireForm(block)) {
          report();
          return [];
        }
        const built = wireBlock(block, report, top, nested);
        const done = options.finish ? options.finish(built, report) : built;
        if (done !== original) originalOfBuilt.set(done, original);
        return [done];
      }),
    };
  });
}

function wireBlock(block: Block, report: () => void, top: Layout, nested: Layout): Block {
  if (block.type === 'image') return wireImage(block, FIELDS.get('image')!, report, top);
  if (block.type === 'document') return wireDocument(block, top);
  if (block.type === 'tool_result') {
    const built = pick(block, FIELDS.get('tool_result')!, false);
    if (!Array.isArray(block.content)) {
      const content = withoutEmptyError(block.content, built);
      if (content !== block.content) {
        built.content = content;
        report();
      }
      return built;
    }
    let altered = false;
    built.content = toolResultContent(block.content, built, () => { altered = true; }, nested);
    if (altered) report();
    return built;
  }
  const fields = FIELDS.get(block.type);
  return fields ? pick(block, fields, false) : block;
}
