/**
 * Incremental XML parser for streaming
 *
 * Tracks nesting depth of XML blocks as tokens arrive, enabling:
 * - False-positive stop sequence detection
 * - Structured block events for UI
 * - Enriched chunk metadata for TTS/display filtering
 *
 * It also tracks where a tool-call parameter's CDATA payload is (see
 * utils/xml-payload.ts): a payload is data, so no tag inside it opens or closes
 * a block, and a stop sequence inside it is not a real stop. The accumulated
 * parser (tool-parser.ts) applies the same rule to complete text; both treat a
 * payload as starting at a parameter opener inside an invoke of an open
 * function_calls block (outside thinking and results), directly or after one
 * newline, and running through consecutive CDATA sections.
 */

import type {
  BlockEvent,
  ChunkMeta,
  MembraneBlock,
  MembraneBlockType,
} from '../types/streaming.js';
import { CDATA_CLOSE, CDATA_OPEN } from './xml-payload.js';

// ============================================================================
// Result Types
// ============================================================================

/**
 * A single emission from processChunk - either content or a block event.
 * Emissions are in the correct order for interleaved processing.
 */
export type StreamEmission =
  | { kind: 'content'; text: string; meta: ChunkMeta }
  | { kind: 'blockEvent'; event: BlockEvent };

export interface ProcessChunkResult {
  /** Ordered emissions for correct interleaving */
  emissions: StreamEmission[];
  /** @deprecated Use emissions instead - content may be out of order with blockEvents */
  content: Array<{ text: string; meta: ChunkMeta }>;
  /** @deprecated Use emissions instead - blockEvents may be out of order with content */
  blockEvents: BlockEvent[];
}

// ============================================================================
// Parser State
// ============================================================================

/**
 * Where the current parameter value stands.
 * - `none`: not inside a parameter value.
 * - `leading`: just after a structural parameter opener; one newline may come,
 *   then a CDATA payload may begin.
 * - `raw`: inside an ordinary value. It runs to a closer; openers inside it are
 *   text, so a parameter-looking opener starts nothing.
 * - `cdata`: inside a CDATA section. Nothing here is a tag.
 * - `between`: just after a section's `]]>`; another section may follow.
 * - `suffix`: after the payload, text before the value's closer, which refuses
 *   the call. Only a closer — `</parameter>`, `</invoke>`, `</function_calls>`
 *   — is a tag here; an opener starts no invoke, block or container.
 */
type ValueState = 'none' | 'leading' | 'raw' | 'cdata' | 'between' | 'suffix';

interface ParserState {
  functionCallsDepth: number;
  functionResultsDepth: number;
  thinkingDepth: number;
  /**
   * The thinking and results containers opened since history ended (see
   * endHistory) and still open. These, not the depths, decide whether a tag
   * is structure: a container history left open is not the turn's, and the
   * complete-text walker reads an unclosed one as no container at all.
   */
  turnContainers: { thinking: number; results: number };
  accumulated: string;
  blockIndex: number;
  currentBlockStarted: boolean;
  currentBlockContent: string;
  currentBlockType: MembraneBlockType;
  tagBuffer: string;
  /** Inside a structural invoke: one opened in a function_calls block, outside thinking and results. */
  inInvoke: boolean;
  value: ValueState;
  /** The one newline a payload may follow has been seen. */
  leadingNewline: boolean;
  /** A partial `<![CDATA[` read where a section may begin. */
  cdataOpenBuffer: string;
  /** How many `]` of a section's `]]>` have been read. */
  cdataCloseMatched: number;
  /** Payloads seen, as [start, end) offsets into `accumulated`; an open one ends at Infinity. */
  payloads: Array<{ start: number; end: number }>;
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
    turnContainers: { thinking: 0, results: 0 },
    accumulated: '',
    blockIndex: 0,
    currentBlockStarted: false,
    currentBlockContent: '',
    currentBlockType: 'text',
    tagBuffer: '',
    inInvoke: false,
    value: 'none',
    leadingNewline: false,
    cdataOpenBuffer: '',
    cdataCloseMatched: 0,
    payloads: [],
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

// For matching complete membrane tags. Group 1 = closing slash, 2 = element name.
const COMPLETE_MEMBRANE_TAG = /^<(\/?)(?:antml:)?(function_calls|function_results|thinking|invoke|parameter)(?:\s[^>]*)?>$/;

// The closers that end a parameter value: its own, or the invoke's or block's
// that end it unclosed. The only tags in a payload's suffix.
const ENDS_VALUE = /^<\/(?:antml:)?(?:parameter|invoke|function_calls)>$/;

// Known membrane tag prefixes: every element, with and without the antml
// namespace, as an opener's start and a whole closer. Assembled, so the source
// holds no literal tool-call markup.
const MEMBRANE_TAG_PREFIXES = ['thinking', 'function_calls', 'function_results', 'invoke', 'parameter'].flatMap(
  (name) => ['', 'antml:'].flatMap((namespace) => [`<${namespace}${name}`, `</${namespace}${name}>`])
);

/** Receives what processChunk emits; push() passes none and emits nothing. */
interface EmissionSink {
  content(text: string, meta: ChunkMeta): void;
  blockEvent(event: BlockEvent): void;
}

// ============================================================================
// Incremental XML Parser
// ============================================================================

export class IncrementalXmlParser {
  private state: ParserState;

  constructor() {
    this.state = createInitialState();
  }

  /**
   * Add text without emitting: a prefill, or text the harness writes into the
   * model's markup (a restored stop sequence, a thinking opener). Depths and
   * payload state follow it exactly as they follow streamed text. An injected
   * envelope goes through pushEnvelope instead.
   */
  push(chunk: string): BlockEvent[] {
    this.consume(chunk, null);
    return [];
  }

  /**
   * Add an envelope the harness injected — results and notices answering a
   * block — without reading it. Nothing in it is the model's markup: a tool's
   * output that opens a thinking block, say, must not move the depths or the
   * turn's containers that the model's next round is read against, just as
   * the complete-text parse never reads a recorded envelope. The harness
   * injects one only where the model's markup is at rest, after a block's
   * closer, so there is no partial tag or value to carry across it.
   */
  pushEnvelope(text: string): void {
    this.state.accumulated += text;
  }

  /**
   * The text pushed so far is history the turn did not write. A value it left
   * open after a payload began ends here, payload or suffix: one forgotten
   * `]]>` or closer in an earlier turn must not turn this turn's text into
   * data. Depths are left as they are, as for any unclosed block in history,
   * and still type the turn's text; but a thinking or results container
   * history left open is not the turn's, so it no longer keeps the turn's
   * calls from being structure (see turnContainers).
   */
  endHistory(): void {
    const state = this.state;
    if (state.value === 'cdata' || state.value === 'between' || state.value === 'suffix' || state.value === 'leading') {
      this.closeOpenPayload();
      state.value = 'none';
    }
    state.inInvoke = false;
    state.cdataOpenBuffer = '';
    state.turnContainers = { thinking: 0, results: 0 };
  }

  /** The accumulated text ends inside a parameter's CDATA payload. */
  isInsidePayload(): boolean {
    return this.state.value === 'cdata';
  }

  /** Whether an offset into the accumulated text lies inside a CDATA payload. */
  isPayloadAt(index: number): boolean {
    return this.state.payloads.some(payload => index >= payload.start && index < payload.end);
  }

  /**
   * Reset streaming state for a new API response iteration.
   * Keeps accumulated text and depths, but resets block tracking
   * so processChunk will resync currentBlockType with current depths.
   * Payload state is kept: a stop inside a payload resumes inside it.
   */
  resetForNewIteration(): void {
    this.state.currentBlockStarted = false;
    this.state.currentBlockContent = '';
    this.state.currentBlockType = this.getCurrentBlockType();
    this.state.tagBuffer = '';
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

  /**
   * Get the current block index (for external block event emission).
   */
  getBlockIndex(): number {
    return this.state.blockIndex;
  }

  /**
   * Increment the block index (call after emitting external block events).
   */
  incrementBlockIndex(): void {
    this.state.blockIndex++;
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
    const emissions: StreamEmission[] = [];
    const content: Array<{ text: string; meta: ChunkMeta }> = [];
    const blockEvents: BlockEvent[] = [];

    // Sync currentBlockType with depths before processing
    // This handles the case where push() was used for prefill initialization
    // and now we're streaming with processChunk()
    if (!this.state.currentBlockStarted) {
      this.state.currentBlockType = this.getCurrentBlockType();
    }

    this.consume(chunk, {
      content: (text, meta) => {
        emissions.push({ kind: 'content', text, meta });
        content.push({ text, meta });
      },
      blockEvent: (event) => {
        emissions.push({ kind: 'blockEvent', event });
        blockEvents.push(event);
      },
    });

    return { emissions, content, blockEvents };
  }

  flush(): ProcessChunkResult {
    const emissions: StreamEmission[] = [];
    const content: Array<{ text: string; meta: ChunkMeta }> = [];
    const blockEvents: BlockEvent[] = [];

    const pending = this.state.tagBuffer + this.state.cdataOpenBuffer;
    if (pending) {
      if (!this.state.currentBlockStarted) {
        const event = this.makeBlockStart(this.state.currentBlockType);
        emissions.push({ kind: 'blockEvent', event });
        blockEvents.push(event);
      }
      const meta = this.getCurrentMeta();
      emissions.push({ kind: 'content', text: pending, meta });
      content.push({ text: pending, meta });
      this.state.currentBlockContent += pending;
      this.state.tagBuffer = '';
      this.state.cdataOpenBuffer = '';
    }

    if (this.state.currentBlockStarted) {
      const event = this.makeBlockComplete();
      emissions.push({ kind: 'blockEvent', event });
      blockEvents.push(event);
    }

    return { emissions, content, blockEvents };
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

  /**
   * Read `chunk` character by character: tags, depths and payloads. With a
   * sink (processChunk) text and block events are emitted as they are read;
   * without one (push) only the state follows the text, and depths never go
   * below zero.
   */
  private consume(chunk: string, sink: EmissionSink | null): void {
    const base = this.state.accumulated.length;
    this.state.accumulated += chunk;

    const emitText = (text: string): void => {
      if (!sink || !text) return;
      this.ensureBlockStartedWithEmit((event) => sink.blockEvent(event));
      sink.content(text, this.getCurrentMeta());
      this.state.currentBlockContent += text;
    };

    let pos = 0;
    while (pos < chunk.length) {
      const state = this.state;

      // Inside a payload nothing is a tag: read to the section's `]]>`.
      if (state.value === 'cdata') {
        let end = pos;
        while (end < chunk.length) {
          const char = chunk[end]!;
          end++;
          if (char === ']') {
            state.cdataCloseMatched = Math.min(state.cdataCloseMatched + 1, 2);
          } else if (char === '>' && state.cdataCloseMatched === 2) {
            state.cdataCloseMatched = 0;
            state.value = 'between';
            break;
          } else {
            state.cdataCloseMatched = 0;
          }
        }
        emitText(chunk.slice(pos, end));
        if (state.value === 'between') this.markPayloadEnd(base + end);
        pos = end;
        continue;
      }

      // Where a payload may begin: one newline after the opener, then `<![CDATA[`.
      if (state.value === 'leading' || state.value === 'between') {
        const char = chunk[pos]!;
        if (state.cdataOpenBuffer === '' && state.value === 'leading' && !state.leadingNewline && char === '\n') {
          state.leadingNewline = true;
          emitText(char);
          pos++;
          continue;
        }
        // Not a section: before any payload the value is ordinary text from
        // here; after one, it is the payload's suffix.
        const rest: ValueState = state.value === 'leading' ? 'raw' : 'suffix';
        if (state.cdataOpenBuffer !== '' || char === '<') {
          const candidate = state.cdataOpenBuffer + char;
          if (CDATA_OPEN.startsWith(candidate)) {
            pos++;
            if (candidate === CDATA_OPEN) {
              if (state.value === 'leading') this.markPayloadStart(base + pos - CDATA_OPEN.length);
              else this.reopenPayload();
              state.cdataOpenBuffer = '';
              state.value = 'cdata';
              emitText(candidate);
            } else {
              state.cdataOpenBuffer = candidate;
            }
            continue;
          }
          // Not a section after all. What was held began with `<`, so it is
          // read on as a possible tag — it may be the parameter's closer — and
          // this character is read after it.
          state.tagBuffer = state.cdataOpenBuffer;
          state.cdataOpenBuffer = '';
          state.value = rest;
          continue;
        }
        state.value = rest;
        continue;
      }

      if (state.tagBuffer) {
        const char = chunk[pos]!;
        state.tagBuffer += char;
        pos++;

        const tag = COMPLETE_MEMBRANE_TAG.exec(state.tagBuffer);
        if (state.tagBuffer.endsWith('>') && tag) {
          const tagText = state.tagBuffer;
          state.tagBuffer = '';
          if (state.value === 'suffix' && !ENDS_VALUE.test(tagText)) {
            // A payload's suffix is data, as the accumulated parser masks it:
            // only a closer that ends the value is a tag there.
            emitText(tagText);
          } else {
            this.handleMembraneTag(tagText, tag[1] === '/', tag[2]!, sink);
          }
        } else if (this.cantBeMembraneTag(state.tagBuffer)) {
          const text = state.tagBuffer;
          state.tagBuffer = '';
          emitText(text);
        }
        continue;
      }

      const nextLt = chunk.indexOf('<', pos);
      if (nextLt === -1) {
        emitText(chunk.slice(pos));
        break;
      }
      if (nextLt > pos) emitText(chunk.slice(pos, nextLt));
      state.tagBuffer = '<';
      pos = nextLt + 1;
    }
  }

  private markPayloadStart(at: number): void {
    this.state.payloads.push({ start: at, end: Number.POSITIVE_INFINITY });
  }

  /** A further section continues the payload the last `]]>` ended. */
  private reopenPayload(): void {
    const last = this.state.payloads[this.state.payloads.length - 1];
    if (last) last.end = Number.POSITIVE_INFINITY;
  }

  private markPayloadEnd(at: number): void {
    const last = this.state.payloads[this.state.payloads.length - 1];
    if (last && last.end === Number.POSITIVE_INFINITY) last.end = at;
  }

  /** An open payload ends where the readable text ends (see endHistory). */
  private closeOpenPayload(): void {
    this.markPayloadEnd(this.state.accumulated.length);
    this.state.cdataCloseMatched = 0;
  }

  private cantBeMembraneTag(buffer: string): boolean {
    if (buffer.endsWith('>')) {
      return !COMPLETE_MEMBRANE_TAG.test(buffer);
    }
    for (const prefix of MEMBRANE_TAG_PREFIXES) {
      if (prefix.startsWith(buffer) || buffer.startsWith(prefix.slice(0, buffer.length))) {
        return false;
      }
    }
    return true;
  }

  /**
   * One complete tag. Depths follow function_calls, function_results and
   * thinking tags; invoke and parameter tags only move the payload state. The
   * element is read by name, so an attribute value that mentions `thinking`
   * (a parameter named thinking_budget, say) is not a thinking tag.
   */
  private handleMembraneTag(tag: string, isClosing: boolean, element: string, sink: EmissionSink | null): void {
    const state = this.state;
    const emit = (event: BlockEvent): void => sink?.blockEvent(event);
    const opening = !isClosing;

    if (element === 'thinking' || element === 'function_calls' || element === 'function_results') {
      if (element === 'function_calls') {
        // A block opening or closing ends any invoke; an opener inside an open
        // block re-anchors the call there, as the accumulated parser reads it.
        state.inInvoke = false;
        state.value = 'none';
      } else {
        const container = element === 'thinking' ? 'thinking' : 'results';
        state.turnContainers[container] = opening
          ? state.turnContainers[container] + 1
          : Math.max(0, state.turnContainers[container] - 1);
      }
      const blockType: MembraneBlockType =
        element === 'thinking' ? 'thinking' : element === 'function_calls' ? 'tool_call' : 'tool_result';
      const depthKey =
        element === 'thinking' ? 'thinkingDepth' : element === 'function_calls' ? 'functionCallsDepth' : 'functionResultsDepth';

      if (!sink) {
        // push(): depth only, never below zero.
        state[depthKey] = opening ? state[depthKey] + 1 : Math.max(0, state[depthKey] - 1);
        return;
      }
      if (opening) {
        if (state.currentBlockStarted) emit(this.makeBlockComplete());
        state[depthKey]++;
        state.currentBlockType = blockType;
        emit(this.makeBlockStart(blockType));
      } else {
        emit(this.makeBlockComplete());
        state[depthKey]--;
        state.currentBlockType = this.getCurrentBlockType();
      }
      return;
    }

    // Only the turn's own containers count here: a call after a thinking block
    // history left unclosed is structure, as the accumulated parser reads it.
    const structural =
      state.functionCallsDepth > 0 && state.turnContainers.thinking === 0 && state.turnContainers.results === 0;

    if (element === 'invoke') {
      if (isClosing) {
        state.inInvoke = false;
        state.value = 'none';
      } else {
        // A new head starts a call (a head inside an open call swallowed it); a
        // self-closing head has no parameters.
        state.inInvoke = structural && !/\/\s*>$/.test(tag);
        state.value = 'none';
      }
    } else if (element === 'parameter') {
      if (isClosing) {
        state.value = 'none';
      } else if (state.inInvoke && state.value !== 'raw') {
        state.value = 'leading';
        state.leadingNewline = false;
      }
    }

    // Invoke and parameter tags are structure, not content: as before, they are
    // not emitted, and block content holds only the values.
  }

  private ensureBlockStartedWithEmit(emit: (event: BlockEvent) => void): void {
    if (!this.state.currentBlockStarted) {
      emit(this.makeBlockStart(this.state.currentBlockType));
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
    // Use currentBlockType (updated only after tag is fully handled)
    // not getCurrentBlockType() (which checks depths that may be pre-updated by scanForDepth)
    const type = this.state.currentBlockType;
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
