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

      const hasToolResult = message.content.some(c => c.type === 'tool_result');

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

      if (isEmpty && !isLastMessage) {
        omitted();
        continue;
      }

      if (hasCacheMarker && hasCacheMarker(message, i)) {
        if (currentConversation.length > 0 && promptCaching) {
          const content = currentConversation.join(joiner);
          const contentBlock: Record<string, unknown> = { type: 'text', text: content };
          contentBlock.cache_control = cacheControl;
          providerMessages.push({
            role: 'assistant',
            content: [contentBlock],
          });
          currentConversation = [];
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

      if (message.cacheBreakpoint && promptCaching && currentConversation.length > 0) {
        const content = currentConversation.join(joiner);
        const contentBlock: Record<string, unknown> = { type: 'text', text: content };
        contentBlock.cache_control = cacheControl;
        providerMessages.push({
          role: 'assistant',
          content: [contentBlock],
        });
        currentConversation = [];
      }
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
