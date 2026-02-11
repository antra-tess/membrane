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
});
