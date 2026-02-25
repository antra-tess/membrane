/**
 * Completions Formatter
 *
 * Formatter for base/completion models that use single-prompt input.
 * Serializes conversations to "Participant: content<eot>" format.
 *
 * Key features:
 * - Converts multi-turn conversations to single prompt string
 * - Adds configurable end-of-turn tokens
 * - Generates stop sequences from participant names
 * - Strips images (not supported in completion models)
 * - No XML block parsing (passthrough mode)
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

export interface CompletionsFormatterConfig extends FormatterConfig {
  /**
   * End-of-turn token to append after each message.
   * Set to empty string to disable.
   * Default: '<|eot|>'
   */
  eotToken?: string;

  /**
   * Format for participant name prefix.
   * Use {name} as placeholder.
   * Default: '{name}: '
   */
  nameFormat?: string;

  /**
   * Message separator between turns.
   * Default: '\n\n'
   */
  messageSeparator?: string;

  /**
   * Maximum participants to include in stop sequences.
   * Default: 10
   */
  maxParticipantsForStop?: number;

  /**
   * Whether to warn when images are stripped.
   * Default: true
   */
  warnOnImageStrip?: boolean;
}

// ============================================================================
// Passthrough Stream Parser (same as NativeFormatter)
// ============================================================================

/**
 * Simple pass-through parser for base models.
 * No XML tracking - just accumulates content.
 */
class CompletionsStreamParser implements StreamParser {
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
    return false;
  }

  getDepths(): { functionCalls: number; functionResults: number; thinking: number } {
    return { functionCalls: 0, functionResults: 0, thinking: 0 };
  }

  resetForNewIteration(): void {
    // No special reset needed
  }
}

// ============================================================================
// Completions Formatter
// ============================================================================

export class CompletionsFormatter implements PrefillFormatter {
  readonly name = 'completions';
  readonly usesPrefill = true;

  private config: Required<Omit<CompletionsFormatterConfig, 'unsupportedMedia' | 'warnOnStrip'>> & {
    unsupportedMedia: 'strip'; // Always strip for completions
    warnOnStrip: boolean;
  };

  constructor(config: CompletionsFormatterConfig = {}) {
    this.config = {
      eotToken: config.eotToken ?? '<|eot|>',
      nameFormat: config.nameFormat ?? '{name}: ',
      messageSeparator: config.messageSeparator ?? '\n\n',
      maxParticipantsForStop: config.maxParticipantsForStop ?? 10,
      warnOnImageStrip: config.warnOnImageStrip ?? true,
      // Completions models don't support images - always strip
      unsupportedMedia: 'strip',
      warnOnStrip: config.warnOnStrip ?? true,
    };
  }

  // ==========================================================================
  // REQUEST BUILDING
  // ==========================================================================

  buildMessages(messages: NormalizedMessage[], options: BuildOptions): BuildResult {
    const {
      assistantParticipant,
      systemPrompt,
      additionalStopSequences,
      maxParticipantsForStop = this.config.maxParticipantsForStop,
      contextPrefix,
    } = options;

    const parts: string[] = [];
    const participants = new Set<string>();
    let hasStrippedImages = false;

    // Add system prompt as first part if present
    if (systemPrompt) {
      const systemText = typeof systemPrompt === 'string'
        ? systemPrompt
        : systemPrompt
            .filter((b): b is ContentBlock & { type: 'text' } => b.type === 'text')
            .map(b => b.text)
            .join('\n');

      if (systemText) {
        parts.push(systemText);
      }
    }

    // Add context prefix after system prompt (for simulacrum seeding)
    if (contextPrefix) {
      const assistantPrefix = this.config.nameFormat.replace('{name}', assistantParticipant);
      parts.push(`${assistantPrefix}${contextPrefix}${this.config.eotToken}`);
    }

    // Serialize each message
    for (const message of messages) {
      participants.add(message.participant);

      const { text, hadImages } = this.extractTextContent(message.content);
      if (hadImages) {
        hasStrippedImages = true;
      }

      // Skip empty messages (except if it's the final completion target)
      if (!text.trim()) {
        continue;
      }

      // Format: "Participant: content<eot>"
      const prefix = this.config.nameFormat.replace('{name}', message.participant);
      const eot = this.config.eotToken;
      parts.push(`${prefix}${text}${eot}`);
    }

    // Warn about stripped images
    if (hasStrippedImages && this.config.warnOnImageStrip) {
      console.warn('[CompletionsFormatter] Images were stripped from context (not supported in completions mode)');
    }

    // Add final assistant prefix (no EOT - model generates this)
    const assistantPrefix = this.config.nameFormat.replace('{name}', assistantParticipant);
    parts.push(assistantPrefix.trimEnd()); // Remove trailing space for cleaner completion

    // Join all parts into single prompt
    const prompt = parts.join(this.config.messageSeparator);

    // Build stop sequences from participants
    const stopSequences = this.buildStopSequences(
      participants,
      assistantParticipant,
      maxParticipantsForStop,
      additionalStopSequences
    );

    // Return as single assistant message with prompt as content
    // The provider adapter will extract this as the prompt
    const providerMessages: ProviderMessage[] = [
      { role: 'assistant', content: prompt },
    ];

    return {
      messages: providerMessages,
      assistantPrefill: prompt,
      stopSequences,
    };
  }

  formatToolResults(results: ToolResult[], options?: { thinking?: boolean }): string {
    // Completions mode typically doesn't support tools
    // But format them as simple text if needed
    const parts = results.map(r => {
      const content = typeof r.content === 'string' ? r.content : JSON.stringify(r.content);
      return `[Tool Result: ${content}]`;
    });
    return parts.join('\n');
  }

  // ==========================================================================
  // RESPONSE PARSING
  // ==========================================================================

  createStreamParser(): StreamParser {
    return new CompletionsStreamParser();
  }

  parseToolCalls(content: string): ToolCall[] {
    // Base models don't have structured tool output
    return [];
  }

  hasToolUse(content: string): boolean {
    // Base models determine completion via stop sequences
    return false;
  }

  parseContentBlocks(content: string): ContentBlock[] {
    // Trim leading whitespace (model often starts with space after prefix)
    const trimmed = content.replace(/^\s+/, '');

    if (!trimmed) {
      return [];
    }

    return [{ type: 'text', text: trimmed }];
  }

  // ==========================================================================
  // PRIVATE HELPERS
  // ==========================================================================

  private extractTextContent(content: ContentBlock[]): { text: string; hadImages: boolean } {
    const textParts: string[] = [];
    let hadImages = false;

    for (const block of content) {
      if (block.type === 'text') {
        textParts.push(block.text);
      } else if (block.type === 'image') {
        hadImages = true;
      }
      // Skip tool_use, tool_result, thinking blocks for base models
    }

    return {
      text: textParts.join('\n'),
      hadImages,
    };
  }

  private buildStopSequences(
    participants: Set<string>,
    assistantParticipant: string,
    maxParticipants: number,
    additionalStopSequences?: string[]
  ): string[] {
    const stops: string[] = [];

    // Get recent participants (excluding assistant)
    let count = 0;
    for (const participant of participants) {
      if (participant === assistantParticipant) continue;
      if (count >= maxParticipants) break;

      // Add both "\n\nName:" and "\nName:" variants
      const prefix = this.config.nameFormat.replace('{name}', participant).trimEnd();
      stops.push(`\n\n${prefix}`);
      stops.push(`\n${prefix}`);
      count++;
    }

    // Add EOT token as stop sequence if configured
    if (this.config.eotToken) {
      stops.push(this.config.eotToken);
    }

    // Add any additional stop sequences
    if (additionalStopSequences?.length) {
      stops.push(...additionalStopSequences);
    }

    return stops;
  }
}
