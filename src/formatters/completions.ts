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
import { holdsContent, isRawItemCarrier } from '../utils/fidelity.js';

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
   * Add lowercased variants of participant stop sequences.
   * Default: false
   */
  caseInsensitiveStops?: boolean;

  /**
   * Whether to warn when images are stripped.
   * Default: true
   */
  warnOnImageStrip?: boolean;
}

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

export class CompletionsFormatter implements PrefillFormatter {
  /** buildMessages records every consumer message it doesn't carry verbatim (utils/fidelity.ts). */
  readonly reportsAlterations = true;
  readonly name = 'completions';
  readonly usesPrefill = true;
  /** This formatter does not encode provider-native tool definitions. */
  readonly supportsNativeTools = false;
  /** The prompt formatter does not inject XML tool definitions either. */
  readonly supportsXmlTools = false;

  private config: Required<Omit<CompletionsFormatterConfig, 'unsupportedMedia' | 'warnOnStrip'>> & {
    unsupportedMedia: 'strip';
    warnOnStrip: boolean;
  };

  constructor(config: CompletionsFormatterConfig = {}) {
    this.config = {
      eotToken: config.eotToken ?? '<|eot|>',
      nameFormat: config.nameFormat ?? '{name}: ',
      messageSeparator: config.messageSeparator ?? '\n\n',
      maxParticipantsForStop: config.maxParticipantsForStop ?? 10,
      caseInsensitiveStops: config.caseInsensitiveStops ?? false,
      warnOnImageStrip: config.warnOnImageStrip ?? true,
      // Base models take no images.
      unsupportedMedia: 'strip',
      warnOnStrip: config.warnOnStrip ?? true,
    };
  }

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

    if (contextPrefix) {
      const assistantPrefix = this.config.nameFormat.replace('{name}', () => assistantParticipant);
      parts.push(`${assistantPrefix}${contextPrefix}${this.config.eotToken}`);
    }

    for (let index = 0; index < messages.length; index++) {
      const message = messages[index]!;
      participants.add(message.participant);

      const { text, hadImages, leftOut } = this.extractTextContent(message.content);
      if (hadImages) {
        hasStrippedImages = true;
      }
      // Base models carry text only.
      if (leftOut) options.fidelity?.alter(index);

      if (!text.trim()) {
        if (holdsContent(message.content)) options.fidelity?.alter(index);
        continue;
      }

      const prefix = this.config.nameFormat.replace('{name}', () => message.participant);
      const eot = this.config.eotToken;
      parts.push(`${prefix}${text}${eot}`);
    }

    if (hasStrippedImages && this.config.warnOnImageStrip) {
      console.warn('[CompletionsFormatter] Images were stripped from context (not supported in completions mode)');
    }

    const assistantPrefix = this.config.nameFormat.replace('{name}', () => assistantParticipant);
    parts.push(assistantPrefix.trimEnd());

    const prompt = parts.join(this.config.messageSeparator);

    const stopSequences = this.buildStopSequences(
      participants,
      assistantParticipant,
      maxParticipantsForStop,
      additionalStopSequences
    );

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
    const parts = results.map(r => {
      const content = typeof r.content === 'string' ? r.content : JSON.stringify(r.content);
      return `[Tool Result: ${content}]`;
    });
    return parts.join('\n');
  }

  createStreamParser(): StreamParser {
    return new CompletionsStreamParser();
  }

  parseToolCalls(content: string): ToolCall[] {
    // Base models have no structured tool output.
    return [];
  }

  hasToolUse(content: string): boolean {
    return false;
  }

  parseContentBlocks(content: string, _tools?: ToolDefinition[], context?: ContentParseContext): ContentBlock[] {
    const atResponseStart = !context || !/\S/.test(context.visibleText.slice(0, context.offset));
    const trimmed = atResponseStart ? content.replace(/^\s+/, '') : content;

    if (!trimmed) {
      return [];
    }

    return [{ type: 'text', text: trimmed }];
  }

  private extractTextContent(content: ContentBlock[]): { text: string; hadImages: boolean; leftOut: boolean } {
    const textParts: string[] = [];
    let hadImages = false;
    let leftOut = false;

    for (const block of content) {
      if (block.type === 'text') {
        if (isRawItemCarrier(block)) {
          leftOut = true;
          continue;
        }
        textParts.push(block.text);
      } else {
        if (block.type === 'image') hadImages = true;
        leftOut = true;
      }
    }

    return {
      text: textParts.join('\n'),
      hadImages,
      leftOut,
    };
  }

  private buildStopSequences(
    participants: Set<string>,
    assistantParticipant: string,
    maxParticipants: number,
    additionalStopSequences?: string[]
  ): string[] {
    const stops: string[] = [];

    let count = 0;
    for (const participant of participants) {
      if (participant === assistantParticipant) continue;
      if (count >= maxParticipants) break;

      const prefix = this.config.nameFormat.replace('{name}', () => participant).trimEnd();
      stops.push(`\n\n${prefix}`);
      stops.push(`\n${prefix}`);

      if (this.config.caseInsensitiveStops) {
        const lower = this.config.nameFormat.replace('{name}', () => participant.toLowerCase()).trimEnd();
        if (lower !== prefix) {
          stops.push(`\n\n${lower}`);
          stops.push(`\n${lower}`);
        }
      }

      count++;
    }

    if (this.config.eotToken) {
      stops.push(this.config.eotToken);
    }

    if (additionalStopSequences?.length) {
      stops.push(...additionalStopSequences);
    }

    return stops;
  }
}
