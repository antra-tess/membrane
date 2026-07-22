/**
 * Interleaved-thinking beta gating: which models need the
 * `interleaved-thinking-2025-05-14` flag when thinking is enabled.
 * Native from Opus/Sonnet 4.6 onward; beta-only on earlier Claude 4.
 */

import { describe, it, expect } from 'vitest';
import { needsInterleavedThinkingBeta } from '../src/providers/anthropic.js';

describe('needsInterleavedThinkingBeta', () => {
  it('flags pre-4.6 Claude 4 models', () => {
    expect(needsInterleavedThinkingBeta('claude-opus-4-5')).toBe(true);
    expect(needsInterleavedThinkingBeta('claude-opus-4-1-20250805')).toBe(true);
    expect(needsInterleavedThinkingBeta('claude-sonnet-4-5-20250929')).toBe(true);
    expect(needsInterleavedThinkingBeta('claude-haiku-4-5-20251001')).toBe(true);
  });

  it('treats bare and date-only ids as 4.0 (flagged)', () => {
    expect(needsInterleavedThinkingBeta('claude-opus-4')).toBe(true);
    expect(needsInterleavedThinkingBeta('claude-opus-4-20250514')).toBe(true);
    expect(needsInterleavedThinkingBeta('claude-sonnet-4-20250514')).toBe(true);
  });

  it('does not flag 4.6+ models (native interleaved thinking)', () => {
    expect(needsInterleavedThinkingBeta('claude-opus-4-6')).toBe(false);
    expect(needsInterleavedThinkingBeta('claude-opus-4-6-20260115')).toBe(false);
    expect(needsInterleavedThinkingBeta('claude-sonnet-4-6')).toBe(false);
    expect(needsInterleavedThinkingBeta('claude-opus-4-7')).toBe(false);
    expect(needsInterleavedThinkingBeta('claude-opus-4-8')).toBe(false);
  });

  it('does not flag Claude 3.x (no interleaved support at all) or the 5-series', () => {
    expect(needsInterleavedThinkingBeta('claude-3-7-sonnet-20250219')).toBe(false);
    expect(needsInterleavedThinkingBeta('claude-3-5-haiku-20241022')).toBe(false);
    expect(needsInterleavedThinkingBeta('claude-fable-5')).toBe(false);
    expect(needsInterleavedThinkingBeta('claude-sonnet-5')).toBe(false);
  });

  it('matches gateway-prefixed ids', () => {
    expect(needsInterleavedThinkingBeta('anthropic/claude-opus-4-5')).toBe(true);
    expect(needsInterleavedThinkingBeta('anthropic/claude-opus-4-6')).toBe(false);
    expect(needsInterleavedThinkingBeta('anthropic/claude-opus-4')).toBe(true);
  });

  it('ignores non-Claude / unrelated ids', () => {
    expect(needsInterleavedThinkingBeta('gpt-4o')).toBe(false);
    expect(needsInterleavedThinkingBeta('')).toBe(false);
  });
});
