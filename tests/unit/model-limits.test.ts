import { describe, it, expect } from 'vitest';
import { getDefaultModelLimits } from '../../src/index.js';

const ONE_M = ['claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-opus-5', 'claude-opus-5-5', 'claude-sonnet-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-mythos-5', 'claude-mythos-5-1', 'claude-mythos-preview', 'claude-fable-5', 'claude-fable-5-1'];
const TWO_HUNDRED_K = ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5'];

describe('getDefaultModelLimits', () => {
  it('gives each 1M-window model a 1,000,000-token window and 128,000 tokens of output', () => {
    for (const id of ONE_M) {
      expect(getDefaultModelLimits(id), id).toEqual({ maxContextTokens: 1_000_000, maxOutputTokens: 128_000 });
    }
  });

  it('gives each 4.5 model a 200,000-token window and 64,000 tokens of output, by alias and by dated id', () => {
    for (const id of [...TWO_HUNDRED_K, 'claude-haiku-4-5-20251001', 'claude-opus-4-5-20251101', 'claude-sonnet-4-5-20250929']) {
      expect(getDefaultModelLimits(id), id).toEqual({ maxContextTokens: 200_000, maxOutputTokens: 64_000 });
    }
  });

  it('has no limits for a model before 4.5, another vendor, or another provider\'s form of a Claude id', () => {
    for (const id of ['claude-opus-4-1', 'claude-opus-4-1-20250805', 'claude-opus-4-20250514', 'claude-sonnet-4-20250514', 'claude-3-7-sonnet-20250219', 'claude-3-5-haiku-latest', 'claude-3-5-sonnet-20241022', 'claude-3-haiku-20240307', 'gpt-5.5', 'gemini-2.5-pro', 'anthropic/claude-opus-4-6', 'us.anthropic.claude-haiku-4-5-20251001-v1:0', 'us.anthropic.claude-haiku-4-5-20251001', 'anthropic.claude-haiku-4-5']) {
      expect(getDefaultModelLimits(id), id).toBeUndefined();
    }
  });

  it('takes a snapshot date after a listed id, and gives no row to an unlisted version or another suffix under a listed id', () => {
    expect(getDefaultModelLimits('claude-opus-4-6-20270101')).toEqual({ maxContextTokens: 1_000_000, maxOutputTokens: 128_000 });
    for (const id of ['claude-opus-5-1', 'claude-sonnet-5-1', 'claude-opus-4-9', 'claude-opus-5-1-20270101', 'claude-sonnet-4-5@20250929', 'claude-haiku-4-5-latest', 'claude-opus-4-6-thinking', 'claude-opus-4-6-20270101-thinking', 'claude-haiku-4-5-2025100', 'claude-haiku-4-5-202510011']) {
      expect(getDefaultModelLimits(id), id).toBeUndefined();
    }
  });

  it('gives each caller its own answer: changing one leaves the next lookup as it was', () => {
    const first = getDefaultModelLimits('claude-haiku-4-5')!;
    first.maxOutputTokens = 1;
    expect(getDefaultModelLimits('claude-haiku-4-5')).toEqual({ maxContextTokens: 200_000, maxOutputTokens: 64_000 });
  });
});
