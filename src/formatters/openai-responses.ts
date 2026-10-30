import type {
  ContentBlock,
  NormalizedMessage,
  ToolCall,
  ToolResult,
  ToolResultContent,
} from '../types/index.js';
import type {
  BuildOptions,
  BuildResult,
  BlockEvent,
  ParseResult,
  PrefillFormatter,
  StreamEmission,
  StreamParser,
} from './types.js';
import { responsesToolOutput } from '../providers/responses-input.js';
import { renderResultContent, type ProviderBlock } from './normalize-tool-pairs.js';

import { imageForRequest, toolResultContentForRequest, urlImageForRequest } from '../utils/image-media.js';
import { convertMcpMedia } from '../utils/mcp-media.js';
import { carriesAnthropicServerBlock } from '../utils/anthropic-server-blocks.js';

export const OPENAI_RESPONSES_ITEMS_METADATA_KEY = 'openaiResponsesItems';

class ResponsesPassthroughParser implements StreamParser {
  private accumulated = '';
  private blockIndex = 0;
  private blockStarted = false;

  push(chunk: string): void { this.accumulated += chunk; }
  processChunk(chunk: string): ParseResult {
    this.accumulated += chunk;
    const meta = { type: 'text' as const, visible: true, blockIndex: this.blockIndex };
    const emissions: StreamEmission[] = [];
    const blockEvents: BlockEvent[] = [];
    if (!this.blockStarted) {
      const event: BlockEvent = { event: 'block_start', index: this.blockIndex, block: { type: 'text' } };
      emissions.push({ kind: 'blockEvent', event });
      blockEvents.push(event);
      this.blockStarted = true;
    }
    emissions.push({ kind: 'content', text: chunk, meta });
    return { emissions, content: [{ text: chunk, meta }], blockEvents };
  }
  flush(): ParseResult {
    const emissions: StreamEmission[] = [];
    const blockEvents: BlockEvent[] = [];
    if (this.blockStarted) {
      const event: BlockEvent = {
        event: 'block_complete', index: this.blockIndex,
        block: { type: 'text', content: this.accumulated },
      };
      emissions.push({ kind: 'blockEvent', event });
      blockEvents.push(event);
      this.blockStarted = false;
    }
    return { emissions, content: [], blockEvents };
  }
  getAccumulated(): string { return this.accumulated; }
  reset(): void { this.accumulated = ''; this.blockIndex = 0; this.blockStarted = false; }
  isInsideBlock(): boolean { return false; }
  getCurrentBlockType() { return 'text' as const; }
  getBlockIndex(): number { return this.blockIndex; }
  incrementBlockIndex(): void { this.blockIndex++; }
  getDepths() { return { functionCalls: 0, functionResults: 0, thinking: 0 }; }
  resetForNewIteration(): void {}
}

type NativeItem = { type?: string; id?: string; [key: string]: unknown };
type ConvertedOutput = { item: NativeItem; block: ToolResultContent; onAltered: (() => void) | undefined };

function orphanResultMessage(block: ToolResultContent): NativeItem {
  const label = `orphan tool_result for ${block.toolUseId}${block.isError ? ', an error' : ''}`;
  const content = toolResultContentForRequest(block.content);
  const text = `[${label}]: ${renderResultContent({ content } as unknown as ProviderBlock)}`;
  return { type: 'message', role: 'user', content: [{ type: 'input_text', text }] };
}

export function responsesRawItemKey(rawItem: { type?: unknown; id?: unknown }): string {
  return typeof rawItem.id === 'string'
    ? `${rawItem.type ?? ''}:${rawItem.id}`
    : JSON.stringify(rawItem);
}

/**
 * Formatter for stateless, provider-native OpenAI Responses histories.
 *
 * Native items, in message metadata under `openaiResponsesItems` or on
 * content blocks as `rawItem`, are emitted verbatim and in order, and stand
 * in for what they're attached to: a message's metadata items for its whole
 * content (an empty array sends nothing), a block's `rawItem` for that block.
 * The fields they replace aren't read, and the message or block counts as
 * carried when its items are. Within a message, blocks whose items share a
 * type and id are one item, sent once; a block whose item differs under the
 * same key isn't carried. Everything else is converted to Responses input
 * items in its place, and native items are never rewritten. A `tool_result`
 * whose call no input item carries goes in its place as user text,
 * `[orphan tool_result for ID]: …`, as the native formatter sends one.
 */
export class OpenAIResponsesFormatter implements PrefillFormatter {
  readonly name = 'openai-responses';
  readonly usesPrefill = false;
  readonly supportsNativeTools = true;
  readonly supportsXmlTools = false;
  /** buildMessages records every consumer message it doesn't carry verbatim (utils/fidelity.ts). */
  readonly reportsAlterations = true;

  buildMessages(messages: NormalizedMessage[], options: BuildOptions): BuildResult {
    messages = convertMcpMedia(messages);
    const items: NativeItem[] = [];
    const outputs: ConvertedOutput[] = [];
    let hasImportedItems = false;

    for (let index = 0; index < messages.length; index++) {
      const message = messages[index]!;
      const onAltered = options.fidelity ? () => options.fidelity!.alter(index) : undefined;
      const nativeItems = message.metadata?.[OPENAI_RESPONSES_ITEMS_METADATA_KEY];
      if (Array.isArray(nativeItems)) {
        items.push(...nativeItems as NativeItem[]);
        hasImportedItems = true;
        continue;
      }

      const seenRawItems = new Map<string, NativeItem>();
      let pendingParts: ContentBlock[] = [];
      const flushPending = () => {
        if (pendingParts.length === 0) return;
        items.push(...this.convertBlocks(message, pendingParts, options.assistantParticipant, onAltered, (item, block) =>
          outputs.push({ item, block, onAltered })));
        pendingParts = [];
      };

      for (const block of message.content) {
        // An Anthropic server-tool block has no form on the Responses wire.
        if (carriesAnthropicServerBlock(block)) {
          onAltered?.();
          continue;
        }
        const rawItem = ('rawItem' in block ? block.rawItem : undefined) as NativeItem | undefined;
        if (!rawItem || typeof rawItem !== 'object') {
          pendingParts.push(block);
          continue;
        }

        flushPending();
        const key = responsesRawItemKey(rawItem);
        const sent = seenRawItems.get(key);
        if (!sent) {
          items.push(rawItem);
          seenRawItems.set(key, rawItem);
        } else if (sent !== rawItem && JSON.stringify(sent) !== JSON.stringify(rawItem)) {
          onAltered?.();
        }
      }
      flushPending();
    }

    const called = new Set<unknown>();
    for (const item of items) {
      if (typeof item.call_id === 'string' && !item.type?.endsWith('_output')) called.add(item.call_id);
    }
    for (const { item, block, onAltered } of outputs) {
      if (called.has(item.call_id)) continue;
      items[items.indexOf(item)] = orphanResultMessage(block);
      onAltered?.();
    }

    // `instructions` is a request field apart from the input items, so sending
    // it again doesn't change the input prefix or its caching.
    const hasImportedSystemItem = hasImportedItems ||
      items.some(item =>
        (item.type === 'message' || item.type === undefined) &&
        ((item as { role?: unknown }).role === 'developer' ||
          (item as { role?: unknown }).role === 'system'));

    return {
      messages: items as unknown as BuildResult['messages'],
      systemContent: hasImportedSystemItem ? undefined : options.systemPrompt,
      stopSequences: options.additionalStopSequences ?? [],
      nativeTools: options.tools?.map(tool => ({
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      })),
      ready: true,
    };
  }

  private convertBlocks(
    message: NormalizedMessage,
    blocks: ContentBlock[],
    assistantParticipant: string,
    onAltered: (() => void) | undefined,
    onOutput: (item: NativeItem, block: ToolResultContent) => void,
  ): NativeItem[] {
    const isAssistant = message.participant === assistantParticipant;
    const out: NativeItem[] = [];
    let messageParts: unknown[] = [];

    const flushMessage = () => {
      if (messageParts.length === 0) return;
      out.push({
        type: 'message',
        role: isAssistant ? 'assistant' : 'user',
        content: messageParts,
      });
      messageParts = [];
    };

    for (const block of blocks) {
      if (block.type === 'text') {
        messageParts.push({
          type: isAssistant ? 'output_text' : 'input_text',
          text: block.text,
        });
      } else if (block.type === 'image' && !isAssistant && typeof block.source === 'object' && block.source !== null) {
        const source = block.source;
        if (source.type === 'url') {
          // A data: URL holds its image inline and takes the same decision;
          // any other URL is the API's to fetch.
          const image = urlImageForRequest(source.url);
          messageParts.push(image.placeholder
            ? { type: 'input_text', text: image.placeholder.text }
            : { type: 'input_image', image_url: image.url });
          if (image.placeholder) onAltered?.();
        } else {
          const { mediaType, placeholder } = imageForRequest(source.data, source.mediaType);
          messageParts.push(placeholder
            ? { type: 'input_text', text: placeholder.text }
            : { type: 'input_image', image_url: `data:${mediaType};base64,${source.data}` });
          if (placeholder) onAltered?.();
        }
      } else if (block.type === 'tool_use') {
        flushMessage();
        out.push({
          type: 'function_call',
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        });
      } else if (block.type === 'tool_result') {
        flushMessage();
        // A function_call_output has no error flag, so a failed result reads as a plain one.
        const { output, loses } = responsesToolOutput(block.content);
        if (loses || block.isError) onAltered?.();
        const item = { type: 'function_call_output', call_id: block.toolUseId, output };
        out.push(item);
        onOutput(item, block);
      } else if (block.type === 'redacted_thinking') {
        flushMessage();
        out.push({ type: 'reasoning', encrypted_content: block.data, summary: [] });
      } else {
        onAltered?.();
      }
    }
    flushMessage();
    return out;
  }

  formatToolResults(results: ToolResult[]): string {
    return JSON.stringify(results.map(result => ({
      type: 'function_call_output',
      call_id: result.toolUseId,
      output: result.content,
    })));
  }

  createStreamParser(): StreamParser { return new ResponsesPassthroughParser(); }
  parseToolCalls(_content: string): ToolCall[] { return []; }
  hasToolUse(_content: string): boolean { return false; }
  parseContentBlocks(content: string): ContentBlock[] {
    return content ? [{ type: 'text', text: content }] : [];
  }
}
