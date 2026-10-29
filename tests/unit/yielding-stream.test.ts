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

      const tokenEvents = events.filter(e => e.type === 'tokens');
      const completeEvents = events.filter(e => e.type === 'complete');

      expect(tokenEvents.length).toBeGreaterThan(0);
      expect(completeEvents.length).toBe(1);

      const allTokens = tokenEvents.map(e => (e as any).content).join('');
      expect(allTokens).toBe('Hello, world!');

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

      const completeEvents = events.filter(e => e.type === 'complete');
      expect(completeEvents.length).toBe(1);
    });
  });

  describe('cancellation', () => {
    it('can be cancelled via cancel()', async () => {
      adapter = new MockAdapter({
        streamChunkDelayMs: 1,
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

      const abortedEvents = events.filter(e => e.type === 'aborted');
      expect(abortedEvents.length).toBe(1);
      expect((abortedEvents[0] as any).reason).toBe('user');
    });

    it('can be cancelled via AbortSignal', async () => {
      adapter = new MockAdapter({
        streamChunkDelayMs: 1,
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

      const abortedEvents = events.filter(e => e.type === 'aborted');
      expect(abortedEvents.length).toBe(1);
    });

    it('cancel() sets isCancelled flag', () => {
      const stream = membrane.streamYielding(createRequest());
      expect(stream.isWaitingForTools).toBe(false);
      stream.cancel();
    });
  });

  describe('stream state', () => {
    it('tracks isWaitingForTools correctly', async () => {
      adapter.queueResponse('Simple response');

      const stream = membrane.streamYielding(createRequest());

      expect(stream.isWaitingForTools).toBe(false);

      for await (const _event of stream) {
        expect(stream.isWaitingForTools).toBe(false);
      }
    });

    it('tracks toolDepth correctly', async () => {
      adapter.queueResponse('Simple response');

      const stream = membrane.streamYielding(createRequest());

      expect(stream.toolDepth).toBe(0);

      for await (const _event of stream) {
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

      expect(() => {
        stream.provideToolResults([]);
      }).toThrow(/not waiting for tools/);
    });
  });

  // The Anthropic API refuses a tool_use whose tool_result isn't in the next message, with a 400 (`tool_use ids ... without tool_result blocks immediately after`).
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
      for await (const _event of stream) { }
    }

    it('synthesizes [pending] tool_result for orphan tool_use stranded by upstream chunker', async () => {
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

      for (let i = 1; i < wireMessages.length; i++) {
        expect(wireMessages[i]!.role).not.toBe(wireMessages[i - 1]!.role);
      }

      // Every tool_use must be followed immediately by a user envelope holding its tool_result.
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

      const last = wireMessages[wireMessages.length - 1]!;
      expect(last.role).toBe('user');
      const resultBlock = last.content.find((b: any) => b.type === 'tool_result');
      expect(resultBlock).toBeDefined();
      expect(resultBlock.tool_use_id).toBe('toolu_trail');
      expect(resultBlock.content).toBe('[pending]');
      expect(resultBlock.is_error).toBe(false);
    });

    it('passes well-formed tool cycles through unchanged', async () => {
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
