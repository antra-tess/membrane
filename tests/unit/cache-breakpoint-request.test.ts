/**
 * Cache-breakpoint request structure: `cacheBreakpoint` on a normalized
 * message must surface as `cache_control` markers in the raw request.
 * Converted from the legacy tsx script test/cache-breakpoint-request.test.ts
 * (pre-vitest layout, never ran in CI).
 */

import { describe, it, expect } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { MockAdapter } from '../../src/providers/mock.js';
import { NativeFormatter } from '../../src/formatters/native.js';
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

// Imported/seeded conversations can carry stale request-time cache_control on
// stored text blocks (Arc exports do). On the NATIVE path those blocks are
// passed through verbatim, so membrane must COUNT them as message breakpoints
// and skip its own system/tools fallback — that addition is the part membrane
// controls. Membrane deliberately does NOT strip excess markers: >4 is a data
// defect (fix it at ingest), and a loud 400 beats silently dropping someone's
// cache breakpoints. First seen live: Sill 2026-07-25, 3 markers + 2 stale
// = 5 -> 400 on every inference; root cause fixed in the ingest converter.
// Ported from the legacy test/ addition in PR #41, which predated this suite.
describe('block-level cache_control passthrough (native path)', () => {
  it('preserves passthroughs verbatim and counts them, suppressing the system fallback', () => {
    const staleCache = { type: 'ephemeral', ttl: '1h' };
    const formatter = new NativeFormatter();
    const built = formatter.buildMessages(
      [
        { participant: 'User', content: [{ type: 'text', text: 'stale one', cache_control: staleCache } as any] },
        createMessage('Claude', 'reply'),
        { participant: 'User', content: [{ type: 'text', text: 'stale two', cache_control: staleCache } as any] },
        createMessage('Claude', 'reply'),
      ],
      {
        assistantParticipant: 'Claude',
        participantMode: 'multiuser',
        systemPrompt: 'You are helpful.',
        promptCaching: true,
      } as any,
    );

    let messageBlockCount = 0;
    for (const msg of built.messages as any[]) {
      if (Array.isArray(msg.content)) {
        messageBlockCount += msg.content.filter((b: any) => b.cache_control).length;
      }
    }
    const systemCount = Array.isArray(built.system)
      ? (built.system as any[]).filter((b: any) => b.cache_control).length
      : 0;

    // Passthroughs are preserved verbatim — membrane never strips them.
    expect(messageBlockCount).toBe(2);
    // ...and they count, so membrane adds no redundant system/tools breakpoint.
    expect(systemCount).toBe(0);
  });
});
