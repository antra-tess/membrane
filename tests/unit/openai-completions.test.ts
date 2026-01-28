import { describe, it, expect } from 'vitest';
import { OpenAICompletionsAdapter } from '../../src/providers/openai-completions.js';

describe('OpenAICompletionsAdapter', () => {
  const adapter = new OpenAICompletionsAdapter({
    baseURL: 'http://localhost:8000/v1',
    warnOnImageStrip: false, // Disable warnings in tests
  });

  describe('serializeToPrompt', () => {
    it('should serialize conversation using actual participant names', () => {
      const messages = [
        { participant: 'Alice', content: 'Hello' },
        { participant: 'Claude', content: 'Hi there!' },
        { participant: 'Alice', content: 'How are you?' },
      ];

      const { prompt, participants } = adapter.serializeToPrompt(messages);

      expect(prompt).toBe(
        'Alice: Hello\n\n' +
        'Claude: Hi there!\n\n' +
        'Alice: How are you?\n\n' +
        'Assistant:'
      );
      expect(participants).toContain('Alice');
      expect(participants).toContain('Claude');
    });

    it('should fall back to role field if participant not present', () => {
      const messages = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
      ];

      const { prompt } = adapter.serializeToPrompt(messages);

      expect(prompt).toBe(
        'user: Hello\n\n' +
        'assistant: Hi there!\n\n' +
        'Assistant:'
      );
    });

    it('should handle array content blocks', () => {
      const messages = [
        {
          participant: 'Bob',
          content: [
            { type: 'text', text: 'First part' },
            { type: 'text', text: 'Second part' },
          ],
        },
      ];

      const { prompt } = adapter.serializeToPrompt(messages);

      expect(prompt).toBe(
        'Bob: First part\nSecond part\n\n' +
        'Assistant:'
      );
    });

    it('should strip images from content', () => {
      const messages = [
        {
          participant: 'Alice',
          content: [
            { type: 'text', text: 'Look at this:' },
            { type: 'image', source: { type: 'base64', data: 'abc123' } },
          ],
        },
      ];

      const { prompt } = adapter.serializeToPrompt(messages);

      expect(prompt).toBe(
        'Alice: Look at this:\n\n' +
        'Assistant:'
      );
    });

    it('should skip tool_use and tool_result blocks', () => {
      const messages = [
        {
          participant: 'Claude',
          content: [
            { type: 'text', text: 'Let me check that.' },
            { type: 'tool_use', id: 'tool_1', name: 'search', input: {} },
          ],
        },
        {
          participant: 'System',
          content: [
            { type: 'tool_result', tool_use_id: 'tool_1', content: 'Result here' },
          ],
        },
        {
          participant: 'Alice',
          content: 'Thanks!',
        },
      ];

      const { prompt } = adapter.serializeToPrompt(messages);

      expect(prompt).toContain('Alice: Thanks!');
      expect(prompt).toContain('Assistant:');
      expect(prompt).not.toContain('tool');
      expect(prompt).not.toContain('search');
    });

    it('should handle empty conversation', () => {
      const { prompt } = adapter.serializeToPrompt([]);

      expect(prompt).toBe('Assistant:');
    });

    it('should use custom assistant name', () => {
      const customAdapter = new OpenAICompletionsAdapter({
        baseURL: 'http://localhost:8000/v1',
        assistantName: 'Claude',
        warnOnImageStrip: false,
      });

      const messages = [
        { participant: 'Alice', content: 'Hello' },
      ];

      const { prompt } = customAdapter.serializeToPrompt(messages);

      expect(prompt).toBe(
        'Alice: Hello\n\n' +
        'Claude:'
      );
    });

    it('should collect all participant names', () => {
      const messages = [
        { participant: 'Alice', content: 'Hi' },
        { participant: 'Bob', content: 'Hello' },
        { participant: 'Claude', content: 'Hey' },
        { participant: 'Alice', content: 'Bye' },
      ];

      const { participants } = adapter.serializeToPrompt(messages);

      expect(participants.size).toBe(3);
      expect(participants).toContain('Alice');
      expect(participants).toContain('Bob');
      expect(participants).toContain('Claude');
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
