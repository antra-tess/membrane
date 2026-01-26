/**
 * Incremental XML parser for streaming
 *
 * Tracks nesting depth of XML blocks as tokens arrive, enabling:
 * - False-positive stop sequence detection
 * - Structured block events for UI
 * - Enriched chunk metadata for TTS/display filtering
 */

import type {
  BlockEvent,
  ChunkMeta,
  MembraneBlock,
  MembraneBlockType,
} from '../types/streaming.js';

// ============================================================================
// Result Types
// ============================================================================

export interface ProcessChunkResult {
  content: Array<{ text: string; meta: ChunkMeta }>;
  blockEvents: BlockEvent[];
}

// ============================================================================
// Parser State
// ============================================================================

interface ParserState {
  functionCallsDepth: number;
  functionResultsDepth: number;
  thinkingDepth: number;
  accumulated: string;
  lastScanPos: number;
  blockIndex: number;
  currentBlockStarted: boolean;
  currentBlockContent: string;
  currentBlockType: MembraneBlockType;
  tagBuffer: string;
  toolCallState: {
    inInvoke: boolean;
    currentToolName: string;
    currentToolId: string;
    inParameter: boolean;
    currentParamName: string;
    paramContent: string;
    allParams: Record<string, string>;
  };
}

function createInitialState(): ParserState {
  return {
    functionCallsDepth: 0,
    functionResultsDepth: 0,
    thinkingDepth: 0,
    accumulated: '',
    lastScanPos: 0,
    blockIndex: 0,
    currentBlockStarted: false,
    currentBlockContent: '',
    currentBlockType: 'text',
    tagBuffer: '',
    toolCallState: {
      inInvoke: false,
      currentToolName: '',
      currentToolId: '',
      inParameter: false,
      currentParamName: '',
      paramContent: '',
      allParams: {},
    },
  };
}

// For finding all membrane tags in one pass
const ALL_TAGS = /<\/?(?:antml:)?(?:function_calls|function_results|thinking)>/g;

// For matching complete membrane tags  
const COMPLETE_MEMBRANE_TAG = /^<\/?(?:antml:)?(?:function_calls|function_results|thinking|invoke|parameter)(?:\s[^>]*)?>$/;

// Known membrane tag prefixes
const MEMBRANE_TAG_PREFIXES = [
  '<thinking', '<\/thinking>',
  '<function_calls', '<\/function_calls>',
  '<function_results', '<\/function_results>',
  '<invoke', '<\/invoke>',
  '<parameter', '<\/parameter>',
  '<function_calls', '<\/antml:function_calls>',
  '<invoke', '<\/antml:invoke>',
];

// ============================================================================
// Incremental XML Parser
// ============================================================================

export class IncrementalXmlParser {
  private state: ParserState;

  constructor() {
    this.state = createInitialState();
  }

  push(chunk: string): BlockEvent[] {
    this.state.accumulated += chunk;
    return this.scan();
  }

  isInsideBlock(): boolean {
    return (
      this.state.functionCallsDepth > 0 ||
      this.state.functionResultsDepth > 0 ||
      this.state.thinkingDepth > 0
    );
  }

  isInsideFunctionResults(): boolean {
    return this.state.functionResultsDepth > 0;
  }

  isInsideFunctionCalls(): boolean {
    return this.state.functionCallsDepth > 0;
  }

  getContext(): string {
    const parts: string[] = [];
    if (this.state.functionCallsDepth > 0) {
      parts.push('function_calls(' + this.state.functionCallsDepth + ')');
    }
    if (this.state.functionResultsDepth > 0) {
      parts.push('function_results(' + this.state.functionResultsDepth + ')');
    }
    if (this.state.thinkingDepth > 0) {
      parts.push('thinking(' + this.state.thinkingDepth + ')');
    }
    return parts.length > 0 ? parts.join(' > ') : 'none';
  }

  getAccumulated(): string {
    return this.state.accumulated;
  }

  getDepths(): { functionCalls: number; functionResults: number; thinking: number } {
    return {
      functionCalls: this.state.functionCallsDepth,
      functionResults: this.state.functionResultsDepth,
      thinking: this.state.thinkingDepth,
    };
  }

  reset(): void {
    this.state = createInitialState();
  }

  finish(): BlockEvent[] {
    return this.flush().blockEvents;
  }

  // ============================================================================
  // Enriched Streaming API
  // ============================================================================

  processChunk(chunk: string): ProcessChunkResult {
    const content: Array<{ text: string; meta: ChunkMeta }> = [];
    const blockEvents: BlockEvent[] = [];

    // Also update accumulated and scan for depth tracking
    this.state.accumulated += chunk;
    this.scanForDepth();

    let pos = 0;
    while (pos < chunk.length) {
      if (this.state.tagBuffer) {
        const char = chunk[pos];
        this.state.tagBuffer += char;
        pos++;

        if (this.isCompleteMembraneTag(this.state.tagBuffer)) {
          const events = this.handleMembraneTag(this.state.tagBuffer);
          blockEvents.push(...events);
          this.state.tagBuffer = '';
        } else if (this.cantBeMembraneTag(this.state.tagBuffer)) {
          this.ensureBlockStarted(blockEvents);
          content.push({
            text: this.state.tagBuffer,
            meta: this.getCurrentMeta()
          });
          this.state.currentBlockContent += this.state.tagBuffer;
          this.state.tagBuffer = '';
        }
      } else {
        const nextLt = chunk.indexOf('<', pos);
        if (nextLt === -1) {
          const text = chunk.slice(pos);
          if (text) {
            this.ensureBlockStarted(blockEvents);
            content.push({ text, meta: this.getCurrentMeta() });
            this.state.currentBlockContent += text;
          }
          break;
        } else {
          if (nextLt > pos) {
            const text = chunk.slice(pos, nextLt);
            this.ensureBlockStarted(blockEvents);
            content.push({ text, meta: this.getCurrentMeta() });
            this.state.currentBlockContent += text;
          }
          this.state.tagBuffer = '<';
          pos = nextLt + 1;
        }
      }
    }

    return { content, blockEvents };
  }

  flush(): ProcessChunkResult {
    const content: Array<{ text: string; meta: ChunkMeta }> = [];
    const blockEvents: BlockEvent[] = [];

    if (this.state.tagBuffer) {
      this.ensureBlockStarted(blockEvents);
      content.push({ text: this.state.tagBuffer, meta: this.getCurrentMeta() });
      this.state.currentBlockContent += this.state.tagBuffer;
      this.state.tagBuffer = '';
    }

    if (this.state.currentBlockStarted) {
      blockEvents.push(this.makeBlockComplete());
    }

    return { content, blockEvents };
  }

  getCurrentBlockType(): MembraneBlockType {
    if (this.state.thinkingDepth > 0) return 'thinking';
    if (this.state.functionCallsDepth > 0) return 'tool_call';
    if (this.state.functionResultsDepth > 0) return 'tool_result';
    return 'text';
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private isCompleteMembraneTag(buffer: string): boolean {
    if (!buffer.endsWith('>')) return false;
    return COMPLETE_MEMBRANE_TAG.test(buffer);
  }

  private cantBeMembraneTag(buffer: string): boolean {
    if (buffer.endsWith('>')) {
      return !this.isCompleteMembraneTag(buffer);
    }
    for (const prefix of MEMBRANE_TAG_PREFIXES) {
      if (prefix.startsWith(buffer) || buffer.startsWith(prefix.slice(0, buffer.length))) {
        return false;
      }
    }
    return true;
  }

  private handleMembraneTag(tag: string): BlockEvent[] {
    const events: BlockEvent[] = [];
    const isClosing = tag.startsWith('</');

    if (tag.includes('thinking')) {
      if (!isClosing) {
        if (this.state.currentBlockStarted) {
          events.push(this.makeBlockComplete());
        }
        this.state.thinkingDepth++;
        this.state.currentBlockType = 'thinking';
        events.push(this.makeBlockStart('thinking'));
      } else {
        events.push(this.makeBlockComplete());
        this.state.thinkingDepth--;
        this.state.currentBlockType = this.getCurrentBlockType();
      }
    } else if (tag.includes('function_calls')) {
      if (!isClosing) {
        if (this.state.currentBlockStarted) {
          events.push(this.makeBlockComplete());
        }
        this.state.functionCallsDepth++;
        this.state.currentBlockType = 'tool_call';
        events.push(this.makeBlockStart('tool_call'));
      } else {
        events.push(this.makeBlockComplete());
        this.state.functionCallsDepth--;
        this.state.currentBlockType = this.getCurrentBlockType();
      }
    } else if (tag.includes('function_results')) {
      if (!isClosing) {
        if (this.state.currentBlockStarted) {
          events.push(this.makeBlockComplete());
        }
        this.state.functionResultsDepth++;
        this.state.currentBlockType = 'tool_result';
        events.push(this.makeBlockStart('tool_result'));
      } else {
        events.push(this.makeBlockComplete());
        this.state.functionResultsDepth--;
        this.state.currentBlockType = this.getCurrentBlockType();
      }
    }

    return events;
  }

  private ensureBlockStarted(events: BlockEvent[]): void {
    if (!this.state.currentBlockStarted) {
      events.push(this.makeBlockStart(this.state.currentBlockType));
    }
  }

  private makeBlockStart(type: MembraneBlockType): BlockEvent {
    this.state.currentBlockStarted = true;
    this.state.currentBlockContent = '';
    this.state.currentBlockType = type;
    return {
      event: 'block_start',
      index: this.state.blockIndex,
      block: { type }
    };
  }

  private makeBlockComplete(): BlockEvent {
    const block: MembraneBlock = {
      type: this.state.currentBlockType,
      content: this.state.currentBlockContent,
    };

    const event: BlockEvent = {
      event: 'block_complete',
      index: this.state.blockIndex,
      block
    };

    this.state.blockIndex++;
    this.state.currentBlockStarted = false;
    this.state.currentBlockContent = '';

    return event;
  }

  private getCurrentMeta(): ChunkMeta {
    const type = this.getCurrentBlockType();
    return {
      type,
      visible: type === 'text',
      blockIndex: this.state.blockIndex,
      depth: Math.max(
        this.state.functionCallsDepth,
        this.state.functionResultsDepth
      ),
    };
  }

  private scanForDepth(): void {
    const text = this.state.accumulated;
    const lookbackChars = 30;
    const scanStart = Math.max(0, this.state.lastScanPos - lookbackChars);
    const textToScan = text.slice(scanStart);

    ALL_TAGS.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = ALL_TAGS.exec(textToScan)) !== null) {
      const absolutePos = scanStart + match.index;
      if (absolutePos < this.state.lastScanPos) continue;

      const tag = match[0];
      const isClosing = tag.startsWith('</');

      if (tag.includes('function_calls')) {
        if (isClosing) {
          this.state.functionCallsDepth = Math.max(0, this.state.functionCallsDepth - 1);
        } else {
          this.state.functionCallsDepth++;
        }
      } else if (tag.includes('function_results')) {
        if (isClosing) {
          this.state.functionResultsDepth = Math.max(0, this.state.functionResultsDepth - 1);
        } else {
          this.state.functionResultsDepth++;
        }
      } else if (tag.includes('thinking')) {
        if (isClosing) {
          this.state.thinkingDepth = Math.max(0, this.state.thinkingDepth - 1);
        } else {
          this.state.thinkingDepth++;
        }
      }
    }

    const partialTagLen = this.findPartialTagAtEnd(text);
    this.state.lastScanPos = text.length - partialTagLen;
  }

  private scan(): BlockEvent[] {
    this.scanForDepth();
    return [];
  }

  private findPartialTagAtEnd(text: string): number {
    const tail = text.slice(-30);
    const lastLt = tail.lastIndexOf('<');
    if (lastLt === -1) return 0;
    const afterLt = tail.slice(lastLt);
    if (afterLt.includes('>')) return 0;
    return afterLt.length;
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

export function hasUnclosedXmlBlock(text: string): boolean {
  const parser = new IncrementalXmlParser();
  parser.push(text);
  return parser.isInsideBlock();
}

export function countTags(
  text: string,
  openPattern: RegExp,
  closePattern: RegExp
): { open: number; close: number; depth: number } {
  openPattern.lastIndex = 0;
  closePattern.lastIndex = 0;
  const openMatches = text.match(openPattern) || [];
  const closeMatches = text.match(closePattern) || [];
  return {
    open: openMatches.length,
    close: closeMatches.length,
    depth: openMatches.length - closeMatches.length,
  };
}
