/**
 * Formatter for stateless, provider-native OpenAI Responses histories.
 *
 * Imported/native items are carried either in message metadata under
 * `openaiResponsesItems` or on content blocks as `rawItem`. Those items are
 * emitted verbatim and in order. Normalized messages created after import are
 * converted to Responses input items without rewriting the native prefix.
 */

import type {
  ContentBlock,
  NormalizedMessage,
  ToolCall,
  ToolResult,
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

export class OpenAIResponsesFormatter implements PrefillFormatter {
  readonly name = 'openai-responses';
  readonly usesPrefill = false;

  buildMessages(messages: NormalizedMessage[], options: BuildOptions): BuildResult {
    const items: NativeItem[] = [];
    let hasImportedItems = false;

    for (const message of messages) {
      const nativeItems = message.metadata?.[OPENAI_RESPONSES_ITEMS_METADATA_KEY];
      if (Array.isArray(nativeItems)) {
        items.push(...nativeItems as NativeItem[]);
        hasImportedItems = true;
        continue;
      }

      const seenRawItems = new Set<string>();
      let pendingParts: ContentBlock[] = [];
      const flushPending = () => {
        if (pendingParts.length === 0) return;
        items.push(...this.convertBlocks(message, pendingParts, options.assistantParticipant));
        pendingParts = [];
      };

      for (const block of message.content) {
        const rawItem = block.rawItem as NativeItem | undefined;
        if (!rawItem || typeof rawItem !== 'object') {
          pendingParts.push(block);
          continue;
        }

        flushPending();
        const key = typeof rawItem.id === 'string'
          ? `${rawItem.type ?? ''}:${rawItem.id}`
          : JSON.stringify(rawItem);
        if (!seenRawItems.has(key)) {
          items.push(rawItem);
          seenRawItems.add(key);
        }
      }
      flushPending();
    }

    // An imported rollout already carries its own developer/system items, and
    // re-injecting the recipe prompt over them would double the instructions.
    // Suppress the system prompt ONLY for imported histories — signalled by
    // the import metadata key or by a developer/system item in the native
    // prefix. Blocks with `rawItem` do NOT count: every response from this
    // provider attaches rawItem (see parseProviderContent), so keying on it
    // would silently drop a fresh session's system prompt from turn 2 onward
    // (turn 1 sends it as the top-level `instructions` request field, never
    // as an input item, and the adapter is stateless — nothing else retains
    // it). `instructions` is a separate request field, so re-sending it does
    // not perturb the input-item prefix or its caching.
    const hasImportedSystemItem = hasImportedItems ||
      items.some(item =>
        (item.type === 'message' || item.type === undefined) &&
        ((item as { role?: unknown }).role === 'developer' ||
          (item as { role?: unknown }).role === 'system'));

    return {
      // BuildResult's historical type says chat envelopes, but Membrane's
      // provider boundary deliberately accepts unknown provider-native items.
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
      } else if (block.type === 'image' && !isAssistant) {
        const source = block.source;
        messageParts.push(source.type === 'url'
          ? { type: 'input_image', image_url: source.url }
          : { type: 'input_image', image_url: `data:${source.mediaType};base64,${source.data}` });
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
        out.push({
          type: 'function_call_output',
          call_id: block.toolUseId,
          output: typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content),
        });
      } else if (block.type === 'redacted_thinking') {
        flushMessage();
        out.push({ type: 'reasoning', encrypted_content: block.data });
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
