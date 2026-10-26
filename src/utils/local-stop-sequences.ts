import type { ProviderResponse, StreamCallbacks } from '../types/provider.js';
import type { MembraneBlockType } from '../types/streaming.js';
import { responsesRawItemKey } from '../formatters/openai-responses.js';

export function membraneBlockType(apiType: unknown): MembraneBlockType {
  if (apiType === 'thinking' || apiType === 'redacted_thinking' || apiType === 'reasoning') return 'thinking';
  if (apiType === 'tool_use' || apiType === 'function_call' || apiType === 'tool_call') return 'tool_call';
  return 'text';
}

type Waiting =
  | { kind: 'block'; index: number; block: unknown; at: number }
  | { kind: 'signature'; index: number; signature: string; at: number }
  | { kind: 'chunk'; chunk: string; at: number };

interface ReleasedTextBlock {
  start: Record<string, unknown>;
  text: string;
  complete: boolean;
}

/**
 * Whether a provider applies a request's stops at all varies: the Responses
 * API has no stop parameter, Chat Completions drops it for some models and
 * sends at most four, Gemini sends five, and a custom adapter need send none.
 */
export class LocalStopSequences {
  readonly callbacks: StreamCallbacks;

  private readonly stops: string[];
  private readonly longest: number;

  private readonly seen = new Set<number>();
  private openIndex: number | undefined;
  private openType: unknown;

  private held = '';
  private waiting: Waiting[] = [];

  private delivered = '';
  private readonly releasedText = new Map<number, ReleasedTextBlock>();
  private releasedOpen: number | undefined;

  private stopped = false;
  private completedAtStop: number | undefined;
  private deliveryFailed = false;

  constructor(stops: readonly string[] | undefined, private readonly inner: StreamCallbacks) {
    this.stops = [...new Set((stops ?? []).filter(stop => typeof stop === 'string' && stop.length > 0))];
    this.longest = Math.max(0, ...this.stops.map(stop => stop.length));
    this.callbacks = this.stops.length === 0 ? inner : {
      onChunk: chunk => this.delivering(() => this.onChunk(chunk)),
      onContentBlock: (index, block) => this.onContentBlock(index, block),
      onThinkingSignature: (index, signature) => {
        this.waiting.push({ kind: 'signature', index, signature, at: this.held.length });
      },
    };
  }

  release(): void {
    if (!this.stopped && !this.deliveryFailed) this.releaseTo(this.held.length, () => true);
  }

  private delivering(deliver: () => void): void {
    try {
      deliver();
    } catch (error) {
      this.deliveryFailed = true;
      throw error;
    }
  }

  finish(result: ProviderResponse): ProviderResponse {
    const found = firstStopInStretches(result.content, this.stops);
    if (!found) {
      this.releaseTo(this.held.length, () => true);
      return result;
    }
    const streamed = this.delivered + this.held;
    const upTo = visibleText(result.content).startsWith(streamed)
      ? Math.min(Math.max(found.offset - this.delivered.length, 0), this.held.length)
      : 0;
    this.releaseTo(upTo, event => event.at < upTo);
    const cut = cutVisible(result.content, found.offset);
    const waiting = this.waiting;
    this.held = '';
    this.waiting = [];
    if (Array.isArray(cut.content)) {
      for (const event of waiting) {
        if (event.kind !== 'block' || event.index === this.completedAtStop || event.index >= cut.content.length) continue;
        if (event.index <= cut.index) this.inner.onContentBlock?.(event.index, cut.content[event.index]);
      }
    }
    return { ...result, content: cut.content, stopReason: 'stop_sequence', stopSequence: found.stop };
  }

  private onChunk(chunk: string): void {
    const visible = this.openIndex === undefined || membraneBlockType(this.openType) === 'text';
    if (this.stopped) {
      if (visible) this.held += chunk;
      else this.waiting.push({ kind: 'chunk', chunk, at: this.held.length });
      return;
    }
    if (!visible) {
      this.releaseTo(this.held.length, () => true);
      this.inner.onChunk(chunk);
      return;
    }
    const delimiter = lastIndexWhere(this.waiting, event => event.kind === 'block' && blockType(event.block) !== 'text');
    if (delimiter >= 0) this.releaseTo(this.held.length, (_, i) => i <= delimiter);
    this.held += chunk;
    const found = this.earliestStop();
    if (found) {
      this.stopped = true;
      this.releaseTo(found.at, event => event.at < found.at);
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
    this.waiting.push({ kind: 'block', index, block, at: this.held.length });
  }

  private earliestStop(): { stop: string; at: number } | undefined {
    return firstStop(this.held, this.stops);
  }

  private heldStopPrefix(): number {
    for (let length = Math.min(this.longest - 1, this.held.length); length > 0; length--) {
      const suffix = this.held.slice(-length);
      if (this.stops.some(stop => stop.startsWith(suffix))) return length;
    }
    return 0;
  }

  private releaseTo(at: number, due: (event: Waiting, position: number) => boolean): void {
    const text = this.held;
    const now: Waiting[] = [];
    const later: Waiting[] = [];
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
      if (event.kind === 'block') this.deliverBlock(event.index, event.block);
      else if (event.kind === 'signature') this.inner.onThinkingSignature?.(event.index, event.signature);
      else this.inner.onChunk(event.chunk);
    }
    if (at > cursor) this.deliverText(text.slice(cursor, at));
  }

  private deliverText(text: string): void {
    if (this.releasedOpen !== undefined) this.releasedText.get(this.releasedOpen)!.text += text;
    this.delivered += text;
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

function visibleText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(block => (visibleLength(block) > 0 ? (block as { text: string }).text : '')).join('');
}

function lastIndexWhere<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) if (predicate(items[i]!)) return i;
  return -1;
}

/**
 * A provider checking token by token stops at the stop whose first occurrence
 * ends first, at equal ends the one starting first, whatever order the request
 * lists its stops in.
 */
export function firstStop(text: string, stops: readonly string[]): { stop: string; at: number } | undefined {
  let best: { stop: string; at: number; end: number } | undefined;
  for (const stop of stops) {
    const at = text.indexOf(stop);
    if (at === -1) continue;
    const end = at + stop.length;
    if (!best || end < best.end || (end === best.end && at < best.at)) best = { stop, at, end };
  }
  return best && { stop: best.stop, at: best.at };
}

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
