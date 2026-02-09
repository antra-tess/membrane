/**
 * Anthropic XML Formatter
 *
 * Prefill-based formatting for Anthropic models using XML tool syntax.
 * This is the "classic" membrane format with:
 * - Participant: content format
 * - <function_calls>/<function_results> for tools
 * - <thinking> blocks for extended thinking
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
} from './types.js';
import {
  parseToolCalls as parseToolCallsXml,
  formatToolResults as formatToolResultsXml,
  parseAccumulatedIntoBlocks,
  formatToolDefinitions,
  type ToolDefinitionForPrompt,
} from '../utils/tool-parser.js';
import { IncrementalXmlParser } from '../utils/stream-parser.js';

// ============================================================================
// Configuration
// ============================================================================

export interface AnthropicXmlFormatterConfig extends FormatterConfig {
  /**
   * How to handle tool definitions:
   * - 'xml': Inject into conversation as XML (prefill mode)
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

// ============================================================================
// Anthropic XML Formatter
// ============================================================================

export class AnthropicXmlFormatter implements PrefillFormatter {
  readonly name = 'anthropic-xml';
  readonly usesPrefill = true;

  private config: Required<AnthropicXmlFormatterConfig>;

  constructor(config: AnthropicXmlFormatterConfig = {}) {
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

  // ==========================================================================
  // REQUEST BUILDING
  // ==========================================================================

  buildMessages(messages: NormalizedMessage[], options: BuildOptions): BuildResult {
    const {
      assistantParticipant,
      tools,
      thinking,
      systemPrompt,
      promptCaching = false,
      cacheTtl,
      contextPrefix,
      hasCacheMarker,
    } = options;

    // Build cache_control object (with optional TTL for extended caching)
    const cacheControl: Record<string, unknown> = { type: 'ephemeral' };
    if (cacheTtl) {
      cacheControl.ttl = cacheTtl;
    }

    const providerMessages: ProviderMessage[] = [];
    const joiner = this.config.messageDelimiter ? '' : '\n';

    // Track conversation state
    let currentConversation: string[] = [];
    let lastNonEmptyParticipant: string | null = null;

    // Track cache markers applied
    let cacheMarkersApplied = 0;

    // Calculate tool injection point
    const totalMessages = messages.length;
    const toolInjectionIndex = Math.max(0, totalMessages - this.config.toolInjectionPosition);
    let toolsInjected = false;
    const hasToolsForConversation =
      this.config.toolMode === 'xml' &&
      this.config.toolInjectionMode === 'conversation' &&
      tools &&
      tools.length > 0;
    const toolsText = hasToolsForConversation ? this.formatToolsForInjection(tools!) : '';

    // Build system content
    let systemText = typeof systemPrompt === 'string' ? systemPrompt : '';
    if (Array.isArray(systemPrompt)) {
      systemText = systemPrompt
        .filter((b): b is ContentBlock & { type: 'text' } => b.type === 'text')
        .map(b => b.text)
        .join('\n');
    }

    // Inject tools into system if configured
    if (this.config.toolMode === 'xml' && this.config.toolInjectionMode === 'system' && tools?.length) {
      const toolsXml = this.formatToolDefinitionsXml(tools);
      systemText = this.injectToolsIntoSystem(systemText, toolsXml);
    }

    // Build system content with optional cache control
    let systemContent: unknown;
    if (systemText) {
      const systemBlock: Record<string, unknown> = { type: 'text', text: systemText };
      if (promptCaching) {
        systemBlock.cache_control = cacheControl;
        cacheMarkersApplied++;
      }
      systemContent = [systemBlock];
    }

    // Add context prefix as first cached assistant message (for simulacrum seeding)
    if (contextPrefix) {
      const prefixBlock: Record<string, unknown> = { type: 'text', text: contextPrefix };
      if (promptCaching) {
        prefixBlock.cache_control = cacheControl;
        cacheMarkersApplied++;
      }
      providerMessages.push({
        role: 'assistant',
        content: [prefixBlock],
      });
    }

    // Process messages
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      if (!message) continue;

      const isLastMessage = i === messages.length - 1;
      const isAssistant = message.participant === assistantParticipant;

      // Extract content
      const { text, images, hasUnsupportedMedia } = this.extractContent(message.content, message.participant);
      const hasImages = images.length > 0;
      const isEmpty = !text.trim() && !hasImages;

      // Handle unsupported media
      if (hasUnsupportedMedia) {
        if (this.config.unsupportedMedia === 'error') {
          throw new Error(`AnthropicXmlFormatter does not support media in message from ${message.participant}. Configure unsupportedMedia: 'strip' to ignore.`);
        } else if (this.config.warnOnStrip) {
          console.warn(`[AnthropicXmlFormatter] Stripped unsupported media from message`);
        }
      }

      // Check for tool results
      const hasToolResult = message.content.some(c => c.type === 'tool_result');

      // If message has images, flush and add as user turn
      if (hasImages && !isEmpty) {
        if (currentConversation.length > 0) {
          providerMessages.push({
            role: 'assistant',
            content: currentConversation.join(joiner),
          });
          currentConversation = [];
        }

        const userContent: unknown[] = [];
        if (text) {
          userContent.push({ type: 'text', text: `${message.participant}: ${text}` });
        }
        userContent.push(...images);

        providerMessages.push({ role: 'user', content: userContent });
        lastNonEmptyParticipant = message.participant;
        continue;
      }

      // Skip empty messages except last
      if (isEmpty && !isLastMessage) {
        continue;
      }

      // Check hasCacheMarker callback - flush content BEFORE this message with cache_control
      // (backward compatibility: callback marks WHERE cache boundary should be)
      if (hasCacheMarker && hasCacheMarker(message, i)) {
        if (currentConversation.length > 0 && promptCaching) {
          const content = currentConversation.join(joiner);
          const contentBlock: Record<string, unknown> = { type: 'text', text: content };
          contentBlock.cache_control = cacheControl;
          cacheMarkersApplied++;
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

      // Inject tools before this message if at injection point
      const shouldInjectHere = toolInjectionIndex > 0 ? i >= toolInjectionIndex : i === 0;
      if (hasToolsForConversation && !toolsInjected && shouldInjectHere) {
        currentConversation.push(toolsText);
        toolsInjected = true;
      }

      // Check bot continuation
      const isBotMessage = message.participant === assistantParticipant;
      const isContinuation = isBotMessage && lastNonEmptyParticipant === assistantParticipant && !hasToolResult;

      if (isContinuation && isLastMessage) {
        // Bot continuation - don't add prefix
        continue;
      } else if (isLastMessage && isEmpty) {
        // Completion target - prefix added below
      } else if (text) {
        currentConversation.push(`${message.participant}: ${text}${this.config.messageDelimiter}`);
        if (!hasToolResult) {
          lastNonEmptyParticipant = message.participant;
        }
      }

      // Check cacheBreakpoint - flush INCLUDING this message with cache_control
      // (explicit user control: this message is the last thing to be cached)
      if (message.cacheBreakpoint && promptCaching && currentConversation.length > 0) {
        const content = currentConversation.join(joiner);
        const contentBlock: Record<string, unknown> = { type: 'text', text: content };
        contentBlock.cache_control = cacheControl;
        cacheMarkersApplied++;
        providerMessages.push({
          role: 'assistant',
          content: [contentBlock],
        });
        currentConversation = [];
      }
    }

    // Determine turn prefix
    let turnPrefix: string;
    if (thinking?.enabled) {
      turnPrefix = `${assistantParticipant}: <thinking>`;
    } else {
      turnPrefix = `${assistantParticipant}:`;
    }

    // Flush remaining conversation
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

    // Ensure first message is user role (required by Claude Messages API,
    // strictly enforced by Bedrock and older Claude models)
    if (providerMessages.length > 0 && providerMessages[0]!.role !== 'user') {
      providerMessages.unshift({
        role: 'user',
        content: '[Start]',
      });
    }

    // Build stop sequences
    const stopSequences = this.buildStopSequences(messages, assistantParticipant, options);

    // Native tools if configured
    const nativeTools = this.config.toolMode === 'native' && tools?.length
      ? this.convertToNativeTools(tools)
      : undefined;

    return {
      messages: providerMessages,
      systemContent,
      assistantPrefill: typeof providerMessages[providerMessages.length - 1]?.content === 'string'
        ? providerMessages[providerMessages.length - 1]!.content as string
        : undefined,
      stopSequences,
      nativeTools,
      cacheMarkersApplied,
    };
  }

  formatToolResults(results: ToolResult[], options?: { thinking?: boolean }): string {
    let xml = formatToolResultsXml(results);
    if (options?.thinking) {
      xml += '\n<thinking>';
    }
    return xml;
  }

  // ==========================================================================
  // RESPONSE PARSING
  // ==========================================================================

  createStreamParser(): StreamParser {
    return new IncrementalXmlParser();
  }

  parseToolCalls(content: string): ToolCall[] {
    const result = parseToolCallsXml(content);
    return result?.calls ?? [];
  }

  hasToolUse(content: string): boolean {
    return /<(antml:)?function_calls>/.test(content);
  }

  parseContentBlocks(content: string): ContentBlock[] {
    const { blocks } = parseAccumulatedIntoBlocks(content);
    return blocks;
  }

  // ==========================================================================
  // PRIVATE HELPERS
  // ==========================================================================

  private extractContent(
    content: ContentBlock[],
    participant: string
  ): { text: string; images: unknown[]; hasUnsupportedMedia: boolean } {
    const parts: string[] = [];
    const images: unknown[] = [];
    let hasUnsupportedMedia = false;

    for (const block of content) {
      if (block.type === 'text') {
        parts.push(block.text);
      } else if (block.type === 'image') {
        if (block.source.type === 'base64') {
          images.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: block.source.mediaType,
              data: block.source.data,
            },
          });
        }
      } else if (block.type === 'tool_use') {
        parts.push(`${participant}>[${block.name}]: ${JSON.stringify(block.input)}`);
      } else if (block.type === 'tool_result') {
        const resultText = typeof block.content === 'string'
          ? block.content
          : JSON.stringify(block.content);
        parts.push(`${participant}<[tool_result]: ${resultText}`);
      } else if (block.type === 'document' || block.type === 'audio') {
        hasUnsupportedMedia = true;
      }
    }

    return { text: parts.join('\n'), images, hasUnsupportedMedia };
  }

  private formatToolDefinitionsXml(tools: ToolDefinition[]): string {
    const toolsForPrompt: ToolDefinitionForPrompt[] = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: Object.fromEntries(
        Object.entries(tool.inputSchema.properties).map(([name, schema]) => [
          name,
          {
            type: schema.type,
            description: schema.description,
            required: tool.inputSchema.required?.includes(name),
            enum: schema.enum,
          },
        ])
      ),
    }));

    return formatToolDefinitions(toolsForPrompt);
  }

  private formatToolsForInjection(tools: ToolDefinition[]): string {
    const toolsXml = this.formatToolDefinitionsXml(tools);

    // Assemble tags to avoid triggering stop sequences
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

    // Use option's maxParticipantsForStop, falling back to config
    const maxParticipants = options.maxParticipantsForStop ?? this.config.maxParticipantsForStop;

    // Collect unique participants (excluding assistant)
    const participants = new Set<string>();
    for (let i = messages.length - 1; i >= 0 && participants.size < maxParticipants; i--) {
      const message = messages[i];
      if (message && message.participant !== assistantName) {
        participants.add(message.participant);
      }
    }

    // Participant-based stops
    for (const participant of participants) {
      sequences.push(`\n${participant}:`);
    }

    // Tool-related stop
    sequences.push('</function_calls>');

    // Add any additional stop sequences from options
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
