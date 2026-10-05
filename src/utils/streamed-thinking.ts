import type { ContentBlock } from '../types/index.js';
import type { ContentParseContext } from '../formatters/types.js';

/**
 * Thinking is a provider block, not a delimiter in a text stream. Keep its
 * received snapshots/deltas at offsets in the visible text, so a plain
 * formatter never parses thinking and partial output still retains it.
 * Provider indices restart each round; completed spans keep their position.
 */
export class StreamedThinking {
  private spans: { offset: number; block: ContentBlock }[] = [];
  private current = new Map<number, { offset: number; block: ContentBlock }>();
  private textLengths = new Map<number, number>();
  private roundOffset = 0;

  beginRound(offset = 0): void {
    this.current.clear();
    this.textLengths.clear();
    this.roundOffset = offset;
  }

  reset(): void {
    this.spans = [];
    this.beginRound();
  }

  onBlock(index: number, value: unknown, offset: number): void {
    const block = value as ContentBlock | undefined;
    if (!block) return;
    this.textLengths.set(index, block.type === 'text' && typeof block.text === 'string' ? block.text.length : 0);
    // Finalized-only callbacks may follow the text deltas. Their ordered block
    // indices still place thinking before/among those text blocks, not after
    // all text merely because its snapshot arrived late.
    let logicalOffset = this.roundOffset;
    let preceding = 0;
    for (const [i, length] of this.textLengths) {
      if (i >= 0 && i < index) { logicalOffset += length; preceding++; }
    }
    if (preceding === index) offset = logicalOffset;
    if (block?.type !== 'thinking' && block?.type !== 'redacted_thinking') return;
    const snapshot = block.type === 'thinking'
      ? { ...block, thinking: block.thinking ?? '' }
      : { ...block };
    const span = this.current.get(index);
    if (span) {
      // The finalized provider snapshot supplies the signature/opaque data.
      // Copy it: Bedrock mutates its own start-block object as deltas arrive.
      span.block = snapshot;
    } else {
      const next = { offset, block: snapshot };
      this.current.set(index, next);
      this.spans.push(next);
    }
  }

  onThinkingChunk(index: number, chunk: string): void {
    const span = this.current.get(index);
    if (span?.block.type === 'thinking') {
      span.block = { ...span.block, thinking: (span.block.thinking ?? '') + chunk };
    }
  }

  content(text: string, parseText: (text: string, context: ContentParseContext) => ContentBlock[]): ContentBlock[] {
    const result: ContentBlock[] = [];
    let cursor = 0;
    for (const span of this.spans) {
      const end = Math.max(cursor, Math.min(span.offset, text.length));
      if (end > cursor) result.push(...parseText(text.slice(cursor, end), { visibleText: text, offset: cursor }));
      result.push({ ...span.block });
      cursor = end;
    }
    // Preserve the parser's empty-response operation even when only thinking arrived.
    if (cursor < text.length || text.length === 0) result.push(...parseText(text.slice(cursor), { visibleText: text, offset: cursor }));
    return result;
  }
}
