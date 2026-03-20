/**
 * Pseudo-Prefill Formatter Unit Tests
 */

import { describe, it, expect } from 'vitest';
import { PseudoPrefillFormatter } from '../../src/formatters/pseudo-prefill.js';
import type { NormalizedMessage, ToolDefinition } from '../../src/types/index.js';

// ============================================================================
// Test Helpers
// ============================================================================

function textMessage(participant: string, text: string, opts?: { cacheBreakpoint?: boolean }): NormalizedMessage {
  return {
    participant,
    content: [{ type: 'text', text }],
    ...(opts?.cacheBreakpoint ? { cacheBreakpoint: true } : {}),
  };
}

function imageMessage(participant: string, text: string): NormalizedMessage {
  return {
    participant,
    content: [
      { type: 'text', text },
      {
        type: 'image',
        source: { type: 'base64', mediaType: 'image/png', data: 'iVBORw0KGgo=' },
      },
    ],
  };
}

const calculatorTool: ToolDefinition = {
  name: 'calculate',
  description: 'Performs a calculation',
  inputSchema: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: 'Math expression' },
    },
    required: ['expression'],
  },
};

const defaultOptions = {
  participantMode: 'multiuser' as const,
  assistantParticipant: 'Claude',
};

// ============================================================================
// PseudoPrefillFormatter Tests
// ============================================================================

describe('PseudoPrefillFormatter', () => {
  describe('basic properties', () => {
    it('has correct name and usesPrefill', () => {
      const formatter = new PseudoPrefillFormatter();
      expect(formatter.name).toBe('pseudo-prefill');
      expect(formatter.usesPrefill).toBe(false);
    });
  });

  describe('buildMessages', () => {
    it('builds the 3-message CLI structure', () => {
      const formatter = new PseudoPrefillFormatter();
      const messages: NormalizedMessage[] = [
        textMessage('Alice', 'Hello'),
        textMessage('Claude', 'Hi there!'),
        textMessage('Alice', 'How are you?'),
      ];

      const result = formatter.buildMessages(messages, defaultOptions);

      // Should have exactly 3 messages: cut, assistant log, cat
      expect(result.messages).toHaveLength(3);
      expect(result.messages[0]!.role).toBe('user');
      expect(result.messages[1]!.role).toBe('assistant');
      expect(result.messages[2]!.role).toBe('user');
    });

    it('cut command has correct character count', () => {
      const formatter = new PseudoPrefillFormatter();
      const messages: NormalizedMessage[] = [
        textMessage('Alice', 'Hello'),
        textMessage('Claude', 'Hi!'),
      ];

      const result = formatter.buildMessages(messages, defaultOptions);

      // The assistant content contains the conversation log
      const logContent = result.messages[1]!.content;
      const logText = Array.isArray(logContent)
        ? (logContent[0] as { text: string }).text
        : logContent as string;
      const charCount = (logText as string).length;

      // The cut command should reference the exact character count
      expect(result.messages[0]!.content).toBe(`<cmd>cut -c 1-${charCount} < conversation.txt</cmd>`);
    });

    it('cat command uses the configured filename', () => {
      const formatter = new PseudoPrefillFormatter({ filename: 'chat.log' });
      const messages: NormalizedMessage[] = [
        textMessage('Alice', 'Hello'),
      ];

      const result = formatter.buildMessages(messages, defaultOptions);

      expect(result.messages[0]!.content).toContain('chat.log');
      expect(result.messages[2]!.content).toBe('<cmd>cat chat.log</cmd>');
    });

    it('serializes conversation log with participant names', () => {
      const formatter = new PseudoPrefillFormatter();
      const messages: NormalizedMessage[] = [
        textMessage('Alice', 'Hello everyone'),
        textMessage('Bob', 'Hey Alice!'),
        textMessage('Claude', 'Hi both!'),
      ];

      const result = formatter.buildMessages(messages, defaultOptions);

      const logContent = result.messages[1]!.content;
      const logText = Array.isArray(logContent)
        ? (logContent[0] as { text: string }).text
        : logContent as string;

      expect(logText).toContain('Alice: Hello everyone');
      expect(logText).toContain('Bob: Hey Alice!');
      expect(logText).toContain('Claude: Hi both!');
    });

    it('adds assistant turn prefix at end of log', () => {
      const formatter = new PseudoPrefillFormatter();
      const messages: NormalizedMessage[] = [
        textMessage('Alice', 'Hello'),
      ];

      const result = formatter.buildMessages(messages, defaultOptions);

      const logContent = result.messages[1]!.content;
      const logText = Array.isArray(logContent)
        ? (logContent[0] as { text: string }).text
        : logContent as string;

      expect((logText as string).endsWith('Claude:')).toBe(true);
    });

    it('has no assistantPrefill (model generates fresh turn)', () => {
      const formatter = new PseudoPrefillFormatter();
      const messages: NormalizedMessage[] = [
        textMessage('Alice', 'Hello'),
      ];

      const result = formatter.buildMessages(messages, defaultOptions);
      expect(result.assistantPrefill).toBeUndefined();
    });
  });

  describe('system prompt', () => {
    it('appends CLI directive to user system prompt', () => {
      const formatter = new PseudoPrefillFormatter();
      const messages: NormalizedMessage[] = [textMessage('Alice', 'Hello')];

      const result = formatter.buildMessages(messages, {
        ...defaultOptions,
        systemPrompt: 'You are a helpful assistant.',
      });

      const systemContent = result.systemContent as { type: string; text: string }[];
      expect(systemContent[0]!.text).toContain('You are a helpful assistant.');
      expect(systemContent[0]!.text).toContain('CLI simulation mode');
    });

    it('uses only CLI directive when no system prompt', () => {
      const formatter = new PseudoPrefillFormatter();
      const messages: NormalizedMessage[] = [textMessage('Alice', 'Hello')];

      const result = formatter.buildMessages(messages, defaultOptions);

      const systemContent = result.systemContent as { type: string; text: string }[];
      expect(systemContent[0]!.text).toBe(
        'The assistant is in CLI simulation mode, and responds to the user\'s CLI commands only with the output of the command.'
      );
    });
  });

  describe('context prefix', () => {
    it('prepends contextPrefix to the conversation log', () => {
      const formatter = new PseudoPrefillFormatter();
      const messages: NormalizedMessage[] = [
        textMessage('Alice', 'Hello'),
      ];

      const result = formatter.buildMessages(messages, {
        ...defaultOptions,
        contextPrefix: 'Simulacrum seed content here.',
      });

      const logContent = result.messages[1]!.content;
      const logText = Array.isArray(logContent)
        ? (logContent[0] as { text: string }).text
        : logContent as string;

      // contextPrefix should come before the first message
      const prefixIndex = (logText as string).indexOf('Simulacrum seed content here.');
      const messageIndex = (logText as string).indexOf('Alice: Hello');
      expect(prefixIndex).toBeLessThan(messageIndex);
      expect(prefixIndex).toBe(0);
    });
  });

  describe('stop sequences', () => {
    it('generates stop sequences from non-assistant participants', () => {
      const formatter = new PseudoPrefillFormatter();
      const messages: NormalizedMessage[] = [
        textMessage('Alice', 'Hello'),
        textMessage('Bob', 'Hi'),
        textMessage('Claude', 'Hey!'),
        textMessage('Alice', 'Question?'),
      ];

      const result = formatter.buildMessages(messages, defaultOptions);

      expect(result.stopSequences).toContain('\nAlice:');
      expect(result.stopSequences).toContain('\nBob:');
      // Should NOT include the assistant participant
      expect(result.stopSequences).not.toContain('\nClaude:');
    });

    it('respects maxParticipantsForStop', () => {
      const formatter = new PseudoPrefillFormatter({ maxParticipantsForStop: 1 });
      const messages: NormalizedMessage[] = [
        textMessage('Alice', 'Hello'),
        textMessage('Bob', 'Hi'),
        textMessage('Charlie', 'Hey'),
        textMessage('Claude', ''),
      ];

      const result = formatter.buildMessages(messages, defaultOptions);

      // Should only include the most recent non-assistant participant
      const participantStops = result.stopSequences.filter(s => s.startsWith('\n'));
      expect(participantStops).toHaveLength(1);
    });

    it('includes additional stop sequences', () => {
      const formatter = new PseudoPrefillFormatter();
      const messages: NormalizedMessage[] = [textMessage('Alice', 'Hello')];

      const result = formatter.buildMessages(messages, {
        ...defaultOptions,
        additionalStopSequences: ['[END]', '---'],
      });

      expect(result.stopSequences).toContain('[END]');
      expect(result.stopSequences).toContain('---');
    });
  });

  describe('prompt caching', () => {
    it('applies cache_control to system and log blocks', () => {
      const formatter = new PseudoPrefillFormatter();
      const messages: NormalizedMessage[] = [textMessage('Alice', 'Hello')];

      const result = formatter.buildMessages(messages, {
        ...defaultOptions,
        promptCaching: true,
      });

      // System block should have cache_control
      const systemContent = result.systemContent as Record<string, unknown>[];
      expect(systemContent[0]!.cache_control).toEqual({ type: 'ephemeral' });

      // Assistant log block should have cache_control
      const logContent = result.messages[1]!.content as Record<string, unknown>[];
      expect(logContent[0]!.cache_control).toEqual({ type: 'ephemeral' });

      expect(result.cacheMarkersApplied).toBeGreaterThanOrEqual(2);
    });

    it('applies cacheTtl when specified', () => {
      const formatter = new PseudoPrefillFormatter();
      const messages: NormalizedMessage[] = [textMessage('Alice', 'Hello')];

      const result = formatter.buildMessages(messages, {
        ...defaultOptions,
        promptCaching: true,
        cacheTtl: '1h',
      });

      const logContent = result.messages[1]!.content as Record<string, unknown>[];
      expect(logContent[0]!.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    });

    it('supports cache breakpoints in conversation', () => {
      const formatter = new PseudoPrefillFormatter();
      const messages: NormalizedMessage[] = [
        textMessage('Alice', 'Older message'),
        textMessage('Claude', 'Older reply', { cacheBreakpoint: true }),
        textMessage('Alice', 'New message'),
      ];

      const result = formatter.buildMessages(messages, {
        ...defaultOptions,
        promptCaching: true,
      });

      // With cache breakpoints, assistant content should have multiple blocks
      const logContent = result.messages[1]!.content as Record<string, unknown>[];
      expect(logContent.length).toBeGreaterThan(1);

      // The breakpoint block should have cache_control
      const breakpointBlock = logContent.find(b => {
        const text = (b as { text: string }).text;
        return text.includes('Older reply') && b.cache_control;
      });
      expect(breakpointBlock).toBeDefined();
    });
  });

  describe('native tools', () => {
    it('passes tools as nativeTools', () => {
      const formatter = new PseudoPrefillFormatter();
      const messages: NormalizedMessage[] = [textMessage('Alice', 'Calculate 2+2')];

      const result = formatter.buildMessages(messages, {
        ...defaultOptions,
        tools: [calculatorTool],
      });

      expect(result.nativeTools).toBeDefined();
      expect(result.nativeTools).toHaveLength(1);
      expect((result.nativeTools![0] as { name: string }).name).toBe('calculate');
    });

    it('returns no nativeTools when tools array is empty', () => {
      const formatter = new PseudoPrefillFormatter();
      const messages: NormalizedMessage[] = [textMessage('Alice', 'Hello')];

      const result = formatter.buildMessages(messages, {
        ...defaultOptions,
        tools: [],
      });

      expect(result.nativeTools).toBeUndefined();
    });
  });

  describe('image handling', () => {
    it('flushes log and creates user turn for images', () => {
      const formatter = new PseudoPrefillFormatter();
      const messages: NormalizedMessage[] = [
        textMessage('Alice', 'Hello'),
        imageMessage('Bob', 'Look at this'),
        textMessage('Alice', 'Nice!'),
      ];

      const result = formatter.buildMessages(messages, defaultOptions);

      // Should have: cut, assistant(log), assistant(ack), user(image), cat
      expect(result.messages.length).toBeGreaterThan(3);

      // Find the image user turn
      const imageTurn = result.messages.find(m => {
        if (m.role !== 'user') return false;
        const content = Array.isArray(m.content) ? m.content : [];
        return content.some((b: any) => b.type === 'image');
      });
      expect(imageTurn).toBeDefined();

      // Last message should still be cat
      const lastMsg = result.messages[result.messages.length - 1]!;
      expect(lastMsg.role).toBe('user');
      expect(lastMsg.content).toContain('<cmd>cat');
    });
  });

  describe('empty conversation', () => {
    it('handles empty messages array', () => {
      const formatter = new PseudoPrefillFormatter();
      const messages: NormalizedMessage[] = [];

      const result = formatter.buildMessages(messages, defaultOptions);

      // Should still produce the 3-message structure
      expect(result.messages).toHaveLength(3);

      // Log should contain just the assistant turn prefix
      const logContent = result.messages[1]!.content;
      const logText = Array.isArray(logContent)
        ? (logContent[0] as { text: string }).text
        : logContent as string;
      expect(logText).toBe('Claude:');
    });
  });

  describe('response parsing', () => {
    it('creates PassthroughParser', () => {
      const formatter = new PseudoPrefillFormatter();
      const parser = formatter.createStreamParser();
      expect(parser).toBeDefined();
      expect(parser.getCurrentBlockType()).toBe('text');
    });

    it('parseToolCalls returns empty (native mode)', () => {
      const formatter = new PseudoPrefillFormatter();
      expect(formatter.parseToolCalls('some content')).toEqual([]);
    });

    it('hasToolUse returns false (native mode)', () => {
      const formatter = new PseudoPrefillFormatter();
      expect(formatter.hasToolUse('some content')).toBe(false);
    });

    it('parseContentBlocks returns text block', () => {
      const formatter = new PseudoPrefillFormatter();
      const blocks = formatter.parseContentBlocks('Hello world');
      expect(blocks).toHaveLength(1);
      expect(blocks[0]!.type).toBe('text');
      expect((blocks[0] as { type: 'text'; text: string }).text).toBe('Hello world');
    });

    it('parseContentBlocks returns empty for whitespace-only content', () => {
      const formatter = new PseudoPrefillFormatter();
      expect(formatter.parseContentBlocks('  ')).toEqual([]);
    });
  });

  describe('stream parser', () => {
    it('accumulates chunks correctly', () => {
      const formatter = new PseudoPrefillFormatter();
      const parser = formatter.createStreamParser();

      parser.processChunk('Hello ');
      parser.processChunk('world');

      expect(parser.getAccumulated()).toBe('Hello world');
    });

    it('emits block_start on first chunk and block_complete on flush', () => {
      const formatter = new PseudoPrefillFormatter();
      const parser = formatter.createStreamParser();

      const result1 = parser.processChunk('Hello');
      expect(result1.blockEvents).toHaveLength(1);
      expect(result1.blockEvents[0]!.event).toBe('block_start');

      const result2 = parser.processChunk(' world');
      expect(result2.blockEvents).toHaveLength(0);

      const flushResult = parser.flush();
      expect(flushResult.blockEvents).toHaveLength(1);
      expect(flushResult.blockEvents[0]!.event).toBe('block_complete');
    });
  });

  describe('continuation modes', () => {
    it('uses cat command by default', () => {
      const formatter = new PseudoPrefillFormatter();
      const messages: NormalizedMessage[] = [textMessage('Alice', 'Hello')];
      const result = formatter.buildMessages(messages, defaultOptions);
      const lastMsg = result.messages[result.messages.length - 1]!;
      expect(lastMsg.content).toContain('<cmd>cat');
    });

    it('uses tail-cut command when configured', () => {
      const formatter = new PseudoPrefillFormatter({ continuationMode: 'tail-cut' });
      const messages: NormalizedMessage[] = [textMessage('Alice', 'Hello')];
      const result = formatter.buildMessages(messages, defaultOptions);
      const lastMsg = result.messages[result.messages.length - 1]!;
      expect(lastMsg.content).toContain('<cmd>cut -c');
      expect(lastMsg.content).not.toContain('<cmd>cat');
    });

    it('tail-cut uses correct char offset', () => {
      const formatter = new PseudoPrefillFormatter({ continuationMode: 'tail-cut' });
      const messages: NormalizedMessage[] = [textMessage('Alice', 'Hello')];
      const result = formatter.buildMessages(messages, defaultOptions);

      const logContent = result.messages[1]!.content;
      const logText = Array.isArray(logContent)
        ? (logContent[0] as { text: string }).text
        : logContent as string;
      const charCount = (logText as string).length;

      const lastMsg = result.messages[result.messages.length - 1]!;
      expect(lastMsg.content).toBe(`<cmd>cut -c ${charCount + 1}- < conversation.txt</cmd>`);
    });
  });

  describe('metadata', () => {
    it('includes conversationLog and continuationMode in metadata', () => {
      const formatter = new PseudoPrefillFormatter();
      const messages: NormalizedMessage[] = [
        textMessage('Alice', 'Hello'),
        textMessage('Claude', 'Hi!'),
      ];
      const result = formatter.buildMessages(messages, defaultOptions);

      expect(result.metadata).toBeDefined();
      expect(result.metadata!.continuationMode).toBe('cat');
      expect(result.metadata!.assistantParticipant).toBe('Claude');
      expect(typeof result.metadata!.conversationLog).toBe('string');
      expect(typeof result.metadata!.conversationLogLength).toBe('number');
    });
  });

  describe('same-participant merging', () => {
    it('merges consecutive messages from the same participant', () => {
      const formatter = new PseudoPrefillFormatter();
      const messages: NormalizedMessage[] = [
        textMessage('Alice', 'Hello'),
        textMessage('Alice', 'How are you?'),
        textMessage('Claude', 'Fine!'),
      ];
      const result = formatter.buildMessages(messages, defaultOptions);

      const logContent = result.messages[1]!.content;
      const logText = Array.isArray(logContent)
        ? (logContent[0] as { text: string }).text
        : logContent as string;

      // Alice's messages should be merged — only one "Alice:" prefix
      const aliceCount = ((logText as string).match(/Alice:/g) || []).length;
      expect(aliceCount).toBe(1);
      expect(logText).toContain('Hello');
      expect(logText).toContain('How are you?');
    });
  });
});
