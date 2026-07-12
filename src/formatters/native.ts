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
  BlockEvent,
  StreamEmission,
} from './types.js';
import { normalizeToolPairs, mergeConsecutiveRoles } from './normalize-tool-pairs.js';
import { isAcceptedImageMediaType, strippedImagePlaceholder } from '../utils/image-media.js';

/** Index of the last content block that can carry cache_control. Anthropic
 *  rejects cache_control on thinking / redacted_thinking blocks, so a cache
 *  breakpoint must attach to the last NON-thinking block. Returns -1 when the
 *  message has only thinking blocks (the breakpoint is then skipped). */
function lastCacheableBlockIndex(blocks: Array<Record<string, unknown>>): number {
  for (let k = blocks.length - 1; k >= 0; k--) {
    const t = blocks[k]?.type as string | undefined;
    if (t !== 'thinking' && t !== 'redacted_thinking') return k;
  }
  return -1;
}

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
  private blockStarted = false;

  processChunk(chunk: string): ParseResult {
    this.accumulated += chunk;
    const meta = {
      type: 'text' as const,
      visible: true,
      blockIndex: this.blockIndex,
    };

    const emissions: StreamEmission[] = [];
    const blockEvents: BlockEvent[] = [];

    // Emit block_start on first chunk
    if (!this.blockStarted) {
      const startEvent: BlockEvent = {
        event: 'block_start',
        index: this.blockIndex,
        block: { type: 'text' },
      };
      emissions.push({ kind: 'blockEvent', event: startEvent });
      blockEvents.push(startEvent);
      this.blockStarted = true;
    }

    emissions.push({ kind: 'content', text: chunk, meta });

    return { emissions, content: [{ text: chunk, meta }], blockEvents };
  }

  flush(): ParseResult {
    const emissions: StreamEmission[] = [];
    const blockEvents: BlockEvent[] = [];

    if (this.blockStarted) {
      const completeEvent: BlockEvent = {
        event: 'block_complete',
        index: this.blockIndex,
        block: { type: 'text', content: this.accumulated },
      };
      emissions.push({ kind: 'blockEvent', event: completeEvent });
      blockEvents.push(completeEvent);
      this.blockStarted = false;
    }

    return { emissions, content: [], blockEvents };
  }

  getAccumulated(): string {
    return this.accumulated;
  }

  reset(): void {
    this.accumulated = '';
    this.blockIndex = 0;
    this.blockStarted = false;
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

  getDepths(): { functionCalls: number; functionResults: number; thinking: number } {
    return { functionCalls: 0, functionResults: 0, thinking: 0 };
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
      contextPrefix,
      additionalStopSequences,
    } = options;

    // Build cache_control object if prompt caching is enabled
    const cacheControl: Record<string, unknown> | undefined = promptCaching
      ? { type: 'ephemeral', ...(cacheTtl ? { ttl: cacheTtl } : {}) }
      : undefined;

    // The system block is cached only as a FALLBACK. When the context strategy
    // marks any message breakpoint, that breakpoint already caches a prefix
    // beginning at the front of the request — tools + system included — so a
    // separate system breakpoint is redundant. Placing it anyway both wastes one
    // of Anthropic's 4 cache_control slots and can push a 4-marker turn to 5,
    // which the API hard-rejects. So we only cache the system block when the
    // caller/strategy marked no breakpoints of its own.
    let markedBreakpoints = 0;

    const providerMessages: ProviderMessage[] = [];

    // Add context prefix as first assistant message (for simulacrum seeding)
    if (contextPrefix) {
      const prefixBlock: Record<string, unknown> = { type: 'text', text: contextPrefix };
      if (promptCaching && cacheControl) {
        prefixBlock.cache_control = cacheControl;
        markedBreakpoints++;
      }
      providerMessages.push({
        role: 'assistant',
        content: [prefixBlock],
      });
    }

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
        const prevIdx = lastCacheableBlockIndex(prevContent);
        if (prevIdx >= 0) {
          prevContent[prevIdx]!.cache_control = cacheControl;
          markedBreakpoints++;
        }
      }

      providerMessages.push({ role, content });

      // cacheBreakpoint: cache up to and INCLUDING this message — tag last block
      if (message.cacheBreakpoint && cacheControl && content.length > 0) {
        const bpIdx = lastCacheableBlockIndex(content as Record<string, unknown>[]);
        if (bpIdx >= 0) {
          (content[bpIdx] as Record<string, unknown>).cache_control = cacheControl;
          markedBreakpoints++;
        }
      }
    }

    // Tool-pair normalizer: wire-boundary safety net for Anthropic's
    // structural rules on tool cycles. See `normalize-tool-pairs.ts`
    // for the full rationale. Runs BEFORE mergeConsecutiveRoles so the
    // merge sees role-correct envelopes.
    const normalized = normalizeToolPairs(providerMessages, {
      pendingToolCallIds: options.pendingToolCallIds,
      onEvent: options.onNormalize,
    });

    // Merge consecutive same-role messages (API requires alternating)
    const mergedMessages = mergeConsecutiveRoles(normalized.messages);

    // Build system content. Cache the system block only as a fallback — when no
    // message breakpoint was marked (see note above; otherwise a message
    // breakpoint already caches tools+system as part of its prefix).
    const cacheSystem = cacheControl && markedBreakpoints === 0 ? cacheControl : undefined;
    let systemContent: unknown;
    if (typeof systemPrompt === 'string') {
      if (cacheSystem) {
        // Must use array format for cache_control support
        systemContent = [{ type: 'text', text: systemPrompt, cache_control: cacheSystem }];
      } else {
        systemContent = systemPrompt;
      }
    } else if (Array.isArray(systemPrompt)) {
      if (cacheSystem && systemPrompt.length > 0) {
        // Add cache_control to the last system block
        systemContent = systemPrompt.map((block, idx) => {
          if (idx === systemPrompt.length - 1) {
            return { ...block, cache_control: cacheSystem };
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
      stopSequences: additionalStopSequences ?? [],
      nativeTools,
      ready: normalized.ready,
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

  /** Replace API-unacceptable image blocks nested in tool_result content with
   *  text placeholders. Non-array content passes through untouched. */
  private static sanitizeToolResultContent(content: unknown): unknown {
    if (!Array.isArray(content)) return content;
    return content.map((item) => {
      if (
        item &&
        typeof item === 'object' &&
        (item as { type?: string }).type === 'image'
      ) {
        const src = (item as { source?: { media_type?: string } }).source;
        if (!isAcceptedImageMediaType(src?.media_type)) {
          return strippedImagePlaceholder(src?.media_type);
        }
      }
      return item;
    });
  }

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
          if (!isAcceptedImageMediaType(block.source.mediaType)) {
            // Unacceptable media type (e.g. image/svg): degrade to a text
            // placeholder instead of poisoning the whole request.
            result.push(strippedImagePlaceholder(block.source.mediaType));
          } else {
            const imageBlock: Record<string, unknown> = {
              type: 'image',
              source: {
                type: 'base64',
                media_type: block.source.mediaType,
                data: block.source.data,
              },
            };
            // Preserve sourceUrl for providers that use URL-as-text (Gemini 3.x)
            if (block.sourceUrl) {
              imageBlock.sourceUrl = block.sourceUrl;
            }
            result.push(imageBlock);
          }
        }
      } else if (block.type === 'audio') {
        // Pass audio through in the same shape as images — the provider
        // adapters convert it (Gemini → inlineData, OpenRouter → input_audio).
        // Whether a given model accepts audio is the provider/model's concern.
        if (block.source.type === 'base64') {
          result.push({
            type: 'audio',
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
          content: NativeFormatter.sanitizeToolResultContent(block.content),
          is_error: block.isError,
        });
      } else if (block.type === 'thinking') {
        // Round-trip thinking blocks verbatim, including the signature — the
        // API validates it and (on display:'omitted' models) decrypts it to
        // reconstruct the original reasoning. Signature-only blocks (empty
        // thinking field) are valid and must be passed back unchanged.
        result.push({
          type: 'thinking',
          thinking: block.thinking,
          ...((block as { signature?: string }).signature
            ? { signature: (block as { signature?: string }).signature }
            : {}),
        });
      } else if (block.type === 'redacted_thinking') {
        // Pass through verbatim (carries encrypted data field)
        result.push({ ...(block as unknown as Record<string, unknown>) });
      } else if (block.type === 'document') {
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

  private convertToNativeTools(tools: ToolDefinition[]): unknown[] {
    return tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));
  }
}
