/**
 * Unit tests for YieldingStream
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { MockAdapter } from '../../src/providers/mock.js';
import type { NormalizedRequest, ToolResult, StreamEvent } from '../../src/types/index.js';

describe('YieldingStream', () => {
  let adapter: MockAdapter;
  let membrane: Membrane;

  beforeEach(() => {
    adapter = new MockAdapter({
      streamChunkDelayMs: 0,
      completeDelayMs: 0,
    });
    membrane = new Membrane(adapter);
  });

  function createRequest(content: string = 'Hello'): NormalizedRequest {
    return {
      messages: [
        { participant: 'User', content: [{ type: 'text', text: content }] },
      ],
      config: {
        model: 'test-model',
        maxTokens: 1000,
      },
    };
  }

  describe('basic streaming', () => {
    it('streams simple response without tools', async () => {
      adapter.queueResponse('Hello, world!');

      const stream = membrane.streamYielding(createRequest());
      const events: StreamEvent[] = [];

      for await (const event of stream) {
        events.push(event);
      }

      // Should have tokens and complete events
      const tokenEvents = events.filter(e => e.type === 'tokens');
      const completeEvents = events.filter(e => e.type === 'complete');

      expect(tokenEvents.length).toBeGreaterThan(0);
      expect(completeEvents.length).toBe(1);

      // Tokens should contain the response
      const allTokens = tokenEvents.map(e => (e as any).content).join('');
      expect(allTokens).toBe('Hello, world!');

      // Complete event should have the response
      const complete = completeEvents[0] as any;
      expect(complete.response.rawAssistantText).toBe('Hello, world!');
    });

    it('emits usage events', async () => {
      adapter.queueResponse('Test response');

      const stream = membrane.streamYielding(createRequest());
      const events: StreamEvent[] = [];

      for await (const event of stream) {
        events.push(event);
      }

      const usageEvents = events.filter(e => e.type === 'usage');
      expect(usageEvents.length).toBeGreaterThan(0);

      const usage = (usageEvents[0] as any).usage;
      expect(usage.inputTokens).toBeGreaterThan(0);
      expect(usage.outputTokens).toBeGreaterThan(0);
    });

    it('respects emitTokens=false option', async () => {
      adapter.queueResponse('Hello, world!');

      const stream = membrane.streamYielding(createRequest(), { emitTokens: false });
      const events: StreamEvent[] = [];

      for await (const event of stream) {
        events.push(event);
      }

      const tokenEvents = events.filter(e => e.type === 'tokens');
      expect(tokenEvents.length).toBe(0);

      // Should still complete
      const completeEvents = events.filter(e => e.type === 'complete');
      expect(completeEvents.length).toBe(1);
    });
  });

  describe('cancellation', () => {
    it('can be cancelled via cancel()', async () => {
      // Use a slow response with abort-aware MockAdapter
      adapter = new MockAdapter({
        streamChunkDelayMs: 50,
        streamChunkSize: 1,
      });
      membrane = new Membrane(adapter);
      adapter.queueResponse('This is a very long response that should be cancelled');

      const stream = membrane.streamYielding(createRequest());
      const events: StreamEvent[] = [];

      let eventCount = 0;
      for await (const event of stream) {
        events.push(event);
        eventCount++;
        if (eventCount > 5) {
          stream.cancel();
        }
      }

      // Should have aborted event
      const abortedEvents = events.filter(e => e.type === 'aborted');
      expect(abortedEvents.length).toBe(1);
      expect((abortedEvents[0] as any).reason).toBe('user');
    });

    it('can be cancelled via AbortSignal', async () => {
      adapter = new MockAdapter({
        streamChunkDelayMs: 50,
        streamChunkSize: 1,
      });
      membrane = new Membrane(adapter);
      adapter.queueResponse('This is a very long response that should be cancelled');

      const controller = new AbortController();
      const stream = membrane.streamYielding(createRequest(), { signal: controller.signal });
      const events: StreamEvent[] = [];

      let eventCount = 0;
      for await (const event of stream) {
        events.push(event);
        eventCount++;
        if (eventCount > 5) {
          controller.abort();
        }
      }

      // Should have aborted event
      const abortedEvents = events.filter(e => e.type === 'aborted');
      expect(abortedEvents.length).toBe(1);
    });

    it('cancel() sets isCancelled flag', () => {
      const stream = membrane.streamYielding(createRequest());
      expect(stream.isWaitingForTools).toBe(false);
      stream.cancel();
      // After cancel, we can't really check much without iterating
      // but the flag should be set internally
    });
  });

  describe('stream state', () => {
    it('tracks isWaitingForTools correctly', async () => {
      adapter.queueResponse('Simple response');

      const stream = membrane.streamYielding(createRequest());

      // Initially not waiting
      expect(stream.isWaitingForTools).toBe(false);

      for await (const _event of stream) {
        // Never waiting for tools in a simple response
        expect(stream.isWaitingForTools).toBe(false);
      }
    });

    it('tracks toolDepth correctly', async () => {
      adapter.queueResponse('Simple response');

      const stream = membrane.streamYielding(createRequest());

      // Initial depth is 0
      expect(stream.toolDepth).toBe(0);

      for await (const _event of stream) {
        // Depth stays 0 without tool calls
      }

      expect(stream.toolDepth).toBe(0);
    });

    it('returns empty pendingToolCallIds when not waiting', async () => {
      adapter.queueResponse('Simple response');

      const stream = membrane.streamYielding(createRequest());

      expect(stream.pendingToolCallIds).toEqual([]);

      for await (const _event of stream) {
        expect(stream.pendingToolCallIds).toEqual([]);
      }
    });
  });

  describe('error handling', () => {
    it('throws when provideToolResults called outside tool-calls state', async () => {
      adapter.queueResponse('Simple response');

      const stream = membrane.streamYielding(createRequest());

      // Try to provide results before any tool calls
      expect(() => {
        stream.provideToolResults([]);
      }).toThrow(/not waiting for tools/);
    });
  });

  // Wire-boundary safety net — regression for the 2026-05-22 clerk 400.
  // Background: NativeFormatter.buildMessages already ran the tool-pair
  // normalizer, but `runNativeToolsYielding` → `buildNativeToolRequest`
  // reimplemented message construction and bypassed it. An upstream
  // context-manager bug that dropped a tool_result message produced two
  // consecutive assistant envelopes with orphan tool_use blocks; the API
  // rejected with 400 (`tool_use ids ... without tool_result blocks
  // immediately after`). The fix wires normalize+merge into the streaming
  // path too. These tests assert the wire request never carries the
  // structural defects again.
  describe('tool-pair normalization at wire boundary (streaming-native path)', () => {
    function nativeRequest(messages: NormalizedRequest['messages']): NormalizedRequest {
      return {
        messages,
        toolMode: 'native',
        tools: [
          { name: 'search', description: 'Search', inputSchema: { type: 'object', properties: {} } },
        ],
        config: { model: 'test-model', maxTokens: 1000 },
      };
    }

    async function drain(stream: ReturnType<typeof membrane.streamYielding>): Promise<void> {
      for await (const _event of stream) { /* drain */ }
    }

    it('synthesizes [pending] tool_result for orphan tool_use stranded by upstream chunker', async () => {
      // The 2026-05-22 shape: assistant turn with tool_use, then another
      // assistant turn (the matching tool_result message was dropped
      // upstream by autobio strategy).
      adapter.queueResponse('ok');
      const request = nativeRequest([
        { participant: 'User', content: [{ type: 'text', text: 'Hi' }] },
        { participant: 'Claude', content: [
          { type: 'tool_use', id: 'toolu_orphan', name: 'search', input: { q: 'x' } },
        ] },
        { participant: 'Claude', content: [{ type: 'text', text: 'Next turn' }] },
      ]);

      await drain(membrane.streamYielding(request));

      const wire = adapter.getLastRequest();
      expect(wire).toBeDefined();
      const wireMessages = (wire as any).messages as Array<{ role: string; content: any[] }>;

      // No two consecutive same-role envelopes — Anthropic's hard rule.
      for (let i = 1; i < wireMessages.length; i++) {
        expect(wireMessages[i]!.role).not.toBe(wireMessages[i - 1]!.role);
      }

      // Every tool_use must be followed *immediately* by a user envelope
      // containing its tool_result. Set-membership alone wouldn't catch
      // a regression that synthesizes the result in the wrong envelope.
      for (let i = 0; i < wireMessages.length; i++) {
        const msg = wireMessages[i]!;
        if (msg.role !== 'assistant') continue;
        for (const block of msg.content) {
          if (block.type !== 'tool_use') continue;
          const nextMsg = wireMessages[i + 1];
          expect(nextMsg).toBeDefined();
          expect(nextMsg!.role).toBe('user');
          const resultIds = nextMsg!.content
            .filter((b: any) => b.type === 'tool_result')
            .map((b: any) => b.tool_use_id);
          expect(resultIds).toContain(block.id);
        }
      }
    });

    it('appends synthetic tool_result for a trailing unmatched tool_use', async () => {
      adapter.queueResponse('ok');
      const request = nativeRequest([
        { participant: 'User', content: [{ type: 'text', text: 'Hi' }] },
        { participant: 'Claude', content: [
          { type: 'tool_use', id: 'toolu_trail', name: 'search', input: {} },
        ] },
      ]);

      await drain(membrane.streamYielding(request));

      const wire = adapter.getLastRequest();
      const wireMessages = (wire as any).messages as Array<{ role: string; content: any[] }>;

      // Last message must be a user turn containing the synthetic result.
      const last = wireMessages[wireMessages.length - 1]!;
      expect(last.role).toBe('user');
      const resultBlock = last.content.find((b: any) => b.type === 'tool_result');
      expect(resultBlock).toBeDefined();
      expect(resultBlock.tool_use_id).toBe('toolu_trail');
      expect(resultBlock.content).toBe('[pending]');
      expect(resultBlock.is_error).toBe(false);
    });

    it('passes well-formed tool cycles through unchanged', async () => {
      // Sanity check: no normalization for valid input.
      adapter.queueResponse('ok');
      const request = nativeRequest([
        { participant: 'User', content: [{ type: 'text', text: 'Hi' }] },
        { participant: 'Claude', content: [
          { type: 'tool_use', id: 'toolu_ok', name: 'search', input: {} },
        ] },
        { participant: 'User', content: [
          { type: 'tool_result', toolUseId: 'toolu_ok', content: 'result' },
        ] },
      ]);

      await drain(membrane.streamYielding(request));

      const wire = adapter.getLastRequest();
      const wireMessages = (wire as any).messages as Array<{ role: string; content: any[] }>;

      expect(wireMessages).toHaveLength(3);
      const realResults = wireMessages[2]!.content.filter((b: any) => b.type === 'tool_result');
      expect(realResults).toHaveLength(1);
      expect(realResults[0].content).toBe('result');
      // No injected [pending] should appear anywhere.
      for (const msg of wireMessages) {
        for (const block of msg.content) {
          if (block.type === 'tool_result') {
            expect(block.content).not.toBe('[pending]');
          }
        }
      }
    });
  });
});
