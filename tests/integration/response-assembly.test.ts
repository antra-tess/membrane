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

    async complete(request: ProviderRequest, reqOptions?: { onRequest?: (req: unknown) => void }): Promise<ProviderResponse> {
      reqOptions?.onRequest?.(request);
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

    async stream(request: ProviderRequest, callbacks: StreamCallbacks, reqOptions?: { onRequest?: (req: unknown) => void }): Promise<ProviderResponse> {
      reqOptions?.onRequest?.(request);
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
 * Create a multi-call mock adapter for tool execution tests
 */
function createMultiCallAdapter(responses: Array<{
  chunks: string[];
  stopReason: string;
  stopSequence?: string;
}>): ProviderAdapter {
  let callIndex = 0;

  return {
    name: 'mock',
    supportsModel: () => true,
    async complete(request: ProviderRequest, reqOptions?: { onRequest?: (req: unknown) => void }): Promise<ProviderResponse> {
      reqOptions?.onRequest?.(request);
      return {
        content: [{ type: 'text', text: 'Mock' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5 },
        model: 'mock-model',
        rawRequest: request,
        raw: {},
      } as ProviderResponse;
    },
    async stream(request: ProviderRequest, callbacks: StreamCallbacks, reqOptions?: { onRequest?: (req: unknown) => void }): Promise<ProviderResponse> {
      reqOptions?.onRequest?.(request);
      const response = responses[callIndex] ?? responses[responses.length - 1];
      callIndex++;

      let accumulated = '';
      for (const chunk of response.chunks) {
        accumulated += chunk;
        callbacks.onChunk(chunk);
      }

      return {
        content: [{ type: 'text', text: accumulated }],
        stopReason: response.stopReason,
        stopSequence: response.stopSequence,
        usage: { inputTokens: 10, outputTokens: response.chunks.length },
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

describe('Multi-request logging', () => {
  it('should call onRequest for each API request during tool execution', async () => {
    const capturedRequests: unknown[] = [];

    // Build XML strings by parts to avoid escaping issues
    const fnCallsOpen = '<function_calls>';
    const fnCallsClose = '</function_calls>';
    const invokeOpen = '<invoke name="test_tool">';
    const invokeClose = '</invoke>';
    const paramOpen = '<parameter name="param">';
    const paramClose = '</parameter>';

    const toolCallXml = [
      fnCallsOpen,
      '\n',
      invokeOpen,
      '\n',
      paramOpen, 'value', paramClose,
      '\n',
      invokeClose,
      '\n',
    ].join('');

    // Create adapter that simulates tool execution (2 API calls)
    const adapter = createMultiCallAdapter([
      // First call: return tool call that stops at </function_calls>
      { chunks: [toolCallXml], stopReason: 'stop_sequence', stopSequence: fnCallsClose },
      // Second call: return final response
      { chunks: ['Done with the tool.'], stopReason: 'end_turn' },
    ]);

    const membrane = new Membrane(adapter);
    const request = createMultiTurnRequest();

    await membrane.stream(request, {
      onRequest: (req) => { capturedRequests.push(req); },
      onToolCalls: async (calls) => {
        // Return mock tool results
        return calls.map(call => ({
          toolUseId: call.id,
          content: 'Tool result',
        }));
      },
    });

    // Should have captured 2 requests (initial + continuation after tool)
    expect(capturedRequests.length).toBe(2);

    // Both should have different messages (second has accumulated content)
    expect(capturedRequests[0]).not.toEqual(capturedRequests[1]);
  });

  it('should call onResponse for each API response during tool execution', async () => {
    const capturedResponses: unknown[] = [];

    const fnCallsOpen = '<function_calls>';
    const fnCallsClose = '</function_calls>';
    const invokeOpen = '<invoke name="test_tool">';
    const invokeClose = '</invoke>';
    const paramOpen = '<parameter name="param">';
    const paramClose = '</parameter>';

    const toolCallXml = [
      fnCallsOpen, '\n', invokeOpen, '\n',
      paramOpen, 'value', paramClose, '\n',
      invokeClose, '\n',
    ].join('');

    const adapter = createMultiCallAdapter([
      { chunks: [toolCallXml], stopReason: 'stop_sequence', stopSequence: fnCallsClose },
      { chunks: ['Done.'], stopReason: 'end_turn' },
    ]);

    const membrane = new Membrane(adapter);

    await membrane.stream(createMultiTurnRequest(), {
      onResponse: (res) => { capturedResponses.push(res); },
      onToolCalls: async (calls) => {
        return calls.map(call => ({
          toolUseId: call.id,
          content: 'Tool result',
        }));
      },
    });

    // Should have captured 2 responses
    expect(capturedResponses.length).toBe(2);
  });

  it('should call onRequest multiple times for multi-tool execution', async () => {
    const capturedRequests: unknown[] = [];

    const fnCallsOpen = '<function_calls>';
    const fnCallsClose = '</function_calls>';
    const invokeOpen = '<invoke name="test_tool">';
    const invokeClose = '</invoke>';
    const paramOpen = '<parameter name="p">';
    const paramClose = '</parameter>';

    const toolCallXml = [fnCallsOpen, invokeOpen, paramOpen, 'v', paramClose, invokeClose].join('');

    // Create adapter that simulates 3 API calls (2 tool calls + final)
    const adapter = createMultiCallAdapter([
      { chunks: [toolCallXml], stopReason: 'stop_sequence', stopSequence: fnCallsClose },
      { chunks: [toolCallXml], stopReason: 'stop_sequence', stopSequence: fnCallsClose },
      { chunks: ['Final response.'], stopReason: 'end_turn' },
    ]);

    const membrane = new Membrane(adapter);

    await membrane.stream(createMultiTurnRequest(), {
      onRequest: (req) => { capturedRequests.push(req); },
      onToolCalls: async (calls) => {
        return calls.map(call => ({
          toolUseId: call.id,
          content: 'Tool result',
        }));
      },
    });

    // Should have captured 3 requests
    expect(capturedRequests.length).toBe(3);
  });

  it('should inject tool results into continuation request context', async () => {
    const capturedRequests: any[] = [];

    const fnCallsOpen = '<function_calls>';
    const fnCallsClose = '</function_calls>';
    const invokeOpen = '<invoke name="test_tool">';
    const invokeClose = '</invoke>';
    const paramOpen = '<parameter name="param">';
    const paramClose = '</parameter>';

    const toolCallXml = [
      fnCallsOpen, '\n', invokeOpen, '\n',
      paramOpen, 'test_value', paramClose, '\n',
      invokeClose, '\n',
    ].join('');

    const adapter = createMultiCallAdapter([
      { chunks: [toolCallXml], stopReason: 'stop_sequence', stopSequence: fnCallsClose },
      { chunks: ['Final response after tool.'], stopReason: 'end_turn' },
    ]);

    const membrane = new Membrane(adapter);

    await membrane.stream(createMultiTurnRequest(), {
      onRequest: (req) => { capturedRequests.push(req); },
      onToolCalls: async (calls) => {
        return calls.map(call => ({
          toolUseId: call.id,
          content: 'TOOL_EXECUTION_RESULT_12345',
        }));
      },
    });

    expect(capturedRequests.length).toBe(2);

    // The second request should contain the tool results in the assistant message
    const secondRequest = capturedRequests[1];
    const assistantMessages = secondRequest.messages.filter((m: any) => m.role === 'assistant');

    // Find the assistant message content (could be string or array)
    let assistantContent = '';
    for (const msg of assistantMessages) {
      if (typeof msg.content === 'string') {
        assistantContent += msg.content;
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text') {
            assistantContent += block.text;
          }
        }
      }
    }

    // Tool results should be in the continuation request
    expect(assistantContent).toContain('TOOL_EXECUTION_RESULT_12345');
    expect(assistantContent).toContain('<function_results>');
    expect(assistantContent).toContain('</function_results>');
  });

  it('should inject empty tool results into continuation request', async () => {
    const capturedRequests: any[] = [];

    const fnCallsOpen = '<function_calls>';
    const fnCallsClose = '</function_calls>';
    const invokeOpen = '<invoke name="test_tool">';
    const invokeClose = '</invoke>';
    const paramOpen = '<parameter name="param">';
    const paramClose = '</parameter>';

    const toolCallXml = [
      fnCallsOpen, '\n', invokeOpen, '\n',
      paramOpen, 'test_value', paramClose, '\n',
      invokeClose, '\n',
    ].join('');

    const adapter = createMultiCallAdapter([
      { chunks: [toolCallXml], stopReason: 'stop_sequence', stopSequence: fnCallsClose },
      { chunks: ['Final response.'], stopReason: 'end_turn' },
    ]);

    const membrane = new Membrane(adapter);

    await membrane.stream(createMultiTurnRequest(), {
      onRequest: (req) => { capturedRequests.push(req); },
      onToolCalls: async (calls) => {
        // Return empty string content for tool result
        return calls.map(call => ({
          toolUseId: call.id,
          content: '',  // Empty result
        }));
      },
    });

    expect(capturedRequests.length).toBe(2);

    // The second request should still contain function_results wrapper
    const secondRequest = capturedRequests[1];
    const assistantMessages = secondRequest.messages.filter((m: any) => m.role === 'assistant');

    let assistantContent = '';
    for (const msg of assistantMessages) {
      if (typeof msg.content === 'string') {
        assistantContent += msg.content;
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text') {
            assistantContent += block.text;
          }
        }
      }
    }

    // Even empty results should be wrapped in function_results
    expect(assistantContent).toContain('<function_results>');
    expect(assistantContent).toContain('</function_results>');
    expect(assistantContent).toContain('<result tool_use_id=');
  });

  it('should handle onToolCalls returning empty array', async () => {
    const capturedRequests: any[] = [];

    const fnCallsOpen = '<function_calls>';
    const fnCallsClose = '</function_calls>';
    const invokeOpen = '<invoke name="test_tool">';
    const invokeClose = '</invoke>';
    const paramOpen = '<parameter name="param">';
    const paramClose = '</parameter>';

    const toolCallXml = [
      fnCallsOpen, '\n', invokeOpen, '\n',
      paramOpen, 'test_value', paramClose, '\n',
      invokeClose, '\n',
    ].join('');

    const adapter = createMultiCallAdapter([
      { chunks: [toolCallXml], stopReason: 'stop_sequence', stopSequence: fnCallsClose },
      { chunks: ['Final response.'], stopReason: 'end_turn' },
    ]);

    const membrane = new Membrane(adapter);

    await membrane.stream(createMultiTurnRequest(), {
      onRequest: (req) => { capturedRequests.push(req); },
      onToolCalls: async () => {
        // Return empty array - no results at all
        return [];
      },
    });

    expect(capturedRequests.length).toBe(2);

    // Should still inject empty function_results
    const secondRequest = capturedRequests[1];
    const assistantMessages = secondRequest.messages.filter((m: any) => m.role === 'assistant');

    let assistantContent = '';
    for (const msg of assistantMessages) {
      if (typeof msg.content === 'string') {
        assistantContent += msg.content;
      }
    }

    expect(assistantContent).toContain('<function_results>');
    expect(assistantContent).toContain('</function_results>');
  });

  it('should emit onBlock events for tool calls and results', async () => {
    const blockEvents: any[] = [];

    const fnCallsOpen = '<function_calls>';
    const fnCallsClose = '</function_calls>';
    const invokeOpen = '<invoke name="test_tool">';
    const invokeClose = '</invoke>';
    const paramOpen = '<parameter name="param">';
    const paramClose = '</parameter>';

    const toolCallXml = [
      fnCallsOpen, '\n', invokeOpen, '\n',
      paramOpen, 'test_value', paramClose, '\n',
      invokeClose, '\n',
    ].join('');

    const adapter = createMultiCallAdapter([
      { chunks: [toolCallXml], stopReason: 'stop_sequence', stopSequence: fnCallsClose },
      { chunks: ['Final response.'], stopReason: 'end_turn' },
    ]);

    const membrane = new Membrane(adapter);

    await membrane.stream(createMultiTurnRequest(), {
      onBlock: (event) => { blockEvents.push(event); },
      onToolCalls: async (calls) => {
        return calls.map(call => ({
          toolUseId: call.id,
          content: 'Tool executed',
        }));
      },
    });

    // Should have block events for tool_call
    const toolCallStarts = blockEvents.filter(e => e.event === 'block_start' && e.block.type === 'tool_call');
    const toolCallCompletes = blockEvents.filter(e => e.event === 'block_complete' && e.block.type === 'tool_call');
    expect(toolCallStarts.length).toBeGreaterThanOrEqual(1);
    expect(toolCallCompletes.length).toBeGreaterThanOrEqual(1);

    // Find the tool call complete with parsed data (has toolName)
    // Note: there may be multiple tool_call block_complete events:
    // - One from streaming flush (has content, no toolName)
    // - One from parsed tool call (has toolName and input)
    const parsedToolCallComplete = toolCallCompletes.find(e => (e.block as any).toolName);
    expect(parsedToolCallComplete).toBeDefined();
    expect(parsedToolCallComplete!.block.toolName).toBe('test_tool');
    expect(parsedToolCallComplete!.block.input).toBeDefined();

    // Should have block events for tool_result
    const toolResultStarts = blockEvents.filter(e => e.event === 'block_start' && e.block.type === 'tool_result');
    const toolResultCompletes = blockEvents.filter(e => e.event === 'block_complete' && e.block.type === 'tool_result');
    expect(toolResultStarts.length).toBeGreaterThanOrEqual(1);
    expect(toolResultCompletes.length).toBeGreaterThanOrEqual(1);

    // Tool result complete should have content
    const toolResultComplete = toolResultCompletes[0];
    expect(toolResultComplete.block.content).toBe('Tool executed');
  });

  it('should add <thinking> tag after tool results when thinking is enabled', async () => {
    const capturedRequests: any[] = [];

    const fnCallsOpen = '<function_calls>';
    const fnCallsClose = '</function_calls>';
    const invokeOpen = '<invoke name="test_tool">';
    const invokeClose = '</invoke>';
    const paramOpen = '<parameter name="param">';
    const paramClose = '</parameter>';

    const toolCallXml = [
      fnCallsOpen, '\n', invokeOpen, '\n',
      paramOpen, 'test_value', paramClose, '\n',
      invokeClose, '\n',
    ].join('');

    const adapter = createMultiCallAdapter([
      { chunks: [toolCallXml], stopReason: 'stop_sequence', stopSequence: fnCallsClose },
      { chunks: ['More thinking</thinking>Final response.'], stopReason: 'end_turn' },
    ]);

    const membrane = new Membrane(adapter);

    // Request with thinking enabled
    const request: NormalizedRequest = {
      ...createMultiTurnRequest(),
      config: {
        model: 'claude-sonnet-4-20250514',
        maxTokens: 1000,
        thinking: { enabled: true },
      },
    };

    await membrane.stream(request, {
      onRequest: (req) => { capturedRequests.push(req); },
      onToolCalls: async (calls) => {
        return calls.map(call => ({
          toolUseId: call.id,
          content: 'Tool executed successfully',
        }));
      },
    });

    expect(capturedRequests.length).toBe(2);

    // The second request should have <thinking> after </function_results>
    const secondRequest = capturedRequests[1];
    const assistantMessages = secondRequest.messages.filter((m: any) => m.role === 'assistant');

    let assistantContent = '';
    for (const msg of assistantMessages) {
      if (typeof msg.content === 'string') {
        assistantContent += msg.content;
      }
    }

    // Should have thinking tag after function_results
    expect(assistantContent).toContain('</function_results>');
    expect(assistantContent).toContain('<thinking>');

    // The thinking tag should come AFTER function_results
    const resultsEnd = assistantContent.indexOf('</function_results>');
    const thinkingStart = assistantContent.lastIndexOf('<thinking>');
    expect(thinkingStart).toBeGreaterThan(resultsEnd);
  });

  it('should throw clear error when onToolCalls returns undefined', async () => {
    const fnCallsOpen = '<function_calls>';
    const fnCallsClose = '</function_calls>';
    const invokeOpen = '<invoke name="test_tool">';
    const invokeClose = '</invoke>';
    const paramOpen = '<parameter name="param">';
    const paramClose = '</parameter>';

    const toolCallXml = [
      fnCallsOpen, '\n', invokeOpen, '\n',
      paramOpen, 'test_value', paramClose, '\n',
      invokeClose, '\n',
    ].join('');

    const adapter = createMultiCallAdapter([
      { chunks: [toolCallXml], stopReason: 'stop_sequence', stopSequence: fnCallsClose },
      { chunks: ['Final response.'], stopReason: 'end_turn' },
    ]);

    const membrane = new Membrane(adapter);

    // Should throw with clear error message
    await expect(membrane.stream(createMultiTurnRequest(), {
      onToolCalls: async () => {
        return undefined as any;  // Simulate buggy handler
      },
    })).rejects.toThrow('onToolCalls must return an array');
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
