/**
 * The API rejects `cache_control` on thinking and redacted_thinking blocks
 * with a 400: "thinking.cache_control: Extra inputs are not permitted".
 */
import { describe, it, expect } from 'vitest';
import { lastCacheableBlockIndex } from './formatters/native.js';

describe('lastCacheableBlockIndex', () => {
  it('steps back past a trailing thinking block', () => {
    expect(lastCacheableBlockIndex([
      { type: 'text', text: 'hi' },
      { type: 'thinking', thinking: '', signature: 'sig' },
    ])).toBe(0);
  });

  it('skips the breakpoint entirely for a thinking-only message', () => {
    expect(lastCacheableBlockIndex([
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'redacted_thinking', data: 'x' },
    ])).toBe(-1);
  });

  it('uses the last block when it is cacheable', () => {
    expect(lastCacheableBlockIndex([
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'tool_use', name: 't', input: {} },
    ])).toBe(1);
  });
});
