import type { ProviderResponse, StreamCallbacks } from '../types/provider.js';
import type { MembraneBlockType } from '../types/streaming.js';
import { responsesRawItemKey } from '../formatters/openai-responses.js';

/**
 * The membrane block type a provider block streams as: thinking, a tool call,
 * or (anything else) text. One definition, so the stop scan below and the
 * native loops' chunk labels agree on which chunks are visible.
 */
export function membraneBlockType(apiType: unknown): MembraneBlockType {
  if (apiType === 'thinking' || apiType === 'redacted_thinking' || apiType === 'reasoning') return 'thinking';
  if (apiType === 'tool_use' || apiType === 'function_call' || apiType === 'tool_call') return 'tool_call';
  return 'text';
}

interface WaitingBlock {
  index: number;
  block: unknown;
  /** Held text before this event. */
  at: number;
}

interface ReleasedTextBlock {
  start: Record<string, unknown>;
  text: string;
  complete: boolean;
}

/**
 * A request's stop sequences, applied to one native streaming attempt the way
 * a provider applies them.
 *
 * Whether a provider applies a request's stops at all varies: the Responses
 * API has no stop parameter, Chat Completions drops it for some models and
 * sends at most four, Gemini sends five, and a custom adapter need send none.
 * So Membrane applies them itself, to the visible text of every native
 * attempt, and the accepted output ends at the first stop whatever the
 * provider did. Where the provider already stopped, the stop never streams
 * and nothing changes.
 *
 * What the caller receives is what a provider-side stop produces:
 * - No chunk carries any part of the stop or anything after it, however the
 *   provider chunks or subdivides its text. Visible text that could still
 *   begin a stop is held until it either completes a stop or cannot.
 * - At a stop, the text block open at that point completes with the text
 *   before the stop, and nothing after it is reported. A block boundary
 *   exactly at the stop counts as after it: a stop that begins a new text
 *   block leaves the previous block whole and the new one unreported.
 * - The attempt ends with stopReason 'stop_sequence' and the stop as its
 *   stopSequence, its content cut at the same point. A message item shared by
 *   the cut text loses its replayable rawItem on every block that kept it, so
 *   the next request replays the accepted text rather than the whole item.
 *
 * Thinking is never scanned, and a non-text block ends a stretch of visible
 * text: a stop does not span one. The provider's stream still runs to its end,
 * so the attempt's usage and raw response are the provider's own.
 *
 * Block events wait until a chunk follows them. Block events can't be told
 * apart on arrival: a paired adapter's first report is a start payload,
 * and a single-final adapter's is a finished block whose text may never have
 * streamed (see StreamCallbacks). Timing tells them apart: single-final reports
 * come after the last chunk. So an event followed by a chunk is released, in
 * order, before that chunk. Events still waiting when the adapter returns are
 * settled against its returned content. If no streamed text reached a stop,
 * the returned visible text is scanned too, so text the provider reported only
 * at the end is held to the same stops, and the waiting events are delivered
 * as that content's blocks, cut at the stop. The cost, only when stops are
 * configured: a paired block event that no chunk follows, such as a trailing
 * tool call, is reported when the stream ends rather than as it arrives.
 */
export class LocalStopSequences {
  readonly callbacks: StreamCallbacks;

  private readonly stops: string[];
  private readonly longest: number;

  // The block incoming chunks belong to, by the same rule as the loops'
  // NativeBlockTracker: a first sighting opens a block, the open block's
  // second sighting closes it.
  private readonly seen = new Set<number>();
  private openIndex: number | undefined;
  private openType: unknown;

  // Visible text that could still begin a stop, and the block events no chunk
  // has followed yet.
  private held = '';
  private waiting: WaitingBlock[] = [];

  // What the caller has received: visible length, and its text blocks.
  private released = 0;
  private readonly releasedText = new Map<number, ReleasedTextBlock>();
  private releasedOpen: number | undefined;

  private stopped: { stop: string; offset: number } | undefined;
  /** The text block completed at the stop: its own later completion is not reported again. */
  private completedAtStop: number | undefined;

  constructor(stops: readonly string[] | undefined, private readonly inner: StreamCallbacks) {
    this.stops = [...new Set((stops ?? []).filter(stop => typeof stop === 'string' && stop.length > 0))];
    this.longest = Math.max(0, ...this.stops.map(stop => stop.length));
    this.callbacks = this.stops.length === 0 ? inner : {
      onChunk: chunk => this.onChunk(chunk),
      onContentBlock: (index, block) => this.onContentBlock(index, block),
    };
  }

  /**
   * The adapter threw. Before a stop, everything held was received and is
   * delivered, so partialContent keeps it. After a stop, only what the
   * accepted text already delivered stands.
   */
  release(): void {
    if (!this.stopped) this.releaseTo(this.held.length, () => true);
  }

  /** The adapter returned: settle what is held against its returned content. */
  finish(result: ProviderResponse): ProviderResponse {
    if (!this.stopped) {
      const found = firstStopInStretches(result.content, this.stops);
      if (!found) {
        this.releaseTo(this.held.length, () => true);
        return result;
      }
      // A stop the streamed text never reached: text the provider reported
      // only in its returned content.
      this.stopped = found;
      const upTo = Math.min(Math.max(found.offset - this.released, 0), this.held.length);
      this.releaseTo(upTo, event => event.at < upTo);
    }
    const stopped = this.stopped;
    const cut = cutVisible(result.content, stopped.offset);
    const waiting = this.waiting;
    this.held = '';
    this.waiting = [];
    if (Array.isArray(cut.content)) {
      for (const event of waiting) {
        if (event.index === this.completedAtStop || event.index >= cut.content.length) continue;
        if (event.index <= cut.index) this.inner.onContentBlock?.(event.index, cut.content[event.index]);
      }
    }
    return { ...result, content: cut.content, stopReason: 'stop_sequence', stopSequence: stopped.stop };
  }

  private onChunk(chunk: string): void {
    if (this.stopped) return;
    if (this.openIndex !== undefined && membraneBlockType(this.openType) !== 'text') {
      this.releaseTo(this.held.length, () => true);
      this.inner.onChunk(chunk);
      return;
    }
    // A non-text block waiting between held text and this chunk ends the
    // stretch: text before it cannot begin a stop that continues after it.
    const delimiter = lastIndexWhere(this.waiting, event => blockType(event.block) !== 'text');
    if (delimiter >= 0) this.releaseTo(this.held.length, (_, i) => i <= delimiter);
    this.held += chunk;
    const found = this.earliestStop();
    if (found) {
      // Settle the stop before anything reaches the caller, so a callback that
      // throws leaves release() nothing to deliver, least of all the stop.
      this.stopped = { stop: found.stop, offset: this.released + found.at };
      this.releaseTo(found.at, event => event.at < found.at);
      this.held = '';
      this.waiting = [];
      this.completeAtStop();
      return;
    }
    const safe = this.held.length - this.heldStopPrefix();
    this.releaseTo(safe, event => event.at < safe);
  }

  private onContentBlock(index: number, block: unknown): void {
    const type = blockType(block);
    if (type !== 'image' && type !== 'generated_image') {
      if (!this.seen.has(index)) {
        this.seen.add(index);
        this.openIndex = index;
        this.openType = type;
      } else if (index === this.openIndex) {
        this.openIndex = undefined;
        this.openType = undefined;
      }
    }
    this.waiting.push({ index, block, at: this.held.length });
  }

  /** The stop whose occurrence in the held text ends first, as a provider's token-by-token check would find it. */
  private earliestStop(): { stop: string; at: number } | undefined {
    return firstStop(this.held, this.stops);
  }

  /** Length of the longest held suffix that is a proper prefix of a stop. */
  private heldStopPrefix(): number {
    for (let length = Math.min(this.longest - 1, this.held.length); length > 0; length--) {
      const suffix = this.held.slice(-length);
      if (this.stops.some(stop => stop.startsWith(suffix))) return length;
    }
    return 0;
  }

  /**
   * Deliver held text before `at`, interleaved with the waiting events `due`
   * selects, and keep the rest. The held state is consumed before any
   * callback runs, so a callback that throws is never handed the same text or
   * event again.
   */
  private releaseTo(at: number, due: (event: WaitingBlock, position: number) => boolean): void {
    const text = this.held;
    const now: WaitingBlock[] = [];
    const later: WaitingBlock[] = [];
    this.waiting.forEach((event, position) => (due(event, position) ? now : later).push(event));
    this.held = text.slice(at);
    this.waiting = later.map(event => ({ ...event, at: Math.max(0, event.at - at) }));
    let cursor = 0;
    for (const event of now) {
      const upTo = Math.min(event.at, at);
      if (upTo > cursor) {
        this.deliverText(text.slice(cursor, upTo));
        cursor = upTo;
      }
      this.deliverBlock(event.index, event.block);
    }
    if (at > cursor) this.deliverText(text.slice(cursor, at));
  }

  private deliverText(text: string): void {
    if (this.releasedOpen !== undefined) this.releasedText.get(this.releasedOpen)!.text += text;
    this.released += text.length;
    this.inner.onChunk(text);
  }

  private deliverBlock(index: number, block: unknown): void {
    if (blockType(block) === 'text') {
      const known = this.releasedText.get(index);
      if (!known) {
        this.releasedText.set(index, { start: { ...(block as Record<string, unknown>) }, text: '', complete: false });
        this.releasedOpen = index;
      } else {
        known.complete = true;
        if (this.releasedOpen === index) this.releasedOpen = undefined;
      }
    }
    this.inner.onContentBlock?.(index, block);
  }

  /** The text block open at the stop completes with the text before it. */
  private completeAtStop(): void {
    const index = this.releasedOpen;
    const open = index === undefined ? undefined : this.releasedText.get(index);
    if (index === undefined || !open || open.complete) return;
    open.complete = true;
    this.completedAtStop = index;
    this.inner.onContentBlock?.(index, { ...open.start, text: open.text });
  }
}

function blockType(block: unknown): unknown {
  return (block as { type?: unknown } | undefined)?.type;
}

function visibleLength(block: unknown): number {
  const item = block as { type?: unknown; text?: unknown } | undefined;
  return item?.type === 'text' && typeof item.text === 'string' ? item.text.length : 0;
}

function lastIndexWhere<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) if (predicate(items[i]!)) return i;
  return -1;
}

/** The stop whose first occurrence in `text` ends first; at equal ends, the one starting first. */
function firstStop(text: string, stops: readonly string[]): { stop: string; at: number } | undefined {
  let best: { stop: string; at: number; end: number } | undefined;
  for (const stop of stops) {
    const at = text.indexOf(stop);
    if (at === -1) continue;
    const end = at + stop.length;
    if (!best || end < best.end || (end === best.end && at < best.at)) best = { stop, at, end };
  }
  return best && { stop: best.stop, at: best.at };
}

/**
 * The first stop in provider content's visible text, as a visible offset.
 * Adjacent text blocks form one stretch; any other block ends it, as it does
 * while streaming.
 */
function firstStopInStretches(content: unknown, stops: readonly string[]): { stop: string; offset: number } | undefined {
  if (typeof content === 'string') {
    const found = firstStop(content, stops);
    return found && { stop: found.stop, offset: found.at };
  }
  if (!Array.isArray(content)) return undefined;
  let offset = 0;
  let stretch = '';
  const scan = (): { stop: string; offset: number } | undefined => {
    const found = firstStop(stretch, stops);
    return found && { stop: found.stop, offset: offset - stretch.length + found.at };
  };
  for (const block of content) {
    if (blockType(block) === 'text') {
      const text = (block as { text?: unknown }).text;
      if (typeof text === 'string') {
        stretch += text;
        offset += text.length;
      }
      continue;
    }
    const found = scan();
    if (found) return found;
    stretch = '';
  }
  return scan();
}

/**
 * Provider content cut at a visible-text offset: the blocks before the text
 * block the offset falls in, that block truncated (dropped when nothing of it
 * remains), and nothing after it. `index` is the position of that block in
 * the original content (its length when the offset cuts nothing). A replayable
 * rawItem the cut block shares is removed from every block that kept it, by
 * the identity the Responses formatter replays items under.
 */
export function cutVisible(content: unknown, offset: number): { content: unknown; index: number } {
  if (typeof content === 'string') return { content: content.slice(0, offset), index: 0 };
  if (!Array.isArray(content)) return { content, index: 0 };
  const kept: unknown[] = [];
  let consumed = 0;
  let index = content.length;
  let cutItem: unknown;
  for (const [position, block] of content.entries()) {
    const length = visibleLength(block);
    if (length > 0 && consumed + length > offset) {
      index = position;
      const item = block as { text: string; rawItem?: unknown };
      cutItem = item.rawItem;
      const keep = offset - consumed;
      if (keep > 0) kept.push({ ...item, text: item.text.slice(0, keep) });
      break;
    }
    consumed += length;
    kept.push(block);
  }
  if (!cutItem || typeof cutItem !== 'object') return { content: kept, index };
  const key = responsesRawItemKey(cutItem as Record<string, unknown>);
  const sharesCutItem = (raw: unknown) => raw === cutItem
    || (Boolean(raw) && typeof raw === 'object' && responsesRawItemKey(raw as Record<string, unknown>) === key);
  return {
    index,
    content: kept.map(block => {
      const raw = (block as { rawItem?: unknown } | undefined)?.rawItem;
      if (raw === undefined || !sharesCutItem(raw)) return block;
      const { rawItem: _dropped, ...rest } = block as Record<string, unknown>;
      return rest;
    }),
  };
}
