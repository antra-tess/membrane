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

/** Put a cache marker on a message's last block that can hold one. */
function markLastCacheable(blocks: Array<Record<string, unknown>>, cacheControl: Record<string, unknown>): void {
  const at = lastCacheableBlockIndex(blocks);
  if (at >= 0) blocks[at]!.cache_control = cacheControl;
}

/** A message of system changes, built, and the input index it came from. */
interface BuiltSystemChange {
  content: Array<Record<string, unknown>>;
  at: number;
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

  // ==========================================================================
  // REQUEST BUILDING
  // ==========================================================================

  buildMessages(messages: NormalizedMessage[], options: BuildOptions): BuildResult {
    // Media in MCP's form becomes membrane's first, for a caller that builds
    // messages directly. Membrane's own builds have converted it already and
    // get the same array back (utils/mcp-media.ts).
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

    // Build cache_control object if prompt caching is enabled
    const cacheControl: Record<string, unknown> | undefined = promptCaching
      ? { type: 'ephemeral', ...(cacheTtl ? { ttl: cacheTtl } : {}) }
      : undefined;

    const providerMessages: ProviderTurnMessage[] = [];
    // Messages of system changes stay out of the turn passes below and are
    // placed after them; `origin` gives each turn block's input index, which
    // the placement reads (placeSystemChanges).
    const systemChanges: BuiltSystemChange[] = [];
    const origin = new WeakMap<object, number>();
    // The content of the turn message before the current one in input order,
    // or the contextPrefix: where a hasCacheMarker boundary goes. A message of
    // system changes never takes one, since it can land past later turns, so
    // a boundary goes where it would with the request's changes left out.
    let previousContent: Array<Record<string, unknown>> | undefined;
    // Each tool's wire name, with the caller name that holds it, so a
    // definition in a system change can't take another tool's wire name.
    const wireNames = new Map<string, string>();
    for (const tool of tools ?? []) wireNames.set(sanitizeToolName(tool.name), tool.name);

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
      previousContent = [prefixBlock];
    }

    // Validate simple mode participants
    if (participantMode === 'simple' && !humanParticipant) {
      throw new Error('NativeFormatter in simple mode requires humanParticipant option');
    }

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      if (!message) continue;

      // A message of system changes goes by its blocks' type, whatever its
      // participant, and holds nothing else.
      const changes = message.content.filter(isSystemChangeContent);
      if (changes.length > 0) {
        if (changes.length !== message.content.length) {
          throw unsupportedError(
            `NativeFormatter: message ${i} holds a system_change block beside other blocks. A message holding one holds nothing else.`
          );
        }
        const content = this.convertSystemChanges(changes, wireNames, () => options.fidelity?.alter(i));
        if (content.length === 0) continue; // Nothing to change: skipped as an empty message is
        ownBlocks(options.fidelity, content, i);
        if (hasCacheMarker && hasCacheMarker(message, i) && cacheControl && previousContent) {
          markLastCacheable(previousContent, cacheControl);
        }
        if (message.cacheBreakpoint && cacheControl) markLastCacheable(content, cacheControl);
        systemChanges.push({ content, at: i });
        continue;
      }

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
        continue; // Skip empty messages
      }
      // An adapter's report about one of these blocks names this message.
      ownBlocks(options.fidelity, content, i);
      for (const block of content) origin.set(block as object, i);

      // hasCacheMarker: cache boundary is BEFORE this message — tag previous message's last block
      if (hasCacheMarker && hasCacheMarker(message, i) && cacheControl && previousContent) {
        markLastCacheable(previousContent, cacheControl);
      }

      providerMessages.push({ role, content });
      previousContent = content as Array<Record<string, unknown>>;

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

    // Merge consecutive same-role messages into one envelope per turn. The
    // API accepts consecutive same-role messages too, but counts one token
    // more at each boundary than for the same blocks in one message, so the
    // merge gives a turn one rendering however its blocks were stored.
    let mergedMessages = mergeConsecutiveRoles(normalized.messages);
    // A server call goes out only with its result in its turn, and a result
    // only with its call: the API refuses either alone. The request's final
    // message, if it's the assistant's, keeps its lone calls (a paused turn
    // is resumed there). The turn is the one sent, after the merge, so a
    // call and its result stored as two consecutive assistant messages stay
    // together. With server blocks off, none reached this far.
    mergedMessages = NativeFormatter.pairServerBlocks(mergedMessages, options.fidelity);
    const builtMessages: ProviderMessage[] = systemChanges.length > 0
      ? NativeFormatter.placeSystemChanges(mergedMessages, systemChanges, origin)
      : mergedMessages;

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
    const markedBreakpoints = countWireCacheMarkers({ messages: builtMessages, system });
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

  /**
   * Leave out of each assistant turn the server blocks the API refuses there
   * (unpairedServerBlocks: a lone call or result, a second block with an id,
   * an id that isn't a string, `container_upload`), reporting each one's
   * message altered. The final message, if it's the assistant's, keeps its
   * lone calls: a paused turn is resumed as the request's last message. A
   * marker the builder put on a block left out moves to the turn's last block
   * that can hold one, unless a kept block already carries one; with no kept
   * block that can hold one, it goes. A turn left with nothing is dropped,
   * its marker with it, and its neighbours merge again.
   */
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
   * Each message of system changes, as a `role: 'system'` message, at the
   * first point at or after its place where the API takes one: before an
   * assistant turn that follows a user turn (a tool-result turn included), or
   * at the end after a user turn. Never after an assistant turn, so never
   * after a paused one, which takes no tool change. The turns are read as the
   * adapter leaves them: its empty-text cleanup (utils/empty-text.ts) drops a
   * message of only empty or whitespace text, it leaves out a thinking block
   * with no signature (isUnsignedThinking), and the surviving messages of one
   * role between two of the other are one turn. The API
   * accepts consecutive messages of one role, and judges a system message, or
   * a run of them, by the message right before it, so a change goes right
   * after a user turn's
   * last surviving message and right before an assistant turn's first. Its
   * place is its input index: it
   * goes before the first surviving message of the first such assistant turn
   * whose earliest surviving block, across all its messages, came from a
   * later message, or at the end when the last surviving turn is a user turn.
   * A block keeps its input index through the turn passes when they move it;
   * one they rebuild, or a contextPrefix, has none. An assistant turn of such
   * blocks alone is no point, and one that holds them with later blocks is
   * dated by those, so a change can go ahead of a contextPrefix that shares
   * its turn. With no point at or after its
   * place, as after a final assistant turn, the request is refused before
   * sending. Adjacent ones keep their order, and the API judges consecutive
   * system messages together. The message's own breakpoint goes with it to
   * where it lands. A `hasCacheMarker` boundary never goes on it, since it can
   * land past later turns: a boundary, on it or on any other message, goes on
   * the turn message before that message in input order, where it would go
   * with the request's changes left out.
   */
  private static placeSystemChanges(
    messages: ProviderTurnMessage[],
    changes: BuiltSystemChange[],
    origin: WeakMap<object, number>,
  ): ProviderMessage[] {
    // A block the adapter keeps, and a turn holding one: its empty-text
    // cleanup drops whitespace text, and it leaves out a thinking block with
    // no signature (#191).
    const survives = (block: { type?: string; text?: unknown }): boolean =>
      (block.type !== 'text' || hasNonEmptyText(block.text)) && !isUnsignedThinking(block);
    const kept = (message: ProviderTurnMessage): boolean =>
      Array.isArray(message.content) && (message.content as Array<{ type?: string; text?: unknown }>).some(survives);
    // The turns as the cleanup leaves them: it drops a message with no
    // surviving block, and the surviving messages of one role between two of
    // the other are one turn, dated by the earliest input index among all its
    // surviving blocks.
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
    // A point: the first surviving message of an assistant turn after a user turn.
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

  /**
   * A message's system changes as the blocks of a `role: 'system'` message:
   * for each change in order, a `tool_removal` for each tool it withdraws, a
   * `tool_addition` for each tool it defines, then a text block for each
   * system text that isn't only whitespace, which the API refuses. A
   * definition's wire name can't be another caller name's, as in `tools`; a
   * removal frees the wire name of the tool it removes.
   */
  private convertSystemChanges(
    changes: SystemChangeContent[],
    wireNames: Map<string, string>,
    /** Called when a system text is left out, as an alteration of the message. */
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
        // The API refuses empty or whitespace text. An empty one says nothing,
        // as an empty text block elsewhere; whitespace left out is reported.
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
    // Any non-empty block not carried verbatim alters the consumer message.
    const altered = () => options.onAltered?.();

    for (const block of content) {
      // An Anthropic server-tool block (web search and the like), kept on a
      // zero-width carrier, goes back as the block itself in the assistant
      // turn that produced it (see utils/anthropic-server-blocks.ts), when
      // the build replays them (BuildOptions.anthropicServerBlocks). In a
      // message sent as a user turn, such as another participant's, it has
      // no place and is left out. An adapter for another wire leaves out a
      // block type it has no form for.
      // Sent, it is carried: the block is the carrier's item, its content.
      // Left out, the message loses it.
      const serverBlock = anthropicServerBlockFor(block);
      if (serverBlock) {
        if (options.isAssistant && options.serverBlocks) result.push(serverBlock);
        else altered();
        continue;
      }
      if (block.type === 'text') {
        // Empty text blocks are rejected by the Anthropic API. Any other
        // zero-width rawItem carrier (an opaque provider-native item from
        // another wire) has no form here and must not leak. Filter BEFORE
        // the name prefix below would make it non-empty. A carrier's item is
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
          const { mediaType, placeholder } = imageForRequest(block.source.data, block.source.mediaType);
          if (placeholder) {
            // Not an image the API accepts (an SVG, data that is no image at
            // all, or no data): degrade to a text placeholder instead of
            // poisoning the whole request.
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
          content: toolResultContentForRequest(block.content, options.onAltered),
          is_error: block.isError,
        });
      } else if (block.type === 'thinking') {
        // Round-trip thinking blocks verbatim, including the signature — the
        // API validates it and (on display:'omitted' models) decrypts it to
        // reconstruct the original reasoning. Signature-only blocks (empty
        // thinking field) are valid and must be passed back unchanged. The
        // Anthropic and Bedrock builders leave out one with no signature.
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
