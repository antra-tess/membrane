/**
 * Native Formatter
 *
 * Pass-through formatter that converts messages to standard user/assistant
 * format without prefill. Uses native API tool calling.
 *
 * Supports two participant modes:
 * - 'simple': Strict two-party (Human/Assistant), no names in content
 * - 'multiuser': Multiple participants, names prefixed to content
 */

import type {
  NormalizedMessage,
  ContentBlock,
  ToolDefinition,
  ToolCall,
  ToolResult,
} from '../types/index.js';
import type {
  PrefillFormatter,
  StreamParser,
  BuildOptions,
  BuildResult,
  FormatterConfig,
  ProviderMessage,
  ParseResult,
  BlockType,
} from './types.js';

// ============================================================================
// Configuration
// ============================================================================

export interface NativeFormatterConfig extends FormatterConfig {
  /**
   * Format for participant name prefix in multiuser mode.
   * Use {name} as placeholder. Default: '{name}: '
   */
  nameFormat?: string;
}

// ============================================================================
// Pass-through Stream Parser
// ============================================================================

/**
 * Simple pass-through parser that doesn't do XML tracking.
 * Just accumulates content and emits text chunks.
 */
class PassthroughParser implements StreamParser {
  private accumulated = '';
  private blockIndex = 0;

  processChunk(chunk: string): ParseResult {
    this.accumulated += chunk;
    const meta = {
      type: 'text' as const,
      visible: true,
      blockIndex: this.blockIndex,
    };
    return {
      emissions: [{
        kind: 'content' as const,
        text: chunk,
        meta,
      }],
      content: [{ text: chunk, meta }],
      blockEvents: [],
    };
  }

  flush(): ParseResult {
    return { emissions: [], content: [], blockEvents: [] };
  }

  getAccumulated(): string {
    return this.accumulated;
  }

  reset(): void {
    this.accumulated = '';
    this.blockIndex = 0;
  }

  push(content: string): void {
    this.accumulated += content;
  }

  getCurrentBlockType(): BlockType {
    return 'text';
  }

  getBlockIndex(): number {
    return this.blockIndex;
  }

  incrementBlockIndex(): void {
    this.blockIndex++;
  }

  isInsideBlock(): boolean {
    // Pass-through mode never has nested blocks
    return false;
  }

  resetForNewIteration(): void {
    // No special reset needed for pass-through mode
  }
}

// ============================================================================
// Native Formatter
// ============================================================================

export class NativeFormatter implements PrefillFormatter {
  readonly name = 'native';
  readonly usesPrefill = false;

  private config: Required<NativeFormatterConfig>;

  constructor(config: NativeFormatterConfig = {}) {
    this.config = {
      nameFormat: config.nameFormat ?? '{name}: ',
      unsupportedMedia: config.unsupportedMedia ?? 'error',
      warnOnStrip: config.warnOnStrip ?? true,
    };
  }

  // ==========================================================================
  // REQUEST BUILDING
  // ==========================================================================

  buildMessages(messages: NormalizedMessage[], options: BuildOptions): BuildResult {
    const {
      participantMode,
      assistantParticipant,
      humanParticipant,
      tools,
      systemPrompt,
      promptCaching = false,
      cacheTtl,
      hasCacheMarker,
    } = options;

    // Build cache_control object if prompt caching is enabled
    const cacheControl: Record<string, unknown> | undefined = promptCaching
      ? { type: 'ephemeral', ...(cacheTtl ? { ttl: cacheTtl } : {}) }
      : undefined;

    const providerMessages: ProviderMessage[] = [];

    // Validate simple mode participants
    if (participantMode === 'simple' && !humanParticipant) {
      throw new Error('NativeFormatter in simple mode requires humanParticipant option');
    }

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      if (!message) continue;

      // Determine role
      const isAssistant = message.participant === assistantParticipant;

      // Validate participant in simple mode
      if (participantMode === 'simple') {
        if (!isAssistant && message.participant !== humanParticipant) {
          throw new Error(
            `NativeFormatter in simple mode only supports "${humanParticipant}" and "${assistantParticipant}". ` +
            `Got: "${message.participant}". Use participantMode: 'multiuser' for multiple participants.`
          );
        }
      }

      const role: 'user' | 'assistant' = isAssistant ? 'assistant' : 'user';

      // Convert content
      const content = this.convertContent(message.content, message.participant, {
        includeNames: participantMode === 'multiuser' && !isAssistant,
      });

      if (content.length === 0) {
        continue; // Skip empty messages
      }

      // hasCacheMarker: cache boundary is BEFORE this message — tag previous message's last block
      if (hasCacheMarker && hasCacheMarker(message, i) && cacheControl && providerMessages.length > 0) {
        const prevMsg = providerMessages[providerMessages.length - 1]!;
        const prevContent = Array.isArray(prevMsg.content) ? prevMsg.content as Record<string, unknown>[] : [];
        if (prevContent.length > 0) {
          prevContent[prevContent.length - 1]!.cache_control = cacheControl;
        }
      }

      providerMessages.push({ role, content });

      // cacheBreakpoint: cache up to and INCLUDING this message — tag last block
      if (message.cacheBreakpoint && cacheControl && content.length > 0) {
        (content[content.length - 1] as Record<string, unknown>).cache_control = cacheControl;
      }
    }

    // Merge consecutive same-role messages (API requires alternating)
    const mergedMessages = this.mergeConsecutiveRoles(providerMessages);

    // Build system content with optional cache control
    let systemContent: unknown;
    if (typeof systemPrompt === 'string') {
      if (cacheControl) {
        // Must use array format for cache_control support
        systemContent = [{ type: 'text', text: systemPrompt, cache_control: cacheControl }];
      } else {
        systemContent = systemPrompt;
      }
    } else if (Array.isArray(systemPrompt)) {
      if (cacheControl && systemPrompt.length > 0) {
        // Add cache_control to the last system block
        systemContent = systemPrompt.map((block, idx) => {
          if (idx === systemPrompt.length - 1) {
            return { ...block, cache_control: cacheControl };
          }
          return block;
        });
      } else {
        systemContent = systemPrompt;
      }
    }

    // Native tools
    const nativeTools = tools?.length ? this.convertToNativeTools(tools) : undefined;

    return {
      messages: mergedMessages,
      systemContent,
      stopSequences: [], // Native mode doesn't use custom stop sequences
      nativeTools,
    };
  }

  formatToolResults(results: ToolResult[]): string {
    // Native mode uses API tool_result blocks, not string formatting
    // This method is mainly for prefill modes
    return JSON.stringify(results.map(r => ({
      tool_use_id: r.toolUseId,
      content: r.content,
      is_error: r.isError,
    })));
  }

  // ==========================================================================
  // RESPONSE PARSING
  // ==========================================================================

  createStreamParser(): StreamParser {
    return new PassthroughParser();
  }

  parseToolCalls(content: string): ToolCall[] {
    // Native mode gets tool calls from API response, not from content parsing
    // Return empty - tool calls come through the native API response
    return [];
  }

  hasToolUse(content: string): boolean {
    // Native mode determines tool use from API stop_reason, not content
    return false;
  }

  parseContentBlocks(content: string): ContentBlock[] {
    // Native mode - content is plain text
    if (!content.trim()) {
      return [];
    }
    return [{ type: 'text', text: content }];
  }

  // ==========================================================================
  // PRIVATE HELPERS
  // ==========================================================================

  private convertContent(
    content: ContentBlock[],
    participant: string,
    options: { includeNames: boolean }
  ): unknown[] {
    const result: unknown[] = [];
    let hasUnsupportedMedia = false;

    for (const block of content) {
      if (block.type === 'text') {
        let text = block.text;
        if (options.includeNames) {
          const prefix = this.config.nameFormat.replace('{name}', participant);
          text = prefix + text;
        }
        const textBlock: Record<string, unknown> = { type: 'text', text };
        if (block.cache_control) {
          textBlock.cache_control = block.cache_control;
        }
        result.push(textBlock);
      } else if (block.type === 'image') {
        if (block.source.type === 'base64') {
          result.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: block.source.mediaType,
              data: block.source.data,
            },
          });
        }
      } else if (block.type === 'tool_use') {
        result.push({
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.input,
        });
      } else if (block.type === 'tool_result') {
        result.push({
          type: 'tool_result',
          tool_use_id: block.toolUseId,
          content: block.content,
          is_error: block.isError,
        });
      } else if (block.type === 'thinking') {
        result.push({
          type: 'thinking',
          thinking: block.thinking,
        });
      } else if (block.type === 'document' || block.type === 'audio') {
        hasUnsupportedMedia = true;
      }
    }

    if (hasUnsupportedMedia) {
      if (this.config.unsupportedMedia === 'error') {
        throw new Error(`NativeFormatter: unsupported media type in content. Configure unsupportedMedia: 'strip' to ignore.`);
      } else if (this.config.warnOnStrip) {
        console.warn(`[NativeFormatter] Stripped unsupported media from message`);
      }
    }

    return result;
  }

  private mergeConsecutiveRoles(messages: ProviderMessage[]): ProviderMessage[] {
    if (messages.length === 0) return [];

    const merged: ProviderMessage[] = [];
    let current: ProviderMessage = messages[0]!;

    for (let i = 1; i < messages.length; i++) {
      const next: ProviderMessage = messages[i]!;

      if (next.role === current.role) {
        // Merge content arrays
        const currentContent = Array.isArray(current.content) ? current.content : [current.content];
        const nextContent = Array.isArray(next.content) ? next.content : [next.content];
        current = {
          role: current.role,
          content: [...currentContent, ...nextContent],
        };
      } else {
        merged.push(current);
        current = next;
      }
    }

    merged.push(current);
    return merged;
  }

  private convertToNativeTools(tools: ToolDefinition[]): unknown[] {
    return tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));
  }
}
