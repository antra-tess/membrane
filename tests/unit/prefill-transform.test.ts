/**
 * Unit tests for prefill transform
 */

import { describe, it, expect } from 'vitest';
import { transformToPrefill } from '../../src/transforms/prefill.js';
import type { NormalizedRequest, ToolDefinition } from '../../src/types/index.js';

const sampleTool: ToolDefinition = {
  name: 'get_weather',
  description: 'Get current weather',
  inputSchema: {
    type: 'object',
    properties: {
      location: { type: 'string', description: 'City name' },
    },
    required: ['location'],
  },
};

function createRequest(overrides: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    messages: [
      {
        participant: 'User',
        content: [{ type: 'text', text: 'Hello' }],
      },
      {
        participant: 'Claude',
        content: [], // Empty = completion target
      },
    ],
    config: {
      model: 'claude-sonnet-4-20250514',
      maxTokens: 1000,
    },
    ...overrides,
  };
}

describe('Prefill Transform', () => {
  describe('basic message formatting', () => {
    it('should format simple user/assistant exchange', () => {
      const result = transformToPrefill(createRequest());

      expect(result.assistantPrefill).toContain('User: Hello');
      expect(result.assistantPrefill).toContain('Claude:');
    });

    it('should end with assistant turn prefix', () => {
      const result = transformToPrefill(createRequest());

      // Should end with "Claude:" (possibly with thinking tag)
      expect(result.assistantPrefill.trim()).toMatch(/Claude:(\s*<thinking>)?$/);
    });

    it('should include thinking tag when prefillThinking is enabled', () => {
      const result = transformToPrefill(createRequest(), {
        prefillThinking: true,
      });

      expect(result.assistantPrefill).toContain('Claude: <thinking>');
    });
  });

  describe('tool injection placement', () => {
    it('should inject tools BEFORE the assistant turn prefix', () => {
      const request = createRequest({ tools: [sampleTool] });
      const result = transformToPrefill(request, {
        toolInjectionMode: 'conversation',
      });

      const prefill = result.assistantPrefill;

      // Find positions
      const toolsPos = prefill.indexOf('<available_tools>');
      const turnPrefixPos = prefill.lastIndexOf('Claude:');

      expect(toolsPos).toBeGreaterThan(-1);
      expect(turnPrefixPos).toBeGreaterThan(-1);

      // Tools should come BEFORE the final turn prefix
      expect(toolsPos).toBeLessThan(turnPrefixPos);
    });

    it('should not make it look like Claude is outputting tools', () => {
      const request = createRequest({ tools: [sampleTool] });
      const result = transformToPrefill(request, {
        toolInjectionMode: 'conversation',
      });

      // The pattern "Claude:" followed immediately by "<available_tools>" is WRONG
      // It should be tools first, then "Claude:"
      expect(result.assistantPrefill).not.toMatch(/Claude:\s*\n*<available_tools>/);
    });

    it('should place tools at beginning for short conversations', () => {
      const request = createRequest({ tools: [sampleTool] });
      const result = transformToPrefill(request, {
        toolInjectionMode: 'conversation',
        // Default toolInjectionPosition is 10, conversation has 2 messages
        // So tools should go at the very beginning
      });

      const prefill = result.assistantPrefill;

      // Expected structure for short conversation:
      // <available_tools>...
      // User: Hello
      // Claude:
      const toolsPos = prefill.indexOf('<available_tools>');
      const userPos = prefill.indexOf('User: Hello');
      const claudePos = prefill.lastIndexOf('Claude:');

      expect(toolsPos).toBeLessThan(userPos);
      expect(userPos).toBeLessThan(claudePos);
    });

    it('should inject tools into system prompt when mode is system', () => {
      const request = createRequest({
        tools: [sampleTool],
        system: 'You are helpful.',
      });
      const result = transformToPrefill(request, {
        toolInjectionMode: 'system',
      });

      // Tools should be in system, not in assistant prefill
      expect(result.system).toContain('<available_tools>');
      expect(result.assistantPrefill).not.toContain('<available_tools>');
    });

    it('should not inject tools when mode is none', () => {
      const request = createRequest({ tools: [sampleTool] });
      const result = transformToPrefill(request, {
        toolInjectionMode: 'none',
      });

      expect(result.assistantPrefill).not.toContain('<available_tools>');
      expect(result.system).not.toContain('<available_tools>');
    });
  });

  describe('tool injection with thinking enabled', () => {
    it('should place tools before thinking-prefilled turn', () => {
      const request = createRequest({ tools: [sampleTool] });
      const result = transformToPrefill(request, {
        toolInjectionMode: 'conversation',
        prefillThinking: true,
      });

      const prefill = result.assistantPrefill;

      // Tools should come before "Claude: <thinking>"
      const toolsEnd = prefill.indexOf('</function_calls>');
      const thinkingStart = prefill.indexOf('Claude: <thinking>');

      expect(toolsEnd).toBeGreaterThan(-1);
      expect(thinkingStart).toBeGreaterThan(-1);
      expect(toolsEnd).toBeLessThan(thinkingStart);
    });
  });

  describe('multi-turn conversations', () => {
    it('should inject tools at correct position in long conversations', () => {
      const request: NormalizedRequest = {
        messages: [
          { participant: 'User', content: [{ type: 'text', text: 'Message 1' }] },
          { participant: 'Claude', content: [{ type: 'text', text: 'Response 1' }] },
          { participant: 'User', content: [{ type: 'text', text: 'Message 2' }] },
          { participant: 'Claude', content: [{ type: 'text', text: 'Response 2' }] },
          { participant: 'User', content: [{ type: 'text', text: 'Message 3' }] },
          { participant: 'Claude', content: [] }, // completion target
        ],
        config: { model: 'claude-sonnet-4-20250514', maxTokens: 1000 },
        tools: [sampleTool],
      };

      const result = transformToPrefill(request, {
        toolInjectionMode: 'conversation',
        toolInjectionPosition: 2, // Insert ~2 messages from end
      });

      const prefill = result.assistantPrefill;

      // Tools should still come before the final turn prefix
      const toolsPos = prefill.indexOf('<available_tools>');
      const lastClaudePos = prefill.lastIndexOf('Claude:');

      expect(toolsPos).toBeLessThan(lastClaudePos);
    });

    it('should inject tools N messages from end based on TOTAL message count', () => {
      // 12 messages total, toolInjectionPosition=3 means tools at message 9 (index 9)
      const messages: NormalizedRequest['messages'] = [];
      for (let i = 0; i < 11; i++) {
        messages.push({
          participant: i % 2 === 0 ? 'User' : 'Claude',
          content: [{ type: 'text', text: `Message ${i}` }],
        });
      }
      messages.push({ participant: 'Claude', content: [] }); // completion target

      const request: NormalizedRequest = {
        messages,
        config: { model: 'claude-sonnet-4-20250514', maxTokens: 1000 },
        tools: [sampleTool],
      };

      const result = transformToPrefill(request, {
        toolInjectionMode: 'conversation',
        toolInjectionPosition: 3, // Insert 3 messages from end
      });

      const prefill = result.assistantPrefill;

      // Tools should appear BEFORE "Message 9" (which is 3 messages from end, not counting empty completion target)
      const toolsPos = prefill.indexOf('<available_tools>');
      const message8Pos = prefill.indexOf('Message 8');
      const message9Pos = prefill.indexOf('Message 9');

      // Tools should be after message 8 but before message 9
      expect(toolsPos).toBeGreaterThan(message8Pos);
      expect(toolsPos).toBeLessThan(message9Pos);
    });

    it('should inject tools at correct global position even with image flushes', () => {
      // Simulate a conversation where an image causes a flush mid-way
      // Total: 8 messages, image at message 4
      const messages: NormalizedRequest['messages'] = [
        { participant: 'User', content: [{ type: 'text', text: 'Message 0' }] },
        { participant: 'Claude', content: [{ type: 'text', text: 'Message 1' }] },
        { participant: 'User', content: [{ type: 'text', text: 'Message 2' }] },
        { participant: 'Claude', content: [{ type: 'text', text: 'Message 3' }] },
        // Image here would cause flush in real scenario
        { participant: 'User', content: [{ type: 'text', text: 'Message 4' }] },
        { participant: 'Claude', content: [{ type: 'text', text: 'Message 5' }] },
        { participant: 'User', content: [{ type: 'text', text: 'Message 6' }] },
        { participant: 'Claude', content: [] }, // completion target (message 7)
      ];

      const request: NormalizedRequest = {
        messages,
        config: { model: 'claude-sonnet-4-20250514', maxTokens: 1000 },
        tools: [sampleTool],
      };

      const result = transformToPrefill(request, {
        toolInjectionMode: 'conversation',
        toolInjectionPosition: 3, // Insert 3 messages from end (before message 5)
      });

      const prefill = result.assistantPrefill;

      // Tools should appear before message 5 (8 - 3 = 5)
      const toolsPos = prefill.indexOf('<available_tools>');
      const message4Pos = prefill.indexOf('Message 4');
      const message5Pos = prefill.indexOf('Message 5');

      // Tools should be after message 4 but before message 5
      expect(toolsPos).toBeGreaterThan(message4Pos);
      expect(toolsPos).toBeLessThan(message5Pos);
    });
  });

  describe('stop sequences', () => {
    it('should include participant-based stop sequences', () => {
      const result = transformToPrefill(createRequest());

      expect(result.stopSequences).toContain('\nUser:');
    });

    it('should include function_calls stop sequence when tools present', () => {
      const request = createRequest({ tools: [sampleTool] });
      const result = transformToPrefill(request);

      expect(result.stopSequences).toContain('</function_calls>');
    });

    it('should include additional stop sequences', () => {
      const result = transformToPrefill(createRequest(), {
        additionalStopSequences: ['STOP', 'END'],
      });

      expect(result.stopSequences).toContain('STOP');
      expect(result.stopSequences).toContain('END');
    });
  });
});
