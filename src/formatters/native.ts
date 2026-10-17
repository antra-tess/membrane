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

import { followNormalizedBlocks, isRawItemCarrier, ownBlocks } from '../utils/fidelity.js';
import { sanitizeToolName } from '../utils/tool-names.js';
import { unsupportedError } from '../types/errors.js';

import type {
  NormalizedMessage,
  ContentBlock,
  ToolDefinition,
  ToolCall,
  ToolResult,
} from '../types/index.js';
import type {
  PrefillFormatter,
  ContentParseContext,
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
import { resolveImageMediaType, isAcceptedImageMediaType, strippedImagePlaceholder } from '../utils/image-media.js';
import { assertCacheMarkersWithinLimit, countWireCacheMarkers } from '../utils/cache-marker-budget.js';

/** Index of the last content block that can carry cache_control. Anthropic
 *  rejects cache_control on thinking / redacted_thinking blocks, so a cache
 *  breakpoint must attach to the last NON-thinking block. Returns -1 when the
 *  message has only thinking blocks (the breakpoint is then skipped). */
/**
 * The system prompt as it goes on the wire: `''` and an array left with no
 * blocks become undefined, and empty text blocks leave an array.
 */
export function withoutEmptySystemText(
  system: string | ContentBlock[] | undefined,
): string | ContentBlock[] | undefined {
  if (typeof system === 'string') return system === '' ? undefined : system;
  if (!Array.isArray(system)) return system;
  const blocks = system.filter((block) => !(block.type === 'text' && (block as { text?: unknown }).text === ''));
  return blocks.length > 0 ? blocks : undefined;
}

export function lastCacheableBlockIndex(blocks: Array<Record<string, unknown>>): number {
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
  /** buildMessages records every consumer message it doesn't carry verbatim (utils/fidelity.ts). */
  readonly reportsAlterations = true;
  readonly name = 'native';
  readonly usesPrefill = false;
  readonly supportsNativeTools = true;
  readonly supportsXmlTools = false;

  readonly nameFormat: string;
  private config: Required<FormatterConfig>;

  constructor(config: NativeFormatterConfig = {}) {
    this.nameFormat = config.nameFormat ?? '{name}: ';
    this.config = {
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
      cacheMarkers = 'membrane-system',
      cacheTtl,
      hasCacheMarker,
      contextPrefix,
      additionalStopSequences,
    } = options;

    // Build cache_control object if prompt caching is enabled
    const cacheControl: Record<string, unknown> | undefined = promptCaching
      ? { type: 'ephemeral', ...(cacheTtl ? { ttl: cacheTtl } : {}) }
      : undefined;

    const providerMessages: ProviderMessage[] = [];

    // Add context prefix as first assistant message (for simulacrum seeding)
    if (contextPrefix) {
      const prefixBlock: Record<string, unknown> = { type: 'text', text: contextPrefix };
      if (promptCaching && cacheControl && cacheMarkers === 'membrane-system') {
        prefixBlock.cache_control = cacheControl;
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

      // Convert content (recording alterations against this message's index)
      const content = this.convertContent(message.content, message.participant, {
        includeNames: participantMode === 'multiuser' && !isAssistant,
        ...(options.fidelity ? { onAltered: () => options.fidelity!.alter(i) } : {}),
      });

      if (
        cacheMarkers === 'cm-owned' &&
        content.some((block) => Boolean((block as Record<string, unknown>).cache_control))
      ) {
        throw new Error('cm-owned cache markers reject imported block-level cache_control');
      }

      if (content.length === 0) {
        continue; // Skip empty messages
      }
      // An adapter's report about one of these blocks names this message.
      ownBlocks(options.fidelity, content, i);

      // hasCacheMarker: cache boundary is BEFORE this message — tag previous message's last block
      if (hasCacheMarker && hasCacheMarker(message, i) && cacheControl && providerMessages.length > 0) {
        const prevMsg = providerMessages[providerMessages.length - 1]!;
        const prevContent = Array.isArray(prevMsg.content) ? prevMsg.content as Record<string, unknown>[] : [];
        const prevIdx = lastCacheableBlockIndex(prevContent);
        if (prevIdx >= 0) {
          prevContent[prevIdx]!.cache_control = cacheControl;
        }
      }

      providerMessages.push({ role, content });

      // cacheBreakpoint: cache up to and INCLUDING this message — tag last block
      if (message.cacheBreakpoint && cacheControl && content.length > 0) {
        const bpIdx = lastCacheableBlockIndex(content as Record<string, unknown>[]);
        if (bpIdx >= 0) {
          (content[bpIdx] as Record<string, unknown>).cache_control = cacheControl;
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
      // A tool_result textified as an orphan or a duplicate alters the
      // message that occurrence came from, and its replacement keeps the owner.
      ...followNormalizedBlocks(options.fidelity),
      // The caller's synthetic user text, used where the normalizer decides a
      // leading user turn is needed: after a contextPrefix, before
      // assistant-first history, or after role repair moved a block forward.
      leadingUserText: options.prefillUserMessage,
    });

    // Merge consecutive same-role messages (API requires alternating)
    const mergedMessages = mergeConsecutiveRoles(normalized.messages);

    // Build system content. The system block is cached only as a FALLBACK: a
    // message breakpoint already caches a prefix that begins at the front of
    // the request, tools and system included, so a separate system marker
    // would waste one of Anthropic's 4 slots and can push a 4-marker turn to 5,
    // which the API rejects. The count is of the markers this request already
    // carries: on the merged messages (this build's own, a contextPrefix's,
    // and stale ones passed through on stored blocks) and on the caller's
    // system content, so a caller who marked their own system block gets no
    // fallback either. The budget check below covers the whole built request;
    // Membrane defers it (deferCacheBudgetCheck) to after its hooks, which
    // can still add markers.
    //
    // An empty system prompt is no system block. Wrapped for the fallback
    // marker it became a cache-marked empty text block, which the API doesn't
    // cache; a caller's empty text blocks are dropped the same way, before the
    // marker count and before the fallback picks the last block.
    const system = withoutEmptySystemText(systemPrompt);
    const markedBreakpoints = countWireCacheMarkers({ messages: mergedMessages, system });
    const cacheSystem =
      cacheMarkers === 'membrane-system' && cacheControl && markedBreakpoints === 0
        ? cacheControl
        : undefined;
    let systemContent: unknown;
    if (typeof system === 'string') {
      if (cacheSystem) {
        // Must use array format for cache_control support
        systemContent = [{ type: 'text', text: system, cache_control: cacheSystem }];
      } else {
        systemContent = system;
      }
    } else if (Array.isArray(system)) {
      if (cacheSystem) {
        // Add cache_control to the last system block
        systemContent = system.map((block, idx) => {
          if (idx === system.length - 1) {
            return { ...block, cache_control: cacheSystem };
          }
          return block;
        });
      } else {
        systemContent = system;
      }
    }

    // Native tools
    const nativeTools = tools?.length ? this.convertToNativeTools(tools) : undefined;
    if (cacheMarkers === 'cm-owned' || !options.deferCacheBudgetCheck) {
      assertCacheMarkersWithinLimit(
        { messages: mergedMessages, system: systemContent, tools: nativeTools },
        'native'
      );
    }

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

  parseContentBlocks(content: string, _tools?: ToolDefinition[], context?: ContentParseContext): ContentBlock[] {
    // Only a wholly blank response is omitted. Whitespace-only spans of a
    // nonblank response are still its text, including before thinking.
    if (!content || !(context?.visibleText ?? content).trim()) {
      return [];
    }
    return [{ type: 'text', text: content }];
  }

  // ==========================================================================
  // PRIVATE HELPERS
  // ==========================================================================

  /** Replace API-unacceptable image blocks nested in tool_result content with
   *  text placeholders. Non-array content passes through untouched.
   *  `onAltered` hears each placeholder substitution. */
  private static sanitizeToolResultContent(content: unknown, onAltered?: () => void): unknown {
    if (!Array.isArray(content)) return content;
    return content.map((item) => {
      if (
        item &&
        typeof item === 'object' &&
        (item as { type?: string }).type === 'image'
      ) {
        const src = (item as { source?: { type?: string; data?: string; mediaType?: string; media_type?: string } }).source;
        if (src?.type === 'url') return { ...item };
        const mediaType = resolveImageMediaType(src?.data, src?.mediaType ?? src?.media_type);
        if (!isAcceptedImageMediaType(mediaType)) {
          onAltered?.();
          return strippedImagePlaceholder(mediaType, item);
        }
        const { mediaType: _declared, ...source } = src ?? {};
        return { ...item, source: { ...source, media_type: mediaType } };
      }
      // Its own object per occurrence, so an adapter's report names one.
      return item !== null && typeof item === 'object' ? { ...item } : item;
    });
  }

  private convertContent(
    content: ContentBlock[],
    participant: string,
    options: { includeNames: boolean; onAltered?: () => void }
  ): unknown[] {
    const result: unknown[] = [];
    let hasUnsupportedMedia = false;
    let hasText = false;
    // Any non-empty block not carried verbatim alters the consumer message.
    const altered = () => options.onAltered?.();

    for (const block of content) {
      if (block.type === 'text') {
        // Empty text blocks are rejected by the Anthropic API. In particular,
        // zero-width rawItem carriers (opaque provider-native items smuggled
        // through normalized history) must not leak here. Filter BEFORE the
        // name prefix below would make them non-empty. A carrier's item is
        // its content, and it is not sent here.
        if (block.text === '') {
          if (isRawItemCarrier(block)) altered();
          continue;
        }
        let text = block.text;
        if (options.includeNames && !hasText) {
          const prefix = this.nameFormat.replace('{name}', () => participant);
          text = prefix + text;
        }
        hasText = true;
        const textBlock: Record<string, unknown> = { type: 'text', text };
        if (block.cache_control) {
          textBlock.cache_control = block.cache_control;
        }
        result.push(textBlock);
      } else if (block.type === 'image') {
        if (block.source?.type === 'base64') {
          const mediaType = resolveImageMediaType(block.source.data, block.source.mediaType);
          if (!isAcceptedImageMediaType(mediaType)) {
            // Unacceptable media type (e.g. image/svg): degrade to a text
            // placeholder instead of poisoning the whole request.
            result.push(strippedImagePlaceholder(mediaType, block));
            altered();
          } else {
            const imageBlock: Record<string, unknown> = {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: block.source.data,
              },
            };
            // Preserve sourceUrl for providers that use URL-as-text (Gemini 3.x)
            if (block.sourceUrl) {
              imageBlock.sourceUrl = block.sourceUrl;
            }
            result.push(imageBlock);
          }
        } else {
          // A source that isn't base64 has no branch here, and nor does no
          // source object at all (media in MCP's form that didn't convert,
          // utils/mcp-media.ts).
          altered();
        }
      } else if (block.type === 'audio') {
        // Pass audio through in the same shape as images — the provider
        // adapters convert it (Gemini → inlineData, OpenRouter → input_audio).
        // Whether a given model accepts audio is the provider/model's concern.
        if (block.source?.type === 'base64') {
          result.push({
            type: 'audio',
            source: {
              type: 'base64',
              media_type: block.source.mediaType,
              data: block.source.data,
            },
          });
        } else {
          altered(); // as for an image
        }
      } else if (block.type === 'tool_use') {
        result.push({
          type: 'tool_use',
          id: block.id,
          name: sanitizeToolName(block.name),
          input: block.input,
        });
      } else if (block.type === 'tool_result') {
        result.push({
          type: 'tool_result',
          tool_use_id: block.toolUseId,
          content: NativeFormatter.sanitizeToolResultContent(block.content, options.onAltered),
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
        altered();
      } else {
        // A block type this formatter does not convert is left out.
        altered();
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
    const names = new Set<string>();
    return tools.map(tool => {
      const name = sanitizeToolName(tool.name);
      if (names.has(name)) {
        throw unsupportedError('Native tool names collide after colon escaping: "' + name + '". Choose distinct wire names.');
      }
      names.add(name);
      return { name, description: tool.description, input_schema: tool.inputSchema };
    });
  }
}
