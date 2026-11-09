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
  effort?: NonNullable<SystemChangeContent['effort']>;
  /** An effort change's breakpoint, or a boundary at its place: marked once the request is placed. */
  breakpoint?: boolean;
}

const EFFORT_LEVELS: ReadonlySet<unknown> = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function named(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    try {
      return String(value);
    } catch {
      return 'a value that has no text form';
    }
  }
}

function changesToolsOrSystem(change: SystemChangeContent): boolean {
  return (change.removeTools?.length ?? 0) > 0 || (change.defineTools?.length ?? 0) > 0 || (change.addSystem?.length ?? 0) > 0;
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
        const carrying = changes.find((change) => change.effort !== undefined);
        if (carrying) {
          if (changes.length > 1 || changesToolsOrSystem(changes[0]!)) {
            throw unsupportedError(
              `NativeFormatter: message ${i} carries an effort change beside another change. A block carrying effort carries nothing else, and its message holds nothing else.`
            );
          }
          if (!EFFORT_LEVELS.has(carrying.effort)) {
            throw unsupportedError(
              `NativeFormatter: message ${i} carries the effort ${named(carrying.effort)}, which is not one of 'low', 'medium', 'high', 'xhigh' and 'max'.`
            );
          }
          const breakpoint = Boolean(cacheControl && (message.cacheBreakpoint || hasCacheMarker?.(message, i)));
          systemChanges.push({ content: [], at: i, effort: carrying.effort, ...(breakpoint ? { breakpoint } : {}) });
          continue;
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

    const followed = followNormalizedBlocks(options.fidelity);
    const normalized = normalizeToolPairs(providerMessages, {
      pendingToolCallIds: options.pendingToolCallIds,
      onEvent: options.onNormalize,
      onBlockRewritten: (original, replacement) => {
        const at = origin.get(original as object);
        if (at !== undefined) origin.set(replacement as object, at);
        followed.onBlockRewritten?.(original, replacement);
      },
      leadingUserText: options.prefillUserMessage,
    });

    let mergedMessages = mergeConsecutiveRoles(normalized.messages);
    mergedMessages = NativeFormatter.pairServerBlocks(mergedMessages, options.fidelity);
    const builtMessages: ProviderMessage[] = systemChanges.length > 0
      ? NativeFormatter.placeSystemChanges(mergedMessages, systemChanges, origin, cacheControl)
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
   * The API takes a `role: 'system'` message of tool changes or system text,
   * or a run of them, only after a user turn, judging it by the message right
   * before it: before an assistant turn that follows a user turn, or at the
   * end after a user turn, never after an assistant turn. It accepts
   * consecutive messages of one role, and an effort-only message anywhere in
   * `messages` (Anthropic's effort documentation), so an effort change goes
   * right after the turn holding the last block of a message before it. At the
   * end after an assistant turn it would end the request on that turn, which
   * the API reads as a prefill.
   */
  private static placeSystemChanges(
    messages: ProviderTurnMessage[],
    changes: BuiltSystemChange[],
    origin: WeakMap<object, number>,
    cacheControl: Record<string, unknown> | undefined,
  ): ProviderMessage[] {
    type Block = { type?: string; text?: unknown };
    const survives = (block: Block): boolean =>
      (block.type !== 'text' || hasNonEmptyText(block.text)) && !isUnsignedThinking(block);
    const efforts = changes.filter((change) => change.effort !== undefined);
    const others = changes.filter((change) => change.effort === undefined);
    // A block membrane puts ahead of every message (the leading user turn, the context prefix) counts as before them all.
    let seen = false;
    const keys = messages.map((message) => (message.content as Block[]).map((block) => {
      const at = origin.get(block as object);
      if (at !== undefined) {
        seen = true;
        return at;
      }
      return seen ? undefined : -1;
    }));
    const slots = new Map<BuiltSystemChange, number>();
    for (const change of efforts) {
      let slot = 0;
      for (let k = messages.length - 1; k >= 0 && slot === 0; k--) {
        const content = messages[k]!.content as Block[];
        if (content.some((block, j) => keys[k]![j] !== undefined && keys[k]![j]! < change.at && survives(block))) slot = k + 1;
      }
      slots.set(change, slot);
    }

    // Tool changes and system text: before an assistant turn that follows a user turn, at the first one whose
    // earliest block comes after the change.
    const kept = (message: ProviderTurnMessage): boolean =>
      Array.isArray(message.content) && (message.content as Block[]).some(survives);
    type Turn = { role: ProviderTurnMessage['role']; first: number; earliest: number; after?: ProviderTurnMessage['role'] };
    const turns: Turn[] = [];
    messages.forEach((message, index) => {
      if (!kept(message)) return;
      let turn = turns[turns.length - 1];
      if (turn?.role !== message.role) {
        turn = { role: message.role, first: index, earliest: Infinity, after: turn?.role };
        turns.push(turn);
      }
      for (const block of message.content as Block[]) {
        const at = survives(block) ? origin.get(block as object) : undefined;
        if (at !== undefined && at < turn.earliest) turn.earliest = at;
      }
    });
    const points = new Map<number, number>();
    for (const turn of turns) if (turn.role === 'assistant' && turn.after === 'user') points.set(turn.first, turn.earliest);

    const sent = (change: BuiltSystemChange): ProviderMessage => change.effort !== undefined
      ? { role: 'system', content: [], output_config: { effort: change.effort } }
      : { role: 'system', content: change.content };
    const placed: ProviderMessage[] = [];
    const marked: number[] = [];
    const emit = (group: BuiltSystemChange[]): void => {
      for (const change of group.sort((a, b) => a.at - b.at)) {
        if (change.breakpoint) marked.push(placed.length);
        placed.push(sent(change));
      }
    };
    let next = 0;
    messages.forEach((message, index) => {
      const before = efforts.filter((change) => slots.get(change) === index);
      const earliest = points.get(index);
      while (earliest !== undefined && earliest !== Infinity && next < others.length && others[next]!.at < earliest) {
        before.push(others[next++]!);
      }
      emit(before);
      placed.push(message);
    });
    const after = efforts.filter((change) => slots.get(change) === messages.length);
    const endsOnUser = turns[turns.length - 1]?.role === 'user';
    if (after.length > 0 && !endsOnUser) {
      throw systemChangeRefusedError(
        `NativeFormatter: message ${after[0]!.at}, an effort change, would end the request with no user turn after the last assistant turn, ` +
        'which the API reads as a prefill. End the request with a user turn after it.'
      );
    }
    if (next < others.length) {
      if (!endsOnUser) {
        throw systemChangeRefusedError(
          `NativeFormatter: message ${others[next]!.at}, a system change, has no place the API takes one at or after it: ` +
          'a system message goes after a user turn, and before an assistant turn or at the end. ' +
          'End the request with a user turn that has content after it, or make the change in the request\'s tools and system.'
        );
      }
      after.push(...others.slice(next));
    }
    emit(after);

    // An effort change's breakpoint, having no block of its own, goes on the last cacheable block before it.
    if (cacheControl) {
      for (const at of marked) {
        search: for (let m = at - 1; m >= 0; m--) {
          const content = placed[m]!.content;
          if (!Array.isArray(content)) continue;
          for (let b = content.length - 1; b >= 0; b--) {
            const block = content[b] as Record<string, unknown>;
            if (block.type === 'thinking' || block.type === 'redacted_thinking' || !survives(block as Block)) continue;
            block.cache_control = cacheControl;
            break search;
          }
        }
      }
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
