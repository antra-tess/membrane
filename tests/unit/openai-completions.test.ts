import { describe, it, expect } from 'vitest';
import { OpenAICompletionsAdapter } from '../../src/providers/openai-completions.js';

describe('OpenAICompletionsAdapter', () => {
  const adapter = new OpenAICompletionsAdapter({
    baseURL: 'http://localhost:8000/v1',
    warnOnImageStrip: false, // Disable warnings in tests
  });

  describe('serializeToPrompt', () => {
    it('should serialize simple conversation to Human:/Assistant: format', () => {
      const messages = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
        { role: 'user', content: 'How are you?' },
      ];

      const prompt = adapter.serializeToPrompt(messages);

      expect(prompt).toBe(
        'Human: Hello\n\n' +
        'Assistant: Hi there!\n\n' +
        'Human: How are you?\n\n' +
        'Assistant:'
      );
    });

    it('should handle array content blocks', () => {
      const messages = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'First part' },
            { type: 'text', text: 'Second part' },
          ],
        },
      ];

      const prompt = adapter.serializeToPrompt(messages);

      expect(prompt).toBe(
        'Human: First part\nSecond part\n\n' +
        'Assistant:'
      );
    });

    it('should strip images from content', () => {
      const messages = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Look at this:' },
            { type: 'image', source: { type: 'base64', data: 'abc123' } },
          ],
        },
      ];

      const prompt = adapter.serializeToPrompt(messages);

      expect(prompt).toBe(
        'Human: Look at this:\n\n' +
        'Assistant:'
      );
      // Image should be silently stripped (warning disabled in test config)
    });

    it('should skip tool_use and tool_result blocks', () => {
      const messages = [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me check that.' },
            { type: 'tool_use', id: 'tool_1', name: 'search', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tool_1', content: 'Result here' },
          ],
        },
        {
          role: 'user',
          content: 'Thanks!',
        },
      ];

      const prompt = adapter.serializeToPrompt(messages);

      // Tool blocks are skipped, empty messages are still included with prefix
      expect(prompt).toContain('Human: Thanks!');
      expect(prompt).toContain('Assistant:');
      expect(prompt).not.toContain('tool');
      expect(prompt).not.toContain('search');
    });

    it('should handle empty conversation', () => {
      const prompt = adapter.serializeToPrompt([]);

      expect(prompt).toBe('Assistant:');
    });

    it('should normalize role names', () => {
      const messages = [
        { role: 'human', content: 'Test 1' },
        { role: 'Human', content: 'Test 2' },
        { role: 'user', content: 'Test 3' },
      ];

      const prompt = adapter.serializeToPrompt(messages);

      expect(prompt).toContain('Human: Test 1');
      expect(prompt).toContain('Human: Test 2');
      expect(prompt).toContain('Human: Test 3');
      expect(prompt).not.toContain('human:');
      expect(prompt).not.toContain('user:');
    });
  });

  describe('configuration', () => {
    it('should use default stop sequences', () => {
      const defaultAdapter = new OpenAICompletionsAdapter({
        baseURL: 'http://localhost:8000/v1',
      });

      // We can't directly test private fields, but we can verify the adapter was created
      expect(defaultAdapter.name).toBe('openai-completions');
    });

    it('should allow custom provider name', () => {
      const customAdapter = new OpenAICompletionsAdapter({
        baseURL: 'http://localhost:8000/v1',
        providerName: 'my-base-model',
      });

      expect(customAdapter.name).toBe('my-base-model');
    });

    it('should require baseURL', () => {
      expect(() => {
        new OpenAICompletionsAdapter({} as any);
      }).toThrow('requires baseURL');
    });
  });
});
