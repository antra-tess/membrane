/**
 * Unit tests for context-management primitives: createInitialState,
 * defaultTokenEstimator, DEFAULT_CONTEXT_CONFIG.
 *
 * Converted from the legacy tsx script test/context.test.ts (pre-vitest
 * layout, never ran in CI). That script's remaining sections asserted
 * language behavior (spread copies, JSON round-trips) against local test
 * helpers rather than library exports, so they were retired instead of
 * ported.
 */

import { describe, it, expect } from 'vitest';
import {
  createInitialState,
  defaultTokenEstimator,
  DEFAULT_CONTEXT_CONFIG,
} from '../../src/context/index.js';
import type { NormalizedMessage } from '../../src/types/index.js';

function textMessage(text: string): NormalizedMessage {
  return { participant: 'User', content: [{ type: 'text', text }] };
}

describe('createInitialState', () => {
  it('starts empty, unrolled, and out of grace', () => {
    const state = createInitialState();
    expect(state.cacheMarkers).toEqual([]);
    expect(state.windowMessageIds).toEqual([]);
    expect(state.messagesSinceRoll).toBe(0);
    expect(state.inGracePeriod).toBe(false);
  });
});

describe('defaultTokenEstimator', () => {
  it('estimates ~4 chars per token, rounding up', () => {
    expect(defaultTokenEstimator(textMessage('Hello world'))).toBe(3); // 11 chars
    expect(defaultTokenEstimator(textMessage('x'.repeat(400)))).toBe(100);
  });
});

describe('DEFAULT_CONTEXT_CONFIG', () => {
  it('carries the documented rolling/cache defaults', () => {
    expect(DEFAULT_CONTEXT_CONFIG.rolling.threshold).toBe(50);
    expect(DEFAULT_CONTEXT_CONFIG.rolling.buffer).toBe(20);
    expect(DEFAULT_CONTEXT_CONFIG.rolling.unit).toBe('messages');
    expect(DEFAULT_CONTEXT_CONFIG.cache?.enabled).toBe(true);
    expect(DEFAULT_CONTEXT_CONFIG.cache?.points).toBe(1);
  });
});
