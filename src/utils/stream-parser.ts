/**
 * Incremental XML parser for streaming
 *
 * Tracks nesting depth of XML blocks as tokens arrive, enabling:
 * - False-positive stop sequence detection
 * - Structured block events for UI
 */

import type { ContentBlock } from '../types/content.js';

// ============================================================================
// Block Events
// ============================================================================

export type BlockDelta =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_input'; partialJson: string };

export type BlockEvent =
  | { event: 'block_start'; index: number; block: Partial<ContentBlock> }
  | { event: 'block_delta'; index: number; delta: BlockDelta }
  | { event: 'block_complete'; index: number; block: ContentBlock };

// ============================================================================
// Parser State
// ============================================================================

interface ParserState {
  // Nesting depth for tracked XML blocks
  functionCallsDepth: number;
  functionResultsDepth: number;
  thinkingDepth: number;

  // Accumulated text (full stream so far)
  accumulated: string;

  // Position of last scan (for incremental scanning)
  lastScanPos: number;

  // Current block index for events
  blockIndex: number;
}

function createInitialState(): ParserState {
  return {
    functionCallsDepth: 0,
    functionResultsDepth: 0,
    thinkingDepth: 0,
    accumulated: '',
    lastScanPos: 0,
    blockIndex: 0,
  };
}

// ============================================================================
// Tag Patterns
// ============================================================================

// Opening tags (with optional antml: prefix)
const FUNCTION_CALLS_OPEN = /<(antml:)?function_calls>/g;
const FUNCTION_CALLS_CLOSE = /<\/(antml:)?function_calls>/g;
const FUNCTION_RESULTS_OPEN = /<(antml:)?function_results>/g;
const FUNCTION_RESULTS_CLOSE = /<\/(antml:)?function_results>/g;
const THINKING_OPEN = /<thinking>/g;
const THINKING_CLOSE = /<\/thinking>/g;

// For finding all tags in one pass
const ALL_TAGS = /<\/?(?:antml:)?(?:function_calls|function_results|thinking)>/g;

// ============================================================================
// Incremental XML Parser
// ============================================================================

export class IncrementalXmlParser {
  private state: ParserState;

  constructor() {
    this.state = createInitialState();
  }

  /**
   * Feed a chunk of text to the parser.
   * Returns any block events detected.
   */
  push(chunk: string): BlockEvent[] {
    this.state.accumulated += chunk;
    return this.scan();
  }

  /**
   * Check if we're currently inside an unclosed XML block.
   * Used for false-positive stop sequence detection.
   */
  isInsideBlock(): boolean {
    return (
      this.state.functionCallsDepth > 0 ||
      this.state.functionResultsDepth > 0 ||
      this.state.thinkingDepth > 0
    );
  }

  /**
   * Check if we're specifically inside a function_results block.
   * This is where false positive stops are most likely.
   */
  isInsideFunctionResults(): boolean {
    return this.state.functionResultsDepth > 0;
  }

  /**
   * Check if we're inside a function_calls block.
   */
  isInsideFunctionCalls(): boolean {
    return this.state.functionCallsDepth > 0;
  }

  /**
   * Get current nesting context as a string (for debugging).
   */
  getContext(): string {
    const parts: string[] = [];
    if (this.state.functionCallsDepth > 0) {
      parts.push(`function_calls(${this.state.functionCallsDepth})`);
    }
    if (this.state.functionResultsDepth > 0) {
      parts.push(`function_results(${this.state.functionResultsDepth})`);
    }
    if (this.state.thinkingDepth > 0) {
      parts.push(`thinking(${this.state.thinkingDepth})`);
    }
    return parts.length > 0 ? parts.join(' > ') : 'none';
  }

  /**
   * Get the full accumulated text.
   */
  getAccumulated(): string {
    return this.state.accumulated;
  }

  /**
   * Get current depth counters (for debugging/testing).
   */
  getDepths(): { functionCalls: number; functionResults: number; thinking: number } {
    return {
      functionCalls: this.state.functionCallsDepth,
      functionResults: this.state.functionResultsDepth,
      thinking: this.state.thinkingDepth,
    };
  }

  /**
   * Reset the parser state.
   */
  reset(): void {
    this.state = createInitialState();
  }

  /**
   * Finalize parsing and return any pending block events.
   */
  finish(): BlockEvent[] {
    // For now, just return empty - full block event support will be added later
    return [];
  }

  /**
   * Scan the new portion of accumulated text for tags and update depth counters.
   */
  private scan(): BlockEvent[] {
    const events: BlockEvent[] = [];
    const text = this.state.accumulated;

    // Only scan text we haven't processed yet
    // But look back a bit in case a tag was split across chunks
    const lookbackChars = 30;
    const scanStart = Math.max(0, this.state.lastScanPos - lookbackChars);
    const textToScan = text.slice(scanStart);

    // Reset regex state and find all tags
    ALL_TAGS.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = ALL_TAGS.exec(textToScan)) !== null) {
      const absolutePos = scanStart + match.index;

      // Skip tags we've already processed (they're in the lookback zone)
      if (absolutePos < this.state.lastScanPos) {
        continue;
      }

      const tag = match[0];
      const isClosing = tag.startsWith('</');

      // Update depth for the appropriate block type
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

    // Update scan position, but leave buffer for potential partial tags at end
    const partialTagLen = this.findPartialTagAtEnd(text);
    this.state.lastScanPos = text.length - partialTagLen;

    return events;
  }

  /**
   * Check if text ends with a partial (incomplete) tag.
   * Returns the length of the partial tag, or 0 if none.
   */
  private findPartialTagAtEnd(text: string): number {
    // Look at the last 30 chars for potential partial tags
    const tail = text.slice(-30);
    const lastLt = tail.lastIndexOf('<');

    if (lastLt === -1) {
      return 0;
    }

    const afterLt = tail.slice(lastLt);

    // If there's a complete tag (has closing >), no partial
    if (afterLt.includes('>')) {
      return 0;
    }

    // We have a partial tag - return its length
    return afterLt.length;
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Quick check if text has unclosed blocks without full parsing.
 * More efficient for simple checks.
 */
export function hasUnclosedXmlBlock(text: string): boolean {
  const parser = new IncrementalXmlParser();
  parser.push(text);
  return parser.isInsideBlock();
}

/**
 * Count opening and closing tags for a specific block type.
 */
export function countTags(
  text: string,
  openPattern: RegExp,
  closePattern: RegExp
): { open: number; close: number; depth: number } {
  // Reset lastIndex for global regexes
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
