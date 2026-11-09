import { NativeFormatter } from './native.js';
import type {
  NormalizedMessage,
  ContentBlock,
  ToolDefinition,
  ToolCall,
  ToolResult,
  ToolUseContent,
  ToolResultContent,
  ToolResultContentBlock,
} from '../types/index.js';
import type {
  PrefillFormatter,
  StreamParser,
  BuildOptions,
  BuildResult,
  FormatterConfig,
  NormalizeEvent,
  ProviderMessage,
} from './types.js';
import {
  parseToolCalls as parseToolCallsXml,
  formatToolResults as formatToolResultsXml,
  parseAccumulatedIntoBlocks,
  formatToolDefinitions,
  toolDefinitionForPrompt,
  toolResultImage,
} from '../utils/tool-parser.js';
import { IncrementalXmlParser } from '../utils/stream-parser.js';
import { assertCacheMarkersWithinLimit, clampCacheMarkers } from '../utils/cache-marker-budget.js';
import { lastCacheableBlockIndex } from './native.js';
import { imageForRequest, isAcceptedImage } from '../utils/image-media.js';
import { convertMcpMedia } from '../utils/mcp-media.js';
import { holdsContent, isRawItemCarrier } from '../utils/fidelity.js';

export interface AnthropicXmlFormatterConfig extends FormatterConfig {
  /**
   * How to handle tool definitions:
   * - 'xml': Inject them as XML (prefill mode), where `toolInjectionMode` says
   * - 'native': Pass to API as native tools
   * Default: 'xml'
   */
  toolMode?: 'xml' | 'native';

  /**
   * Where to inject tool definitions when toolMode is 'xml':
   * - 'conversation': Inject into assistant content N messages from end
   * - 'system': Inject into system prompt
   * Default: 'conversation'
   */
  toolInjectionMode?: 'conversation' | 'system';

  /**
   * Position to inject tools (from end of messages).
   * Default: 10
   */
  toolInjectionPosition?: number;

  /**
   * Message delimiter for base models (e.g., '</s>').
   * Default: '' (none)
   */
  messageDelimiter?: string;

  /**
   * Maximum participants to include in stop sequences.
   * Default: 10
   */
  maxParticipantsForStop?: number;
}

/**
 * The messages with each tool result where the model reads it as its own
 * call's answer, and without the ones it can't stand there. The transcript
 * carries no ids: a results block answers the latest calls, those made since
 * the last result or user turn the request keeps before them, since a result
 * left out leaves no mark there, and a result reads as answering the first
 * of them not yet answered, of the tool its `<tool_name>` names where it
 * names its call's tool, or of any tool where it doesn't (an error goes out
 * without one). So within each run of
 * results in a message, a result whose id names a call takes that call, and
 * one whose id names no call takes the first call in its own message that no
 * later result names: a generation parsed back from its text gives its calls fresh
 * ids, and keeps its results beside them. The run keeps the host's order,
 * which a host can choose, except that a result that would read as another
 * call's answer waits until it reads as its own: results the model can't tell
 * apart, of one tool or without a name, go in call order, as a host that
 * stores results as their tools finish needs. One that never reads as its own
 * is never sent, as a result or as text, and a kept one that names a tool
 * other than its call's goes out without the name, so it reads back by
 * place, as it was kept. Results don't move between messages.
 * A kept result renders from its fields when its run was reordered, or when a
 * left-out result in any message shared its `rawXml`, since the raw text
 * holds the old order or the other result. `onEvent` hears each result left
 * out, and `onAltered` each message changed, and whether nothing of it is
 * left.
 */
function withoutCalllessResults(
  messages: NormalizedMessage[],
  assistant: string,
  onEvent: (event: NormalizeEvent) => void,
  onAltered: (index: number, emptied: boolean) => void,
): NormalizedMessage[] {
  const callIds = new Set<string>();
  for (const message of messages) {
    for (const block of message.content) if (block.type === 'tool_use') callIds.add(block.id);
  }
  // Each call's block, whether a result after it names its id, for the
  // fallback: a result whose id names no call doesn't take a call some
  // later result names.
  const namedAfter = new Set<ContentBlock>();
  const resultIds = new Set<string>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i]!.content;
    for (let j = content.length - 1; j >= 0; j--) {
      const block = content[j]!;
      if (block.type === 'tool_result' && typeof block.toolUseId === 'string') resultIds.add(block.toolUseId);
      else if (block.type === 'tool_use' && resultIds.has(block.id)) namedAfter.add(block);
    }
  }
  // The latest calls, those made since the last kept result or user turn
  // before them, as the wire shows them: a result left out doesn't end them.
  // Each with its message and tool, whether a later result names it, and
  // whether a kept result answers it.
  let calls: Array<{ id: string; message: number; tool: string; named: boolean; done: boolean }> = [];
  let keptSince = false;
  // Per call id, the calls so far that carry it, and how many of those a kept result answers.
  const carried = new Map<string, number>();
  const answered = new Map<string, number>();
  const released = new Set<string>();
  // Kept results that name a tool other than their call's: they go out
  // without the name, so they read back by place, as they were kept.
  const unnamed = new Set<ContentBlock>();
  // Each message's blocks as they go out, by index: a run of results in the
  // order the model reads each as its own call's answer, without the ones left out.
  const orders = messages.map((message, i) => {
    const order: number[] = [];
    const content = message.content;
    for (let j = 0; j < content.length;) {
      const first = content[j]!;
      if (first.type === 'tool_use') {
        if (keptSince) calls = [];
        keptSince = false;
        calls.push({ id: first.id, message: i, tool: first.name, named: namedAfter.has(first), done: false });
        carried.set(first.id, (carried.get(first.id) ?? 0) + 1);
        order.push(j++);
        continue;
      }
      if (first.type !== 'tool_result') {
        order.push(j++);
        continue;
      }
      const run: number[] = [];
      while (j < content.length && content[j]!.type === 'tool_result') run.push(j++);
      const taken = new Set<number>();
      const placeOf = new Map<number, number>();
      const take = (at: number, fits: (call: { id: string; message: number; named: boolean }) => boolean): void => {
        for (let k = 0; k < calls.length; k++) {
          if (taken.has(k) || calls[k]!.done || !fits(calls[k]!)) continue;
          taken.add(k);
          placeOf.set(at, k);
          return;
        }
      };
      const namedOf = (at: number): string | undefined => {
        const id = (content[at] as ToolResultContent).toolUseId;
        return typeof id === 'string' && callIds.has(id) ? id : undefined;
      };
      for (const at of run) {
        const named = namedOf(at);
        if (named !== undefined) take(at, (call) => call.id === named);
      }
      for (const at of run) {
        if (namedOf(at) === undefined) take(at, (call) => call.message === i && !call.named);
      }
      // Whether the model reads the result at `at` as its own call's answer:
      // the first call not yet answered, of the tool it names where that's
      // its call's, or of any tool.
      const readsAsOwn = (at: number): boolean => {
        const place = placeOf.get(at)!;
        const block = content[at] as ToolResultContent;
        const tool = !block.isError && block.toolName === calls[place]!.tool ? block.toolName : undefined;
        for (let k = 0; k < calls.length; k++) {
          if (calls[k]!.done || (tool !== undefined && calls[k]!.tool !== tool)) continue;
          return k === place;
        }
        return false;
      };
      const waiting = run.filter((at) => placeOf.has(at));
      const keptHere: number[] = [];
      for (let p = waiting.findIndex(readsAsOwn); p >= 0; p = waiting.findIndex(readsAsOwn)) {
        const at = waiting.splice(p, 1)[0]!;
        const call = calls[placeOf.get(at)!]!;
        call.done = true;
        answered.set(call.id, (answered.get(call.id) ?? 0) + 1);
        keptHere.push(at);
      }
      if (keptHere.length > 0) keptSince = true;
      const reordered = keptHere.some((at, k) => k > 0 && at < keptHere[k - 1]!);
      for (const at of run) {
        const block = content[at] as ToolResultContent;
        if (keptHere.includes(at)) {
          const misnamed = !block.isError && block.toolName !== undefined && block.toolName !== calls[placeOf.get(at)!]!.tool;
          if (misnamed) unnamed.add(block);
          if ((reordered || misnamed) && block.rawXml !== undefined) released.add(block.rawXml);
          continue;
        }
        const named = namedOf(at);
        onEvent(named !== undefined && (carried.get(named) ?? 0) > 0 && answered.get(named) === carried.get(named)
          ? { kind: 'stray_tool_result_dropped', toolUseId: named, reason: 'answered' }
          : { kind: 'orphan_tool_result_dropped', toolUseId: typeof block.toolUseId === 'string' ? block.toolUseId : '<missing>' });
        if (block.rawXml !== undefined) released.add(block.rawXml);
      }
      order.push(...keptHere);
    }
    // A user turn the request keeps ends the calls before it: the model reads
    // a later results block against the calls of its own turn.
    if (message.participant !== assistant && content.some(holdsTurnContent)) keptSince = true;
    return order;
  });

  return messages.map((message, index) => {
    const order = orders[index]!;
    let changed = order.length !== message.content.length || order.some((at, k) => at !== k);
    const content: ContentBlock[] = order.map((at) => {
      const block = message.content[at]!;
      if (block.type !== 'tool_result') return block;
      if (unnamed.has(block)) {
        const { rawXml: _raw, rawXmlImagesAt: _at, toolName: _name, ...rendered } = block;
        changed = true;
        return rendered;
      }
      if (block.rawXml === undefined || !released.has(block.rawXml)) return block;
      const { rawXml: _raw, rawXmlImagesAt: _at, ...rendered } = block;
      changed = true;
      return rendered;
    });
    if (!changed) return message;
    onAltered(index, !holdsContent(content));
    return { ...message, content };
  });
}

/**
 * Whether a block is something besides a tool call or result that the wire
 * shows: text that isn't blank (a raw item's carrier is empty), or an image
 * with a base64 source, sent as an image or as a placeholder's text. A
 * thinking block, an image with a url source, a document or audio shows
 * nothing. This restates what extractContent puts on the wire, so the two
 * change together.
 */
function holdsTurnContent(block: ContentBlock): boolean {
  if (block.type === 'text') return block.text.trim() !== '';
  return block.type === 'image' && block.source?.type === 'base64';
}

function toToolResult(block: ToolResultContent): ToolResult {
  let content: string | ToolResultContentBlock[];
  if (typeof block.content === 'string') {
    content = block.content;
  } else {
    content = [];
    for (const sub of block.content) {
      if (sub.type === 'text') {
        content.push({ type: 'text', text: sub.text });
      } else if (sub.type === 'image' && (!sub.source || sub.source.type === 'base64' || sub.source.type === 'url')) {
        content.push(sub as ToolResultContentBlock);
      }
    }
  }
  return {
    toolUseId: block.toolUseId,
    toolName: block.toolName,
    content,
    isError: block.isError ?? false,
  };
}

interface SentSplit {
  before: string;
  images: unknown[];
  after: string;
}

function sentSplit(group: readonly ToolResultContent[]): SentSplit | null {
  const rawXml = group[0]!.rawXml!;
  const marked = group.find((b) => typeof b.rawXmlImagesAt === 'number');
  // An offset counts from the start: slice() would read a negative one from the end.
  const at = marked?.rawXmlImagesAt ?? 0;
  if (at <= 0) return null;
  const after = rawXml.slice(at);
  if (!after.startsWith('\n</stdout>') && !after.startsWith('\n</error>')) return null;
  const images: unknown[] = [];
  for (const sub of Array.isArray(marked!.content) ? marked!.content : []) {
    if (sub.type !== 'image') continue;
    const { data, declared } = toolResultImage(sub);
    if (!isAcceptedImage(data)) continue;
    const { mediaType } = imageForRequest(data, declared);
    images.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data } });
  }
  return images.length > 0 ? { before: rawXml.slice(0, at), images, after } : null;
}

function holdsImage(block: ToolResultContent): boolean {
  return Array.isArray(block.content) && block.content.some((sub) => sub.type === 'image');
}

function rawXmlGroupCapacity(rawXml: string, kind: 'results' | 'calls', memo: Map<string, number>): number {
  let count = memo.get(rawXml);
  if (count === undefined) {
    const parsed = parseAccumulatedIntoBlocks(rawXml);
    count = kind === 'results' ? parsed.toolResults.length : parsed.toolCalls.length;
    memo.set(rawXml, count);
  }
  return count > 0 ? count : Infinity;
}

function escapeLayoutNewlines(value: string): string {
  return `${value.startsWith('\n') ? '\n' : ''}${value}${value.endsWith('\n') ? '\n' : ''}`;
}

export class AnthropicXmlFormatter implements PrefillFormatter {
  /** buildMessages records every consumer message it doesn't carry verbatim (utils/fidelity.ts). */
  readonly reportsAlterations = true;
  readonly name = 'anthropic-xml';
  readonly usesPrefill = true;
  readonly supportsNativeTools = true;
  readonly supportsXmlTools = true;

  /** See PrefillFormatter.configuredToolMode — undefined when the caller left the mode to Membrane. */
  readonly configuredToolMode: 'xml' | 'native' | undefined;

  private config: Required<AnthropicXmlFormatterConfig>;

  constructor(config: AnthropicXmlFormatterConfig = {}) {
    this.configuredToolMode = config.toolMode;
    this.config = {
      toolMode: config.toolMode ?? 'xml',
      toolInjectionMode: config.toolInjectionMode ?? 'conversation',
      toolInjectionPosition: config.toolInjectionPosition ?? 10,
      messageDelimiter: config.messageDelimiter ?? '',
      maxParticipantsForStop: config.maxParticipantsForStop ?? 10,
      unsupportedMedia: config.unsupportedMedia ?? 'error',
      warnOnStrip: config.warnOnStrip ?? true,
    };
  }

  buildMessages(messages: NormalizedMessage[], options: BuildOptions): BuildResult {
    messages = convertMcpMedia(messages);
    if ((options.toolMode ?? this.config.toolMode) === 'native') {
      return new NativeFormatter({
        unsupportedMedia: this.config.unsupportedMedia,
        warnOnStrip: this.config.warnOnStrip,
      }).buildMessages(messages, options);
    }
    const {
      assistantParticipant,
      tools,
      thinking,
      systemPrompt,
      promptCaching = false,
      cacheMarkers = 'membrane-system',
      cacheTtl,
      contextPrefix,
      prefillUserMessage,
      hasCacheMarker,
    } = options;

    const toolMode = options.toolMode ?? this.config.toolMode;

    const cacheControl: Record<string, unknown> = { type: 'ephemeral' };
    if (cacheTtl) {
      cacheControl.ttl = cacheTtl;
    }

    const providerMessages: ProviderMessage[] = [];
    const joiner = this.config.messageDelimiter ? '' : '\n';

    // Messages a dropped result left empty, whose breakpoints still apply.
    const emptiedByDrop = new Set<number>();
    // A message that held a result keeps the continuation state it had, so a
    // drop doesn't fold the next assistant message into it, and the caller's
    // cache-marker check reads the message as the caller gave it.
    const given = messages;
    const heldResult = messages.map((message) => message.content.some((c) => c.type === 'tool_result'));
    messages = withoutCalllessResults(messages, assistantParticipant, (event) => options.onNormalize?.(event), (index, emptied) => {
      options.fidelity?.alter(index);
      if (emptied) emptiedByDrop.add(index);
    });

    let currentConversation: string[] = [];
    let lastNonEmptyParticipant: string | null = null;
    let lastWasToolResults = false;


    const totalMessages = messages.length;
    const toolInjectionIndex = Math.max(0, totalMessages - this.config.toolInjectionPosition);
    let toolsInjected = false;
    const hasToolsForConversation =
      toolMode === 'xml' &&
      this.config.toolInjectionMode === 'conversation' &&
      tools &&
      tools.length > 0;
    const toolsText = hasToolsForConversation ? this.formatToolsForInjection(tools!) : '';

    const callerSystemBlocks = Array.isArray(systemPrompt)
      ? systemPrompt
          .filter((b): b is ContentBlock & { type: 'text' } => b.type === 'text')
          .map((b) => {
            const callerMarker = (b as unknown as { cache_control?: unknown }).cache_control;
            const block: Record<string, unknown> = { type: 'text', text: b.text };
            if (callerMarker) block.cache_control = callerMarker;
            return block;
          })
      : undefined;
    const systemBlocks = callerSystemBlocks?.length ? callerSystemBlocks : undefined;

    let systemText = typeof systemPrompt === 'string'
      ? systemPrompt
      : (systemBlocks?.map((b) => b.text as string).join('\n') ?? '');

    if (toolMode === 'xml' && this.config.toolInjectionMode === 'system' && tools?.length) {
      const toolsXml = this.formatToolDefinitionsXml(tools);
      systemText = this.injectToolsIntoSystem(systemText, toolsXml);
      if (systemBlocks) {
        const tail = systemBlocks[systemBlocks.length - 1]!;
        tail.text = this.injectToolsIntoSystem(tail.text as string, toolsXml);
      }
    }

    let systemContent: unknown;
    if (systemBlocks) {
      const callerMarkedAny = systemBlocks.some((b) => b.cache_control);
      if (promptCaching && cacheMarkers === 'membrane-system' && !callerMarkedAny) {
        const bpIdx = lastCacheableBlockIndex(systemBlocks);
        if (bpIdx >= 0) systemBlocks[bpIdx]!.cache_control = cacheControl;
      }
      systemContent = systemBlocks;
    } else if (systemText) {
      const systemBlock: Record<string, unknown> = { type: 'text', text: systemText };
      if (promptCaching && cacheMarkers === 'membrane-system') {
        systemBlock.cache_control = cacheControl;
      }
      systemContent = [systemBlock];
    }

    if (contextPrefix) {
      const prefixBlock: Record<string, unknown> = { type: 'text', text: contextPrefix };
      if (promptCaching && cacheMarkers === 'membrane-system') {
        prefixBlock.cache_control = cacheControl;
      }
      providerMessages.push({
        role: 'assistant',
        content: [prefixBlock],
      });
    }

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      if (!message) continue;

      const isLastMessage = i === messages.length - 1;
      const isAssistant = message.participant === assistantParticipant;

      const onAltered = options.fidelity ? () => options.fidelity!.alter(i) : undefined;
      const { text, images, hasUnsupportedMedia, segments, splitImages } = this.extractContent(message.content, message.participant, onAltered);
      const hasImages = images.length > 0;
      const isEmpty = !text.trim() && !hasImages;

      if (hasUnsupportedMedia) {
        if (this.config.unsupportedMedia === 'error') {
          throw new Error(`AnthropicXmlFormatter does not support media in message from ${message.participant}. Configure unsupportedMedia: 'strip' to ignore.`);
        } else if (this.config.warnOnStrip) {
          console.warn(`[AnthropicXmlFormatter] Stripped unsupported media from message`);
        }
      }

      const hasToolResult = heldResult[i]!;

      if (hasImages && !isEmpty) {
        if (currentConversation.length > 0) {
          providerMessages.push({
            role: 'assistant',
            content: currentConversation.join(joiner),
          });
          currentConversation = [];
        }

        const userContent: unknown[] = [];
        let prefix = `${message.participant}: `;
        for (let k = 0; k < segments.length; k++) {
          const piece = segments[k]!;
          if (prefix ? piece : piece.trim()) {
            userContent.push({ type: 'text', text: `${prefix}${piece}` });
            prefix = '';
          }
          if (k < splitImages.length) userContent.push(...splitImages[k]!);
        }
        userContent.push(...images);

        providerMessages.push({ role: 'user', content: userContent });
        lastNonEmptyParticipant = message.participant;
        continue;
      }

      const pushText = (prefix: string): void => {
        for (let k = 0; k < segments.length; k++) {
          const last = k === segments.length - 1;
          currentConversation.push(`${k === 0 ? prefix : ''}${segments[k]}${last ? this.config.messageDelimiter : ''}`);
          if (last) break;
          // Trimmed as the live split sent it: the prompt cache matches a prefix byte for byte.
          providerMessages.push({ role: 'assistant', content: currentConversation.join(joiner).trimEnd() });
          providerMessages.push({ role: 'user', content: splitImages[k]! });
          currentConversation = [];
        }
      };

      const omitted = () => {
        if (holdsContent(message.content)) onAltered?.();
      };

      const markConversation = () => {
        providerMessages.push({
          role: 'assistant',
          content: [{ type: 'text', text: currentConversation.join(joiner), cache_control: cacheControl }],
        });
        currentConversation = [];
      };

      if (isEmpty && !isLastMessage) {
        omitted();
        // A breakpoint on a message a dropped result emptied marks what came before it.
        if (emptiedByDrop.has(i) && currentConversation.length > 0 && promptCaching &&
          (message.cacheBreakpoint || hasCacheMarker?.(given[i]!, i))) markConversation();
        continue;
      }

      if (hasCacheMarker && hasCacheMarker(given[i]!, i)) {
        if (currentConversation.length > 0 && promptCaching) {
          markConversation();
        } else if (currentConversation.length > 0) {
          providerMessages.push({
            role: 'assistant',
            content: currentConversation.join(joiner),
          });
          currentConversation = [];
        }
      }

      const shouldInjectHere = toolInjectionIndex > 0 ? i >= toolInjectionIndex : i === 0;
      if (hasToolsForConversation && !toolsInjected && shouldInjectHere) {
        currentConversation.push(toolsText);
        toolsInjected = true;
      }

      const isBotMessage = message.participant === assistantParticipant;
      const isContinuation = isBotMessage && lastNonEmptyParticipant === assistantParticipant && !hasToolResult;

      const isPureToolResults =
        hasToolResult && message.content.every((c) => c.type === 'tool_result');

      if (isContinuation && isLastMessage) {
        omitted();
        continue;
      } else if (isLastMessage && isEmpty) {
        omitted();
      } else if (text) {
        if (isPureToolResults) {
          pushText('');
          lastWasToolResults = true;
        } else if (isBotMessage && lastWasToolResults) {
          pushText('');
          lastWasToolResults = false;
          lastNonEmptyParticipant = message.participant;
        } else {
          pushText(`${message.participant}: `);
          lastWasToolResults = false;
          if (!hasToolResult) {
            lastNonEmptyParticipant = message.participant;
          }
        }
      }

      if (message.cacheBreakpoint && promptCaching && currentConversation.length > 0) markConversation();
    }

    let turnPrefix: string;
    if (thinking?.enabled) {
      turnPrefix = `${assistantParticipant}: <thinking>`;
    } else {
      turnPrefix = `${assistantParticipant}:`;
    }

    if (hasToolsForConversation && !toolsInjected) {
      currentConversation.push(toolsText);
    }

    if (currentConversation.length > 0) {
      providerMessages.push({
        role: 'assistant',
        content: [...currentConversation, turnPrefix].join(joiner),
      });
    } else {
      providerMessages.push({
        role: 'assistant',
        content: turnPrefix,
      });
    }

    // The Claude Messages API requires the first message to be the user's
    // (Bedrock and older Claude models enforce it strictly).
    if (providerMessages.length > 0 && providerMessages[0]!.role !== 'user') {
      if (prefillUserMessage) {
        providerMessages.unshift({
          role: 'user',
          content: prefillUserMessage,
        });
      } else if (!systemText) {
        const cliSystemBlock: Record<string, unknown> = {
          type: 'text',
          text: 'The assistant is in CLI simulation mode, and responds to the user\'s CLI commands only with the output of the command.',
        };
        if (promptCaching && cacheMarkers === 'membrane-system') {
          cliSystemBlock.cache_control = cacheControl;
        }
        systemContent = [cliSystemBlock];
        providerMessages.unshift({
          role: 'user',
          content: '<cmd>cat untitled.txt</cmd>',
        });
      } else {
        providerMessages.unshift({
          role: 'user',
          content: '[Start]',
        });
      }
    }

    const stopSequences = this.buildStopSequences(messages, assistantParticipant, options);

    const nativeTools = toolMode === 'native' && tools?.length
      ? this.convertToNativeTools(tools)
      : undefined;

    const cacheSurfaces = { messages: providerMessages, system: systemContent, tools: nativeTools };
    const budget = cacheMarkers === 'cm-owned'
      ? { total: assertCacheMarkersWithinLimit(cacheSurfaces, 'anthropic-xml') }
      : clampCacheMarkers(cacheSurfaces, 'anthropic-xml');

    return {
      messages: providerMessages,
      systemContent,
      assistantPrefill: typeof providerMessages[providerMessages.length - 1]?.content === 'string'
        ? providerMessages[providerMessages.length - 1]!.content as string
        : undefined,
      stopSequences,
      nativeTools,
      cacheMarkersApplied: budget.total,
    };
  }

  formatToolResults(results: ToolResult[], options?: { thinking?: boolean }): string {
    let xml = formatToolResultsXml(results);
    if (options?.thinking) {
      xml += '\n<thinking>';
    }
    return xml;
  }

  createStreamParser(): StreamParser {
    return new IncrementalXmlParser();
  }

  parseToolCalls(content: string, tools?: ToolDefinition[]): ToolCall[] {
    const result = parseToolCallsXml(content, tools ? { tools } : undefined);
    return result?.calls ?? [];
  }

  hasToolUse(content: string): boolean {
    return /<(antml:)?function_calls>/.test(content);
  }

  parseContentBlocks(content: string, tools?: ToolDefinition[]): ContentBlock[] {
    const { blocks } = parseAccumulatedIntoBlocks(content, tools ? { tools } : undefined);
    return blocks;
  }

  /**
   * What a message puts on the wire. holdsTurnContent restates which blocks
   * besides calls and results show here, to end a group of calls at a user
   * turn the wire shows, so the two change together.
   */
  private extractContent(
    content: ContentBlock[],
    participant: string,
    onAltered?: () => void,
  ): { text: string; images: unknown[]; hasUnsupportedMedia: boolean; segments: string[]; splitImages: unknown[][] } {
    let parts: string[] = [];
    const images: unknown[] = [];
    let hasUnsupportedMedia = false;
    const segments: string[] = [];
    const splitImages: unknown[][] = [];

    for (let i = 0; i < content.length; i++) {
      const block = content[i]!;
      if (block.type === 'text') {
        if (isRawItemCarrier(block)) {
          onAltered?.();
          continue;
        }
        parts.push(block.text);
      } else if (block.type === 'image') {
        if (block.source?.type === 'base64') {
          const { mediaType, placeholder } = imageForRequest(block.source.data, block.source.mediaType);
          if (placeholder) {
            parts.push(placeholder.text);
            onAltered?.();
          } else {
            images.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: block.source.data,
              },
            });
          }
        } else {
          onAltered?.();
        }
      } else if (block.type === 'tool_use') {
        const run: ToolUseContent[] = [];
        while (i < content.length && content[i]!.type === 'tool_use') {
          run.push(content[i] as ToolUseContent);
          i++;
        }
        i--;
        parts.push(...this.renderToolUseRun(run));
      } else if (block.type === 'tool_result') {
        const run: ToolResultContent[] = [];
        while (i < content.length && content[i]!.type === 'tool_result') {
          run.push(content[i] as ToolResultContent);
          i++;
        }
        i--;
        for (const piece of this.renderToolResultRun(run, onAltered)) {
          if (typeof piece === 'string') {
            parts.push(piece);
          } else {
            parts.push(piece.before);
            segments.push(parts.join('\n'));
            splitImages.push(piece.images);
            parts = [piece.after];
          }
        }
      } else if (block.type === 'document' || block.type === 'audio') {
        hasUnsupportedMedia = true;
        onAltered?.();
      } else {
        onAltered?.();
      }
    }

    segments.push(parts.join('\n'));
    return { text: segments.join(''), images, hasUnsupportedMedia, segments, splitImages };
  }

  /**
   * In prefill mode a tool call is text the model generated, so it's replayed
   * as that text (antra-tess/membrane#36); a block stored without it can only
   * be reconstructed.
   */
  private renderToolUseRun(run: ToolUseContent[]): string[] {
    const out: string[] = [];
    let legacy: ToolUseContent[] = [];
    let lastRaw: string | undefined;
    let inBlock = 0;
    const counts = new Map<string, number>();

    const flushLegacy = () => {
      if (legacy.length > 0) {
        out.push(this.formatLegacyToolUseXml(legacy));
        legacy = [];
      }
    };

    for (const block of run) {
      if (block.rawXml) {
        flushLegacy();
        if (block.rawXml !== lastRaw || inBlock >= rawXmlGroupCapacity(block.rawXml, 'calls', counts)) {
          out.push(block.rawXml);
          inBlock = 0;
        }
        lastRaw = block.rawXml;
        inBlock++;
      } else {
        lastRaw = undefined;
        legacy.push(block);
      }
    }
    flushLegacy();
    return out;
  }

  private renderToolResultRun(run: ToolResultContent[], onAltered?: () => void): Array<string | SentSplit> {
    const out: Array<string | SentSplit> = [];
    let legacy: ToolResultContent[] = [];
    const counts = new Map<string, number>();

    const flushLegacy = () => {
      if (legacy.length > 0) {
        if (legacy.some((r) => Array.isArray(r.content) && r.content.some((sub) => sub.type !== 'text'))) onAltered?.();
        out.push(formatToolResultsXml(legacy.map(toToolResult)));
        legacy = [];
      }
    };

    for (let i = 0; i < run.length;) {
      const block = run[i]!;
      if (!block.rawXml) {
        legacy.push(block);
        i++;
        continue;
      }
      flushLegacy();
      const cap = run[i + 1]?.rawXml === block.rawXml ? rawXmlGroupCapacity(block.rawXml, 'results', counts) : 1;
      let end = i + 1;
      let marked = typeof block.rawXmlImagesAt === 'number';
      while (end < run.length && end - i < cap && run[end]!.rawXml === block.rawXml) {
        const nextMarked = typeof run[end]!.rawXmlImagesAt === 'number';
        if (marked && nextMarked) break;
        marked ||= nextMarked;
        end++;
      }
      const group = run.slice(i, end);
      i = end;
      const split = sentSplit(group);
      if (!split && group.some((b) => typeof b.rawXmlImagesAt === 'number' && holdsImage(b))) onAltered?.();
      out.push(split ?? block.rawXml);
    }
    flushLegacy();
    return out;
  }

  private formatLegacyToolUseXml(blocks: ToolUseContent[]): string {
    const lines = ['<function_calls>'];
    for (const block of blocks) {
      lines.push(`<invoke name="${block.name}">`);
      for (const [name, value] of Object.entries(block.input)) {
        const text =
          typeof value === 'string'
            ? escapeLayoutNewlines(value)
            : JSON.stringify(value);
        lines.push(`<parameter name="${name}">${text}</parameter>`);
      }
      lines.push('</invoke>');
    }
    lines.push('</function_calls>');
    return lines.join('\n');
  }

  private formatToolDefinitionsXml(tools: ToolDefinition[]): string {
    // A null the schema's other keywords leave out isn't marked, though the
    // parser still reads it (antra-tess/membrane#150).
    return formatToolDefinitions(tools.map(toolDefinitionForPrompt));
  }

  private formatToolsForInjection(tools: ToolDefinition[]): string {
    const toolsXml = this.formatToolDefinitionsXml(tools);

    const FUNC_CALLS_OPEN = '<' + 'function_calls>';
    const FUNC_CALLS_CLOSE = '</' + 'function_calls>';
    const INVOKE_OPEN = '<' + 'invoke name="';
    const INVOKE_CLOSE = '</' + 'invoke>';
    const PARAM_OPEN = '<' + 'parameter name="';
    const PARAM_CLOSE = '</' + 'parameter>';

    return `
<available_tools>
${toolsXml}
</available_tools>

When you want to use a tool, output:
${FUNC_CALLS_OPEN}
${INVOKE_OPEN}tool_name">
${PARAM_OPEN}param_name">value${PARAM_CLOSE}
${INVOKE_CLOSE}
${FUNC_CALLS_CLOSE}`;
  }

  private injectToolsIntoSystem(system: string, toolsXml: string): string {
    const toolsSection = `
<available_tools>
${toolsXml}
</available_tools>

When you want to use a tool, output:
<function_calls>
<invoke name="tool_name">
<parameter name="param_name">value</parameter>
</invoke>
</function_calls>
`;
    return system + '\n\n' + toolsSection;
  }

  private buildStopSequences(
    messages: NormalizedMessage[],
    assistantName: string,
    options: BuildOptions
  ): string[] {
    const sequences: string[] = [];

    const maxParticipants = options.maxParticipantsForStop ?? this.config.maxParticipantsForStop;

    const participants = new Set<string>();
    for (let i = messages.length - 1; i >= 0 && participants.size < maxParticipants; i--) {
      const message = messages[i];
      if (message && message.participant !== assistantName) {
        participants.add(message.participant);
      }
    }

    for (const participant of participants) {
      sequences.push(`\n${participant}:`);
    }

    sequences.push('</function_calls>');

    if (options.additionalStopSequences?.length) {
      sequences.push(...options.additionalStopSequences);
    }

    return sequences;
  }

  private convertToNativeTools(tools: ToolDefinition[]): unknown[] {
    return tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));
  }
}
