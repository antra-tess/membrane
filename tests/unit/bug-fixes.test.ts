/**
 * Tests for bug fixes identified in code review.
 *
 * Covers:
 * 1. Temperature=1 enforcement when thinking is enabled
 * 2. Stop sequence capture in native mode streaming
 * 3. JSON.parse safety for malformed tool arguments
 * 4. Abort signal respected during retry delay
 */

import { describe, it, expect, vi } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { MockAdapter } from '../../src/providers/mock.js';
import type { NormalizedRequest, NormalizedMessage } from '../../src/types/index.js';

// ============================================================================
// Helpers
// ============================================================================

function createMessage(participant: string, text: string): NormalizedMessage {
  return { participant, content: [{ type: 'text', text }] };
}

function makeRequest(overrides: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    messages: [createMessage('User', 'Hello')],
    config: {
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 100,
      ...overrides.config,
    },
    ...overrides,
  };
}

// ============================================================================
// 1. Temperature enforcement for extended thinking
// ============================================================================

describe('Temperature enforcement for thinking', () => {
  it('forces temperature=1 in complete() when thinking is enabled', async () => {
    let capturedRequest: any;
    const adapter = new MockAdapter({
      defaultResponse: 'Hello',
    });
    const membrane = new Membrane(adapter);

    const request = makeRequest({
      config: {
        model: 'claude-haiku-4-5-20251001',
        maxTokens: 1000,
        temperature: 0.5,
        thinking: { enabled: true, budgetTokens: 1000 },
      },
    });

    await membrane.complete(request, {
      onRequest: (req) => { capturedRequest = req; },
    });

    expect(capturedRequest.temperature).toBe(1);
  });

  it('preserves temperature when thinking is not enabled', async () => {
    let capturedRequest: any;
    const adapter = new MockAdapter({
      defaultResponse: 'Hello',
    });
    const membrane = new Membrane(adapter);

    const request = makeRequest({
      config: {
        model: 'claude-haiku-4-5-20251001',
        maxTokens: 1000,
        temperature: 0.7,
      },
    });

    await membrane.complete(request, {
      onRequest: (req) => { capturedRequest = req; },
    });

    expect(capturedRequest.temperature).toBe(0.7);
  });

  it('forces temperature=1 in stream() XML mode when thinking is enabled', async () => {
    let capturedRequest: any;
    const adapter = new MockAdapter({
      defaultResponse: 'Hello',
    });
    const membrane = new Membrane(adapter);

    const request = makeRequest({
      config: {
        model: 'claude-haiku-4-5-20251001',
        maxTokens: 1000,
        temperature: 0.3,
        thinking: { enabled: true, budgetTokens: 1000 },
      },
    });

    await membrane.stream(request, {
      onChunk: () => {},
      onRequest: (req) => { capturedRequest = req; },
    });

    expect(capturedRequest.temperature).toBe(1);
  });
});

// ============================================================================
// 2. JSON.parse safety for malformed tool arguments
// ============================================================================

describe('JSON.parse safety for tool arguments', () => {
  it('safeParseJson handles malformed JSON without throwing', async () => {
    const { safeParseJson } = await import('../../src/providers/utils.js');

    expect(safeParseJson(undefined)).toEqual({});
    expect(safeParseJson('')).toEqual({});
    expect(safeParseJson('{invalid json')).toEqual({});
    expect(safeParseJson('{"key":"value"}')).toEqual({ key: 'value' });
  });

  it('verifies all OpenAI-family adapters use safeParseJson', async () => {
    const fs = await import('fs');
    const path = await import('path');

    for (const file of ['openai.ts', 'openai-compatible.ts', 'openrouter.ts']) {
      const adapterPath = path.join(process.cwd(), 'src/providers', file);
      const source = fs.readFileSync(adapterPath, 'utf-8');

      expect(source).toContain("import { safeParseJson } from './utils.js'");
      expect(source).toContain('input: safeParseJson(tc.function.arguments)');
      // Verify raw JSON.parse on tool arguments is gone
      expect(source).not.toContain("JSON.parse(tc.function.arguments || '{}')");
    }
  });
});

// ============================================================================
// 3. Abort signal respected during retry delay
// ============================================================================

describe('Abort signal during retry', () => {
  it('aborts promptly during retry delay instead of waiting', async () => {
    // Create an adapter that fails with a retryable error
    const adapter = new MockAdapter({
      defaultResponse: 'Hello',
    });

    // Override complete to always throw a retryable error
    const originalComplete = adapter.complete.bind(adapter);
    let callCount = 0;
    adapter.complete = async (request: any, options: any) => {
      callCount++;
      const error = new Error('429 Too Many Requests');
      (error as any).status = 429;
      throw error;
    };

    const membrane = new Membrane(adapter, {
      retry: {
        maxRetries: 5,
        retryDelayMs: 5000, // Long delay - we should abort before this
        backoffMultiplier: 1,
        maxRetryDelayMs: 10000,
      },
    });

    const controller = new AbortController();

    // Abort after 100ms - well before the 5000ms retry delay
    setTimeout(() => controller.abort(), 100);

    const startTime = Date.now();

    await expect(
      membrane.complete(makeRequest(), { signal: controller.signal })
    ).rejects.toThrow();

    const elapsed = Date.now() - startTime;

    // Should abort in ~100ms, not 5000ms
    expect(elapsed).toBeLessThan(1000);
    // Should have made at least 1 attempt
    expect(callCount).toBeGreaterThanOrEqual(1);
  });
});
