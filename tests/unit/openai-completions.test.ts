import { describe, it, expect, vi } from 'vitest';
import { OpenAICompletionsAdapter } from '../../src/providers/openai-completions.js';

describe('OpenAICompletionsAdapter', () => {
  const adapter = new OpenAICompletionsAdapter({
    baseURL: 'http://localhost:8000/v1',
    warnOnImageStrip: false,
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
        'Alice: Hello<|eot|>\n\n' +
        'Claude: Hi there!<|eot|>\n\n' +
        'Alice: How are you?<|eot|>\n\n' +
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
        'user: Hello<|eot|>\n\n' +
        'assistant: Hi there!<|eot|>\n\n' +
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
        'Bob: First part\nSecond part<|eot|>\n\n' +
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
        'Alice: Look at this:<|eot|>\n\n' +
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
        'Alice: Hello<|eot|>\n\n' +
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

    it('should append default EOT token after each message', () => {
      const messages = [
        { participant: 'Alice', content: 'Hello' },
        { participant: 'Claude', content: 'Hi there!' },
      ];

      const { prompt } = adapter.serializeToPrompt(messages);

      expect(prompt).toBe(
        'Alice: Hello<|eot|>\n\n' +
        'Claude: Hi there!<|eot|>\n\n' +
        'Assistant:'
      );
    });

    it('should use custom EOT token', () => {
      const customAdapter = new OpenAICompletionsAdapter({
        baseURL: 'http://localhost:8000/v1',
        eotToken: '</s>',
        warnOnImageStrip: false,
      });

      const messages = [
        { participant: 'Alice', content: 'Hello' },
      ];

      const { prompt } = customAdapter.serializeToPrompt(messages);

      expect(prompt).toBe(
        'Alice: Hello</s>\n\n' +
        'Assistant:'
      );
    });

    it('should allow disabling EOT token with null', () => {
      const noEotAdapter = new OpenAICompletionsAdapter({
        baseURL: 'http://localhost:8000/v1',
        eotToken: null,
        warnOnImageStrip: false,
      });

      const messages = [
        { participant: 'Alice', content: 'Hello' },
      ];

      const { prompt } = noEotAdapter.serializeToPrompt(messages);

      expect(prompt).toBe(
        'Alice: Hello\n\n' +
        'Assistant:'
      );
    });

    it('should allow disabling EOT token with empty string', () => {
      const noEotAdapter = new OpenAICompletionsAdapter({
        baseURL: 'http://localhost:8000/v1',
        eotToken: '',
        warnOnImageStrip: false,
      });

      const messages = [
        { participant: 'Alice', content: 'Hello' },
      ];

      const { prompt } = noEotAdapter.serializeToPrompt(messages);

      expect(prompt).toBe(
        'Alice: Hello\n\n' +
        'Assistant:'
      );
    });
  });

  describe('configuration', () => {
    it('should use default stop sequences', async () => {
      let sent: { stop?: string[] } | undefined;
      vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
        sent = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({ choices: [{ text: 'ok', finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      });
      try {
        await new OpenAICompletionsAdapter({ baseURL: 'http://localhost:8000/v1' }).complete({
          model: 'zz-model', maxTokens: 16,
          messages: [{ participant: 'Alice', content: 'Hello' }, { participant: 'Assistant', content: 'Hi' }],
        } as never);
      } finally {
        vi.unstubAllGlobals();
      }
      expect([...(sent?.stop ?? [])].sort()).toEqual(['\n\nAlice:', '\nAlice:', '<|eot|>'].sort());
    });

    it('is named openai-completions by default', () => {
      expect(new OpenAICompletionsAdapter({ baseURL: 'http://localhost:8000/v1' }).name).toBe('openai-completions');
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
