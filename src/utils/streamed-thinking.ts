import type { ContentBlock } from '../types/index.js';
import type { ContentParseContext } from '../formatters/types.js';

/** Provider block indices restart each round. */
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

  onBlock(index: number, value: unknown, offset: number): void {
    const block = value as ContentBlock | undefined;
    if (!block) return;
    this.textLengths.set(index, block.type === 'text' && typeof block.text === 'string' ? block.text.length : 0);
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
      span.block = snapshot;
    } else {
      const next = { offset, block: snapshot };
      this.current.set(index, next);
      this.spans.push(next);
    }
  }

  onSignature(index: number, signature: string): void {
    const span = this.current.get(index);
    if (span?.block.type === 'thinking') span.block = { ...span.block, signature };
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
    if (cursor < text.length || text.length === 0) result.push(...parseText(text.slice(cursor), { visibleText: text, offset: cursor }));
    return result;
  }
}
