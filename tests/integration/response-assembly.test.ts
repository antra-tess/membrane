/**
 * Integration tests for response assembly
 *
 * These tests would have caught:
 * - v0.1.5: Prefill content leaking into response.content
 * - v0.1.6: Duplicate text blocks
 */

import { describe, it, expect, vi } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import type { ProviderAdapter, ProviderRequest, ProviderResponse, StreamCallbacks, NormalizedRequest } from '../../src/types/index.js';

/**
 * Create a mock adapter that returns predetermined responses
 */
function createMockAdapter(options: {
  streamChunks?: string[];
  completeResponse?: Partial<ProviderResponse>;
}): ProviderAdapter {
  return {
    name: 'mock',
    supportsModel: () => true,

    async complete(request: ProviderRequest): Promise<ProviderResponse> {
      const response = options.completeResponse ?? {
        content: [{ type: 'text', text: 'Mock response' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5 },
        model: 'mock-model',
        raw: { content: [{ type: 'text', text: 'Mock response' }] },
      };
      return {
        content: response.content ?? [{ type: 'text', text: 'Mock response' }],
        stopReason: response.stopReason ?? 'end_turn',
        usage: response.usage ?? { inputTokens: 10, outputTokens: 5 },
        model: response.model ?? 'mock-model',
        rawRequest: request,
        raw: response.raw ?? {},
      } as ProviderResponse;
    },

    async stream(request: ProviderRequest, callbacks: StreamCallbacks): Promise<ProviderResponse> {
      const chunks = options.streamChunks ?? ['Hello ', 'world'];
      let accumulated = '';

      for (const chunk of chunks) {
        accumulated += chunk;
        callbacks.onChunk(chunk);
      }

      return {
        content: [{ type: 'text', text: accumulated }],
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: chunks.length },
        model: 'mock-model',
        rawRequest: request,
        raw: { content: [{ type: 'text', text: accumulated }] },
      } as ProviderResponse;
    },
  };
}

/**
 * Create a standard multi-turn request for testing
 */
function createMultiTurnRequest(): NormalizedRequest {
  return {
    messages: [
      {
        participant: 'User',
        content: [{ type: 'text', text: 'Hello, how are you?' }],
      },
      {
        participant: 'Claude',
        content: [{ type: 'text', text: 'I am doing well, thank you!' }],
      },
      {
        participant: 'User',
        content: [{ type: 'text', text: 'What is the weather like?' }],
      },
    ],
    config: {
      model: 'claude-sonnet-4-20250514',
      maxTokens: 1000,
    },
  };
}

describe('Response Assembly', () => {
  describe('content should only contain NEW content, not prefill', () => {
    it('should not include input messages in response.content', async () => {
      const apiResponse = 'The weather is sunny today.';
      const adapter = createMockAdapter({
        streamChunks: [apiResponse],
      });
      const membrane = new Membrane(adapter);
      const request = createMultiTurnRequest();

      const result = await membrane.stream(request);

      // Check that content doesn't contain input messages
      const contentText = result.content
        .filter(b => b.type === 'text')
        .map(b => (b as any).text)
        .join('');

      expect(contentText).not.toContain('Hello, how are you?');
      expect(contentText).not.toContain('I am doing well');
      expect(contentText).not.toContain('What is the weather');

      // Should contain the actual response
      expect(contentText).toContain('weather is sunny');
    });

    it('should not include participant prefixes in response.content', async () => {
      const adapter = createMockAdapter({
        streamChunks: ['Here is my response.'],
      });
      const membrane = new Membrane(adapter);
      const request = createMultiTurnRequest();

      const result = await membrane.stream(request);

      const contentText = result.content
        .filter(b => b.type === 'text')
        .map(b => (b as any).text)
        .join('');

      // Should not contain prefill participant markers
      expect(contentText).not.toContain('User:');
      expect(contentText).not.toContain('Claude:');
    });

    it('rawAssistantText should equal concatenated chunks', async () => {
      const chunks = ['First ', 'second ', 'third.'];
      const adapter = createMockAdapter({ streamChunks: chunks });
      const membrane = new Membrane(adapter);

      const receivedChunks: string[] = [];
      const result = await membrane.stream(createMultiTurnRequest(), {
        onChunk: (chunk) => receivedChunks.push(chunk),
      });

      // rawAssistantText should match what was chunked
      expect(result.rawAssistantText).toBe(chunks.join(''));
    });
  });

  describe('content block count invariants', () => {
    it('INVARIANT: should not have duplicate text blocks', async () => {
      const adapter = createMockAdapter({
        streamChunks: ['Single response text'],
      });
      const membrane = new Membrane(adapter);

      const result = await membrane.stream(createMultiTurnRequest());

      const textBlocks = result.content.filter(b => b.type === 'text');

      // Should have exactly one text block, not duplicates
      expect(textBlocks.length).toBe(1);
    });

    it('INVARIANT: text content should not be duplicated', async () => {
      const responseText = 'This is a unique response.';
      const adapter = createMockAdapter({
        streamChunks: [responseText],
      });
      const membrane = new Membrane(adapter);

      const result = await membrane.stream(createMultiTurnRequest());

      // Count occurrences of the response text
      const fullContent = result.content
        .filter(b => b.type === 'text')
        .map(b => (b as any).text)
        .join('|||'); // separator to see duplicates

      const occurrences = (fullContent.match(/unique response/g) || []).length;
      expect(occurrences).toBe(1);
    });
  });

  describe('raw request/response accuracy', () => {
    it('onRequest should receive actual provider request format', async () => {
      const adapter = createMockAdapter({});
      const membrane = new Membrane(adapter);

      let capturedRequest: unknown;
      await membrane.stream(createMultiTurnRequest(), {
        onRequest: (req) => { capturedRequest = req; },
      });

      // Should have provider-specific fields
      expect(capturedRequest).toBeDefined();
      expect(capturedRequest).toHaveProperty('model');
      expect(capturedRequest).toHaveProperty('messages');
    });

    it('raw.request should match onRequest callback', async () => {
      const adapter = createMockAdapter({});
      const membrane = new Membrane(adapter);

      let capturedRequest: unknown;
      const result = await membrane.stream(createMultiTurnRequest(), {
        onRequest: (req) => { capturedRequest = req; },
      });

      expect(result.raw.request).toEqual(capturedRequest);
    });
  });
});

describe('Response with thinking blocks', () => {
  it('should parse thinking from streamed content', async () => {
    const adapter = createMockAdapter({
      streamChunks: ['<thinking>Let me think...</thinking>Here is my answer.'],
    });
    const membrane = new Membrane(adapter);

    const result = await membrane.stream(createMultiTurnRequest());

    const thinkingBlocks = result.content.filter(b => b.type === 'thinking');
    const textBlocks = result.content.filter(b => b.type === 'text');

    expect(thinkingBlocks.length).toBe(1);
    expect(textBlocks.length).toBe(1);
    expect((thinkingBlocks[0] as any).thinking).toBe('Let me think...');
    expect((textBlocks[0] as any).text).toBe('Here is my answer.');
  });

  it('should not duplicate thinking blocks', async () => {
    const adapter = createMockAdapter({
      streamChunks: ['<thinking>Thoughts</thinking>Response'],
    });
    const membrane = new Membrane(adapter);

    const result = await membrane.stream(createMultiTurnRequest());

    const thinkingBlocks = result.content.filter(b => b.type === 'thinking');
    expect(thinkingBlocks.length).toBe(1);
  });
});

describe('Edge cases', () => {
  it('should handle empty response', async () => {
    const adapter = createMockAdapter({
      streamChunks: [''],
    });
    const membrane = new Membrane(adapter);

    const result = await membrane.stream(createMultiTurnRequest());

    // Should not crash, content may be empty
    expect(result.content).toBeDefined();
  });

  it('should handle whitespace-only response', async () => {
    const adapter = createMockAdapter({
      streamChunks: ['   \n\n   '],
    });
    const membrane = new Membrane(adapter);

    const result = await membrane.stream(createMultiTurnRequest());

    // Should handle gracefully
    expect(result.content).toBeDefined();
  });

  it('should handle very long conversation history', async () => {
    const adapter = createMockAdapter({
      streamChunks: ['Short response'],
    });
    const membrane = new Membrane(adapter);

    // Build a long conversation
    const messages = [];
    for (let i = 0; i < 50; i++) {
      messages.push({
        participant: i % 2 === 0 ? 'User' : 'Claude',
        content: [{ type: 'text' as const, text: `Message ${i}: ${'x'.repeat(100)}` }],
      });
    }

    const request: NormalizedRequest = {
      messages,
      config: { model: 'claude-sonnet-4-20250514', maxTokens: 1000 },
    };

    const result = await membrane.stream(request);

    // Response should only contain the new content
    expect(result.rawAssistantText).toBe('Short response');

    // Should not contain any of the history
    const contentText = result.content
      .filter(b => b.type === 'text')
      .map(b => (b as any).text)
      .join('');

    expect(contentText).not.toContain('Message 0');
    expect(contentText).not.toContain('Message 49');
  });
});
