/**
 * Pseudo-Prefill Formatter
 *
 * Recovers prefill-like behavior for models that don't support native
 * assistant message prefill (e.g., Sonnet 4.6, Opus 4.6). Uses a CLI
 * simulation framing trick:
 *
 *   System: "The assistant is in CLI simulation mode..."
 *   User: "<cmd>cut -c 1-N < conversation.txt</cmd>"
 *   Assistant: <the full conversation log, N chars>
 *   User: "<cmd>cat conversation.txt</cmd>"  (or cut -c N+1-)
 *   <model continues from where the cut output ended>
 *
 * Two continuation modes:
 * - 'cat': model repeats full file then continues (reliable, caller strips log)
 * - 'tail-cut': model outputs only new content (efficient, needs simulated stops)
 *
 * IMPORTANT: API-level stop sequences should NOT be used with pseudo-prefill.
 * In 'cat' mode, the model repeats participant names from the log which would
 * trigger stops prematurely. The caller should handle stop sequences post-facto
 * after stripping the repeated log. The stop sequences returned in BuildResult
 * are for the caller's post-facto detection, not for the API.
 *
 * Uses PassthroughParser and native API tools (same as NativeFormatter).
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

// ============================================================================
// Configuration
// ============================================================================

export interface PseudoPrefillFormatterConfig extends FormatterConfig {
  /**
   * Filename used in the CLI simulation commands.
   * Default: 'conversation.txt'
   */
  filename?: string;

  /**
   * Continuation mode:
   * - 'cat': `cat filename` — model repeats full file then continues.
   *   More reliable but uses more output tokens. Caller must strip the
   *   repeated conversation log from the response.
   * - 'tail-cut': `cut -c N+1- < filename` — model outputs only new content.
   *   More efficient but may be less reliable. Caller needs simulated stop
   *   sequences (only after \n\n, not at position 0).
   * Default: 'cat'
   */
  continuationMode?: 'cat' | 'tail-cut';

  /**
   * Maximum participants to include in stop sequences.
   * Default: 10
   */
  maxParticipantsForStop?: number;

  /**
   * Message delimiter between participant entries.
   * Default: '' (none, just newlines)
   */
  messageDelimiter?: string;
}

// ============================================================================
// Pass-through Stream Parser (same as NativeFormatter)
// ============================================================================

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
    // No special reset needed for pass-through mode
  }
}

// ============================================================================
// Pseudo-Prefill Formatter
// ============================================================================

const CLI_DIRECTIVE = 'The assistant is in CLI simulation mode, and responds to the user\'s CLI commands only with the output of the command.';

export class PseudoPrefillFormatter implements PrefillFormatter {
  readonly name = 'pseudo-prefill';
  readonly usesPrefill = false;

  private config: Required<PseudoPrefillFormatterConfig>;

  constructor(config: PseudoPrefillFormatterConfig = {}) {
    this.config = {
      filename: config.filename ?? 'conversation.txt',
      continuationMode: config.continuationMode ?? 'cat',
      maxParticipantsForStop: config.maxParticipantsForStop ?? 10,
      messageDelimiter: config.messageDelimiter ?? '',
      unsupportedMedia: config.unsupportedMedia ?? 'strip',
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
      systemPrompt,
      promptCaching = false,
      cacheTtl,
      contextPrefix,
      hasCacheMarker,
      additionalStopSequences,
    } = options;

    // Build cache_control object
    const cacheControl: Record<string, unknown> = { type: 'ephemeral' };
    if (cacheTtl) {
      cacheControl.ttl = cacheTtl;
    }

    // 1. Build system content: user's system prompt + CLI directive
    let systemText = typeof systemPrompt === 'string' ? systemPrompt : '';
    if (Array.isArray(systemPrompt)) {
      systemText = systemPrompt
        .filter((b): b is ContentBlock & { type: 'text' } => b.type === 'text')
        .map(b => b.text)
        .join('\n');
    }
    systemText = systemText
      ? `${systemText}\n\n${CLI_DIRECTIVE}`
      : CLI_DIRECTIVE;

    let systemContent: unknown;
    const systemBlock: Record<string, unknown> = { type: 'text', text: systemText };
    if (promptCaching) {
      systemBlock.cache_control = cacheControl;
    }
    systemContent = [systemBlock];

    // 2. Build the conversation log, handling images like AnthropicXmlFormatter:
    //    When a message has images, flush the accumulated log as an assistant turn,
    //    add the image as a user turn, then continue accumulating.
    let currentLog: string[] = [];
    let cacheMarkersApplied = promptCaching ? 1 : 0; // system block
    const joiner = this.config.messageDelimiter ? '' : '\n';
    const filename = this.config.filename;

    // Track image flushes — these become user turns between cut result and cat
    const imageTurns: ProviderMessage[] = [];
    const logSegments: { text: string; cacheBreakpoint?: boolean }[] = [];

    // Context prefix (simulacrum seeding) goes first in the log
    if (contextPrefix) {
      currentLog.push(contextPrefix);
    }

    // Serialize messages
    let lastParticipant = '';
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      if (!message) continue;

      const { text, images, hasUnsupportedMedia } = this.extractContent(message.content, message.participant);
      const hasImages = images.length > 0;
      const isEmpty = !text.trim() && !hasImages;

      if (hasUnsupportedMedia) {
        if (this.config.unsupportedMedia === 'error') {
          throw new Error(`PseudoPrefillFormatter does not support media in message from ${message.participant}. Configure unsupportedMedia: 'strip' to ignore.`);
        } else if (this.config.warnOnStrip) {
          console.warn(`[PseudoPrefillFormatter] Stripped unsupported media from message`);
        }
      }

      if (isEmpty) continue;

      // If message has images, flush current log and add image as user turn
      if (hasImages) {
        if (currentLog.length > 0) {
          logSegments.push({ text: currentLog.join(joiner) });
          currentLog = [];
        }

        const userContent: unknown[] = [];
        if (text) {
          userContent.push({ type: 'text', text: `${message.participant}: ${text}` });
        }
        userContent.push(...images);
        imageTurns.push({ role: 'user', content: userContent });
        continue;
      }

      // Check cache breakpoint — flush segment WITH this message
      if (message.cacheBreakpoint && promptCaching) {
        currentLog.push(`${message.participant}: ${text}${this.config.messageDelimiter}`);
        logSegments.push({ text: currentLog.join(joiner), cacheBreakpoint: true });
        currentLog = [];
        continue;
      }

      // hasCacheMarker: cache boundary BEFORE this message
      if (hasCacheMarker && hasCacheMarker(message, i) && promptCaching && currentLog.length > 0) {
        logSegments.push({ text: currentLog.join(joiner), cacheBreakpoint: true });
        currentLog = [];
      }

      // Same participant as last message — merge without repeating name prefix
      if (message.participant === lastParticipant && lastParticipant !== '') {
        const lastEntry = currentLog[currentLog.length - 1];
        if (lastEntry) {
          currentLog[currentLog.length - 1] = lastEntry.trimEnd() + ' ' + text.trimStart() + '\n\n';
        } else {
          currentLog.push(`${message.participant}: ${text}${this.config.messageDelimiter}`);
        }
      } else {
        currentLog.push(`${message.participant}: ${text}${this.config.messageDelimiter}`);
      }
      lastParticipant = message.participant;
    }

    // Add the assistant participant turn prefix at the end
    currentLog.push(`${assistantParticipant}:`);
    logSegments.push({ text: currentLog.join(joiner) });

    // Combine all log segments into the full conversation log for the cut char count
    const fullLog = logSegments.map(s => s.text).join(joiner);
    const charCount = fullLog.length;

    // 3. Build the message structure
    const providerMessages: ProviderMessage[] = [];

    // User: cut command (request first N chars, wrapped in <cmd> tags)
    providerMessages.push({
      role: 'user',
      content: `<cmd>cut -c 1-${charCount} < ${filename}</cmd>`,
    });

    // Assistant: the conversation log
    // If there are multiple segments with cache breakpoints, split into
    // multiple assistant content blocks. Otherwise, single block.
    if (logSegments.length === 1 || !promptCaching) {
      const logBlock: Record<string, unknown> = { type: 'text', text: fullLog };
      if (promptCaching) {
        logBlock.cache_control = cacheControl;
        cacheMarkersApplied++;
      }
      providerMessages.push({
        role: 'assistant',
        content: [logBlock],
      });
    } else {
      // Multiple segments with cache breakpoints
      const contentBlocks: Record<string, unknown>[] = [];
      for (const segment of logSegments) {
        const block: Record<string, unknown> = { type: 'text', text: segment.text };
        if (segment.cacheBreakpoint) {
          block.cache_control = cacheControl;
          cacheMarkersApplied++;
        }
        contentBlocks.push(block);
      }
      // Ensure last block is cached too
      const lastBlock = contentBlocks[contentBlocks.length - 1]!;
      if (!lastBlock.cache_control && promptCaching) {
        lastBlock.cache_control = cacheControl;
        cacheMarkersApplied++;
      }
      providerMessages.push({
        role: 'assistant',
        content: contentBlocks,
      });
    }

    // Insert image turns between the assistant log and the cat command
    // These are user turns containing image content
    for (const imageTurn of imageTurns) {
      // Need a brief assistant acknowledgment to maintain alternating turns
      providerMessages.push({
        role: 'assistant',
        content: '[image received]',
      });
      providerMessages.push(imageTurn);
    }

    // User: continuation command
    // - 'cat': model repeats full file (caller strips repeated log from response)
    // - 'tail-cut': model outputs only chars after the cut point
    const continuationCmd = this.config.continuationMode === 'tail-cut'
      ? `<cmd>cut -c ${charCount + 1}- < ${filename}</cmd>`
      : `<cmd>cat ${filename}</cmd>`;
    providerMessages.push({
      role: 'user',
      content: continuationCmd,
    });

    // 4. Build stop sequences from participant names
    // NOTE: For pseudo-prefill, API-level stop sequences are problematic because
    // in 'cat' mode the model repeats the conversation log (which contains
    // participant names that would trigger stops prematurely).
    // The caller should handle stop sequences post-facto after stripping the log.
    // We still return them here for the caller to use in post-facto detection.
    const stopSequences = this.buildStopSequences(messages, assistantParticipant, options);

    // 5. Native tools
    const nativeTools = tools?.length ? this.convertToNativeTools(tools) : undefined;

    return {
      messages: providerMessages,
      systemContent,
      // No assistantPrefill — model generates a new assistant turn after continuation command
      assistantPrefill: undefined,
      stopSequences,
      nativeTools,
      cacheMarkersApplied,
      // Expose log and mode so callers can strip the repeated log (cat mode)
      // and apply post-facto stop sequences appropriately
      metadata: {
        conversationLog: fullLog,
        conversationLogLength: charCount,
        continuationMode: this.config.continuationMode,
        assistantParticipant: assistantParticipant,
      },
    };
  }

  formatToolResults(results: ToolResult[]): string {
    // Native mode uses API tool_result blocks
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

  parseToolCalls(_content: string): ToolCall[] {
    // Native mode gets tool calls from API response
    return [];
  }

  hasToolUse(_content: string): boolean {
    // Native mode determines tool use from API stop_reason
    return false;
  }

  parseContentBlocks(content: string): ContentBlock[] {
    if (!content.trim()) {
      return [];
    }
    return [{ type: 'text', text: content }];
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

  private buildStopSequences(
    messages: NormalizedMessage[],
    assistantName: string,
    options: BuildOptions
  ): string[] {
    const sequences: string[] = [];
    const maxParticipants = options.maxParticipantsForStop ?? this.config.maxParticipantsForStop;

    // Collect unique participants (excluding assistant) from recent messages
    const participants = new Set<string>();
    for (let i = messages.length - 1; i >= 0 && participants.size < maxParticipants; i--) {
      const message = messages[i];
      if (message && message.participant !== assistantName) {
        participants.add(message.participant);
      }
    }

    // Participant-based stops (same format as AnthropicXmlFormatter)
    for (const participant of participants) {
      sequences.push(`\n${participant}:`);
    }

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
