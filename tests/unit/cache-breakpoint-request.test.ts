/**
 * Cache-breakpoint request structure: `cacheBreakpoint` on a normalized
 * message must surface as `cache_control` markers in the raw request.
 * Converted from the legacy tsx script test/cache-breakpoint-request.test.ts
 * (pre-vitest layout, never ran in CI).
 */

import { describe, it, expect } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { MockAdapter } from '../../src/providers/mock.js';
import type { NormalizedRequest, NormalizedMessage } from '../../src/types/index.js';

function createMessage(participant: string, text: string): NormalizedMessage {
  return { participant, content: [{ type: 'text', text }] };
}

interface RawBlock {
  cache_control?: unknown;
  text?: string;
}
interface RawRequest {
  system?: unknown;
  messages?: Array<{ role: string; content: string | RawBlock[] }>;
}

async function captureRawRequest(request: NormalizedRequest): Promise<RawRequest> {
  const adapter = new MockAdapter();
  adapter.queueResponse('Test response');
  const membrane = new Membrane(adapter);
  let rawRequest: RawRequest | null = null;
  await membrane.complete(request, {
    onRequest: (req) => {
      rawRequest = req as RawRequest;
    },
  });
  expect(rawRequest).not.toBeNull();
  return rawRequest!;
}

function countCachedMessages(raw: RawRequest): number {
  let count = 0;
  for (const msg of raw.messages ?? []) {
    if (Array.isArray(msg.content) && msg.content.some((b) => b.cache_control)) count++;
  }
  return count;
}

describe('cacheBreakpoint → cache_control in the raw request', () => {
  it('marks the system prompt and the breakpoint message', async () => {
    const raw = await captureRawRequest({
      messages: [
        createMessage('User', 'First message'),
        { ...createMessage('Claude', 'First response'), cacheBreakpoint: true },
        createMessage('User', 'Second message'),
        createMessage('Claude', ''),
      ],
      system: 'You are helpful.',
      config: { model: 'test', maxTokens: 100 },
    });
    const system = raw.system;
    expect(Array.isArray(system) && (system as RawBlock[]).some((b) => b.cache_control)).toBe(true);
    expect(countCachedMessages(raw)).toBeGreaterThanOrEqual(1);
  });

  it('supports multiple breakpoints', async () => {
    const raw = await captureRawRequest({
      messages: [
        createMessage('User', 'Context message 1'),
        { ...createMessage('Claude', 'Context response 1'), cacheBreakpoint: true },
        createMessage('User', 'Context message 2'),
        { ...createMessage('Claude', 'Context response 2'), cacheBreakpoint: true },
        createMessage('User', 'Context message 3'),
        { ...createMessage('Claude', 'Context response 3'), cacheBreakpoint: true },
        createMessage('User', 'Current question'),
        createMessage('Claude', ''),
      ],
      system: 'You are helpful.',
      config: { model: 'test', maxTokens: 100 },
    });
    expect(countCachedMessages(raw)).toBeGreaterThanOrEqual(3);
  });

  it('caches the breakpoint message even with no system prompt', async () => {
    const raw = await captureRawRequest({
      messages: [
        createMessage('User', 'Message'),
        { ...createMessage('Claude', 'Response'), cacheBreakpoint: true },
        createMessage('User', 'Question'),
        createMessage('Claude', ''),
      ],
      config: { model: 'test', maxTokens: 100 },
    });
    expect(countCachedMessages(raw)).toBeGreaterThanOrEqual(1);
  });

  it('the cache span covers the breakpoint message and everything before it', async () => {
    const raw = await captureRawRequest({
      messages: [
        createMessage('User', 'MARKER_BEFORE'),
        { ...createMessage('Claude', 'MARKER_CACHED'), cacheBreakpoint: true },
        createMessage('User', 'MARKER_AFTER'),
        createMessage('Claude', ''),
      ],
      system: 'System prompt',
      config: { model: 'test', maxTokens: 100 },
    });
    let cachedContent = '';
    for (const msg of raw.messages ?? []) {
      if (!Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (block.cache_control && block.text) cachedContent += block.text;
      }
    }
    expect(cachedContent).toContain('MARKER_CACHED');
    expect(cachedContent).toContain('MARKER_BEFORE');
  });
});
