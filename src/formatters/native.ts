import { followNormalizedBlocks, isRawItemCarrier, ownBlocks, type FidelityNotes } from '../utils/fidelity.js';
import { sanitizeToolName } from '../utils/tool-names.js';
import { systemChangeRefusedError, unsupportedError } from '../types/errors.js';
import { isSystemChangeContent } from '../types/content.js';
import { hasNonEmptyText } from '../utils/empty-text.js';
import { isUnsignedThinking } from '../utils/thinking-carriers.js';

import type {
  NormalizedMessage,
  ContentBlock,
  SystemChangeContent,
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
  ProviderTurnMessage,
  ParseResult,
  BlockType,
  BlockEvent,
  StreamEmission,
} from './types.js';
import { normalizeToolPairs, mergeConsecutiveRoles } from './normalize-tool-pairs.js';
import { imageForRequest, toolResultContentForRequest } from '../utils/image-media.js';
import { convertMcpMedia } from '../utils/mcp-media.js';
import { assertCacheMarkersWithinLimit, countWireCacheMarkers } from '../utils/cache-marker-budget.js';
import { anthropicServerBlockFor, unpairedServerBlocks } from '../utils/anthropic-server-blocks.js';

export function withoutEmptySystemText(
  system: string | ContentBlock[] | undefined,
): string | ContentBlock[] | undefined {
  if (typeof system === 'string') return system === '' ? undefined : system;
  if (!Array.isArray(system)) return system;
  const blocks = system.filter((block) => !(block.type === 'text' && (block as { text?: unknown }).text === ''));
  return blocks.length > 0 ? blocks : undefined;
}

/** Anthropic rejects cache_control on thinking and redacted_thinking blocks. */
export function lastCacheableBlockIndex(blocks: Array<Record<string, unknown>>): number {
  for (let k = blocks.length - 1; k >= 0; k--) {
    const t = blocks[k]?.type as string | undefined;
    if (t !== 'thinking' && t !== 'redacted_thinking') return k;
  }
  return -1;
}

function markLastCacheable(blocks: Array<Record<string, unknown>>, cacheControl: Record<string, unknown>): void {
  const at = lastCacheableBlockIndex(blocks);
  if (at >= 0) blocks[at]!.cache_control = cacheControl;
}

interface BuiltSystemChange {
  content: Array<Record<string, unknown>>;
  at: number;
}

export interface NativeFormatterConfig extends FormatterConfig {
  /**
   * Format for participant name prefix in multiuser mode.
   * Use {name} as placeholder. Default: '{name}: '
   */
  nameFormat?: string;
}

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
    return false;
  }

  getDepths(): { functionCalls: number; functionResults: number; thinking: number } {
    return { functionCalls: 0, functionResults: 0, thinking: 0 };
  }

  resetForNewIteration(): void {
  }
}

export class NativeFormatter implements PrefillFormatter {
  /** buildMessages records every consumer message it doesn't carry verbatim (utils/fidelity.ts). */
  readonly reportsAlterations = true;
  readonly name = 'native';
  readonly usesPrefill = false;
  readonly supportsNativeTools = true;
  readonly supportsXmlTools = false;
  /** A message of `system_change` blocks goes as a mid-conversation `role: 'system'` message (SystemChangeContent). */
  readonly rendersSystemChanges = true;

  readonly nameFormat: string;
  private config: Required<FormatterConfig>;

  constructor(config: NativeFormatterConfig = {}) {
    this.nameFormat = config.nameFormat ?? '{name}: ';
    this.config = {
      unsupportedMedia: config.unsupportedMedia ?? 'error',
      warnOnStrip: config.warnOnStrip ?? true,
    };
  }

  buildMessages(messages: NormalizedMessage[], options: BuildOptions): BuildResult {
    messages = convertMcpMedia(messages);
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

    const cacheControl: Record<string, unknown> | undefined = promptCaching
      ? { type: 'ephemeral', ...(cacheTtl ? { ttl: cacheTtl } : {}) }
      : undefined;

    const providerMessages: ProviderTurnMessage[] = [];
    const systemChanges: BuiltSystemChange[] = [];
    const origin = new WeakMap<object, number>();
    let previousContent: Array<Record<string, unknown>> | undefined;
    const wireNames = new Map<string, string>();
    for (const tool of tools ?? []) wireNames.set(sanitizeToolName(tool.name), tool.name);

    if (contextPrefix) {
      const prefixBlock: Record<string, unknown> = { type: 'text', text: contextPrefix };
      if (promptCaching && cacheControl && cacheMarkers === 'membrane-system') {
        prefixBlock.cache_control = cacheControl;
      }
      providerMessages.push({
        role: 'assistant',
        content: [prefixBlock],
      });
      previousContent = [prefixBlock];
    }

    if (participantMode === 'simple' && !humanParticipant) {
      throw new Error('NativeFormatter in simple mode requires humanParticipant option');
    }

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      if (!message) continue;

      const changes = message.content.filter(isSystemChangeContent);
      if (changes.length > 0) {
        if (changes.length !== message.content.length) {
          throw unsupportedError(
            `NativeFormatter: message ${i} holds a system_change block beside other blocks. A message holding one holds nothing else.`
          );
        }
        const content = this.convertSystemChanges(changes, wireNames, () => options.fidelity?.alter(i));
        if (content.length === 0) continue;
        ownBlocks(options.fidelity, content, i);
        if (hasCacheMarker && hasCacheMarker(message, i) && cacheControl && previousContent) {
          markLastCacheable(previousContent, cacheControl);
        }
        if (message.cacheBreakpoint && cacheControl) markLastCacheable(content, cacheControl);
        systemChanges.push({ content, at: i });
        continue;
      }

      const isAssistant = message.participant === assistantParticipant;

      if (participantMode === 'simple') {
        if (!isAssistant && message.participant !== humanParticipant) {
          throw new Error(
            `NativeFormatter in simple mode only supports "${humanParticipant}" and "${assistantParticipant}". ` +
            `Got: "${message.participant}". Use participantMode: 'multiuser' for multiple participants.`
          );
        }
      }

      const role: 'user' | 'assistant' = isAssistant ? 'assistant' : 'user';

      const content = this.convertContent(message.content, message.participant, {
        includeNames: participantMode === 'multiuser' && !isAssistant,
        isAssistant,
        serverBlocks: options.anthropicServerBlocks === true,
        ...(options.fidelity ? { onAltered: () => options.fidelity!.alter(i) } : {}),
      });

      if (
        cacheMarkers === 'cm-owned' &&
        content.some((block) => Boolean((block as Record<string, unknown>).cache_control))
      ) {
        throw new Error('cm-owned cache markers reject imported block-level cache_control');
      }

      if (content.length === 0) {
        continue;
      }
      ownBlocks(options.fidelity, content, i);
      for (const block of content) origin.set(block as object, i);

      if (hasCacheMarker && hasCacheMarker(message, i) && cacheControl && previousContent) {
        markLastCacheable(previousContent, cacheControl);
      }

      providerMessages.push({ role, content });
      previousContent = content as Array<Record<string, unknown>>;

      if (message.cacheBreakpoint && cacheControl && content.length > 0) {
        const bpIdx = lastCacheableBlockIndex(content as Record<string, unknown>[]);
        if (bpIdx >= 0) {
          (content[bpIdx] as Record<string, unknown>).cache_control = cacheControl;
        }
      }
    }

    const normalized = normalizeToolPairs(providerMessages, {
      pendingToolCallIds: options.pendingToolCallIds,
      onEvent: options.onNormalize,
      ...followNormalizedBlocks(options.fidelity),
      leadingUserText: options.prefillUserMessage,
    });

    let mergedMessages = mergeConsecutiveRoles(normalized.messages);
    mergedMessages = NativeFormatter.pairServerBlocks(mergedMessages, options.fidelity);
    const builtMessages: ProviderMessage[] = systemChanges.length > 0
      ? NativeFormatter.placeSystemChanges(mergedMessages, systemChanges, origin)
      : mergedMessages;

    // A message breakpoint caches a prefix from the front of the request, tools
    // and system included, so a system marker beside one only spends one of
    // Anthropic's 4 slots. The API doesn't cache an empty text block.
    const system = withoutEmptySystemText(systemPrompt);
    const markedBreakpoints = countWireCacheMarkers({ messages: builtMessages, system });
    const cacheSystem =
      cacheMarkers === 'membrane-system' && cacheControl && markedBreakpoints === 0
        ? cacheControl
        : undefined;
    let systemContent: unknown;
    if (typeof system === 'string') {
      if (cacheSystem) {
        // cache_control rides a system block, so the prompt goes as an array of them.
        systemContent = [{ type: 'text', text: system, cache_control: cacheSystem }];
      } else {
        systemContent = system;
      }
    } else if (Array.isArray(system)) {
      if (cacheSystem) {
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

    const nativeTools = tools?.length ? this.convertToNativeTools(tools) : undefined;
    if (cacheMarkers === 'cm-owned' || !options.deferCacheBudgetCheck) {
      assertCacheMarkersWithinLimit(
        { messages: builtMessages, system: systemContent, tools: nativeTools },
        'native'
      );
    }

    return {
      messages: builtMessages,
      systemContent,
      stopSequences: additionalStopSequences ?? [],
      nativeTools,
      ready: normalized.ready,
    };
  }

  formatToolResults(results: ToolResult[]): string {
    return JSON.stringify(results.map(r => ({
      tool_use_id: r.toolUseId,
      content: r.content,
      is_error: r.isError,
    })));
  }

  createStreamParser(): StreamParser {
    return new PassthroughParser();
  }

  parseToolCalls(content: string): ToolCall[] {
    return [];
  }

  hasToolUse(content: string): boolean {
    return false;
  }

  parseContentBlocks(content: string, _tools?: ToolDefinition[], context?: ContentParseContext): ContentBlock[] {
    if (!content || !(context?.visibleText ?? content).trim()) {
      return [];
    }
    return [{ type: 'text', text: content }];
  }

  private static pairServerBlocks(messages: ProviderTurnMessage[], fidelity?: FidelityNotes): ProviderTurnMessage[] {
    const emptied = new Set<number>();
    const paired = messages.map((message, index) => {
      if (message.role !== 'assistant' || !Array.isArray(message.content)) return message;
      const unpaired = unpairedServerBlocks(message.content, index === messages.length - 1);
      if (unpaired.size === 0) return message;
      const blocks = message.content as Record<string, unknown>[];
      let marker: unknown;
      const kept = blocks.filter((block) => {
        if (!unpaired.has(block)) return true;
        fidelity?.alterBlock(block);
        if (block.cache_control) marker = block.cache_control;
        return false;
      });
      if (marker !== undefined && !kept.some((block) => block.cache_control)) {
        const at = lastCacheableBlockIndex(kept);
        if (at >= 0) kept[at]!.cache_control = marker;
      }
      if (kept.length === 0) emptied.add(index);
      return { ...message, content: kept };
    });
    if (emptied.size === 0) return paired;
    return mergeConsecutiveRoles(paired.filter((_, index) => !emptied.has(index)));
  }

  /**
   * The API takes a `role: 'system'` message, or a run of them, only after a
   * user turn, judging it by the message right before it: before an assistant
   * turn that follows a user turn, or at the end after a user turn, never
   * after an assistant turn. It accepts consecutive messages of one role.
   */
  private static placeSystemChanges(
    messages: ProviderTurnMessage[],
    changes: BuiltSystemChange[],
    origin: WeakMap<object, number>,
  ): ProviderMessage[] {
    const survives = (block: { type?: string; text?: unknown }): boolean =>
      (block.type !== 'text' || hasNonEmptyText(block.text)) && !isUnsignedThinking(block);
    const kept = (message: ProviderTurnMessage): boolean =>
      Array.isArray(message.content) && (message.content as Array<{ type?: string; text?: unknown }>).some(survives);
    type Turn = { role: ProviderTurnMessage['role']; first: number; earliest: number; after?: ProviderTurnMessage['role'] };
    const turns: Turn[] = [];
    messages.forEach((message, index) => {
      if (!kept(message)) return;
      let turn = turns[turns.length - 1];
      if (turn?.role !== message.role) {
        turn = { role: message.role, first: index, earliest: Infinity, after: turn?.role };
        turns.push(turn);
      }
      for (const block of message.content as Array<{ type?: string; text?: unknown }>) {
        const at = survives(block) ? origin.get(block) : undefined;
        if (at !== undefined && at < turn.earliest) turn.earliest = at;
      }
    });
    const points = new Map<number, number>();
    for (const turn of turns) if (turn.role === 'assistant' && turn.after === 'user') points.set(turn.first, turn.earliest);
    const placed: ProviderMessage[] = [];
    let next = 0;
    messages.forEach((message, index) => {
      const earliest = points.get(index);
      while (earliest !== undefined && earliest !== Infinity && next < changes.length && changes[next]!.at < earliest) {
        placed.push({ role: 'system', content: changes[next]!.content });
        next++;
      }
      placed.push(message);
    });
    if (next < changes.length) {
      if (turns[turns.length - 1]?.role !== 'user') {
        throw systemChangeRefusedError(
          `NativeFormatter: message ${changes[next]!.at}, a system change, has no place the API takes one at or after it: ` +
          'a system message goes after a user turn, and before an assistant turn or at the end. ' +
          'End the request with a user turn that has content after it, or make the change in the request\'s tools and system.'
        );
      }
      for (; next < changes.length; next++) placed.push({ role: 'system', content: changes[next]!.content });
    }
    return placed;
  }

  private convertSystemChanges(
    changes: SystemChangeContent[],
    wireNames: Map<string, string>,
    onAltered: () => void,
  ): Array<Record<string, unknown>> {
    const blocks: Array<Record<string, unknown>> = [];
    const claim = (name: string): string => {
      const wire = sanitizeToolName(name);
      const holder = wireNames.get(wire);
      if (holder !== undefined && holder !== name) {
        throw unsupportedError('Native tool names collide after colon escaping: "' + wire + '". Choose distinct wire names.');
      }
      return wire;
    };
    for (const change of changes) {
      for (const name of change.removeTools ?? []) {
        const wire = claim(name);
        if (wireNames.get(wire) === name) wireNames.delete(wire);
        blocks.push({ type: 'tool_removal', tool: { type: 'tool_reference', name: wire } });
      }
      for (const tool of change.defineTools ?? []) {
        const name = claim(tool.name);
        wireNames.set(name, tool.name);
        blocks.push({
          type: 'tool_addition',
          tool: { type: 'tool_definition', definition: { name, description: tool.description, input_schema: tool.inputSchema } },
        });
      }
      for (const text of change.addSystem ?? []) {
        // The API refuses empty or whitespace text.
        if (hasNonEmptyText(text)) blocks.push({ type: 'text', text });
        else if (text !== '') onAltered();
      }
    }
    return blocks;
  }

  private convertContent(
    content: ContentBlock[],
    participant: string,
    options: { includeNames: boolean; isAssistant: boolean; serverBlocks: boolean; onAltered?: () => void }
  ): unknown[] {
    const result: unknown[] = [];
    let hasUnsupportedMedia = false;
    let hasText = false;
    const altered = () => options.onAltered?.();

    for (const block of content) {
      const serverBlock = anthropicServerBlockFor(block);
      if (serverBlock) {
        if (options.isAssistant && options.serverBlocks) result.push(serverBlock);
        else altered();
        continue;
      }
      if (block.type === 'text') {
        // The Anthropic API rejects an empty text block, so one goes before the name
        // prefix below would make it non-empty.
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
          const { mediaType, placeholder } = imageForRequest(block.source.data, block.source.mediaType);
          if (placeholder) {
            // Not an image the API accepts (an SVG, data that is no image at all, or no data).
            result.push(placeholder);
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
            // Gemini 3.x takes an image's URL as text.
            if (block.sourceUrl) {
              imageBlock.sourceUrl = block.sourceUrl;
            }
            result.push(imageBlock);
          }
        } else {
          altered();
        }
      } else if (block.type === 'audio') {
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
          altered();
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
          content: toolResultContentForRequest(block.content, options.onAltered),
          is_error: block.isError,
        });
      } else if (block.type === 'thinking') {
        // The API validates a thinking block's signature, and on display:'omitted'
        // models decrypts it to rebuild the reasoning, so the block goes back as it
        // is, a signature-only one included.
        result.push({
          type: 'thinking',
          thinking: block.thinking,
          ...((block as { signature?: string }).signature
            ? { signature: (block as { signature?: string }).signature }
            : {}),
        });
      } else if (block.type === 'redacted_thinking') {
        // A redacted_thinking block's encrypted `data` goes back as it is.
        result.push({ ...(block as unknown as Record<string, unknown>) });
      } else if (block.type === 'document') {
        hasUnsupportedMedia = true;
        altered();
      } else {
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
