import { describe, it, expect } from 'vitest';
import { AnthropicXmlFormatter } from '../../src/formatters/anthropic-xml.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { CompletionsFormatter } from '../../src/formatters/completions.js';
import type { NormalizedMessage, ToolDefinition, ToolResult } from '../../src/types/index.js';

function textMessage(participant: string, text: string): NormalizedMessage {
  return {
    participant,
    content: [{ type: 'text', text }],
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

describe('AnthropicXmlFormatter', () => {
  describe('buildMessages', () => {
    it('builds messages with participant prefixes', () => {
      const formatter = new AnthropicXmlFormatter();
      const messages: NormalizedMessage[] = [
        textMessage('User', 'Hello'),
        textMessage('Claude', 'Hi there!'),
        textMessage('User', 'How are you?'),
        textMessage('Claude', ''),
      ];

      const result = formatter.buildMessages(messages, {
        participantMode: 'multiuser',
        assistantParticipant: 'Claude',
      });

      expect(result.messages.length).toBeGreaterThan(0);
      const lastMsg = result.messages[result.messages.length - 1];
      expect(lastMsg?.role).toBe('assistant');
      expect(typeof lastMsg?.content).toBe('string');
      expect(lastMsg?.content).toContain('Claude:');
    });

    it('generates stop sequences from participants', () => {
      const formatter = new AnthropicXmlFormatter();
      const messages: NormalizedMessage[] = [
        textMessage('Alice', 'Hello'),
        textMessage('Bob', 'Hi'),
        textMessage('Claude', ''),
      ];

      const result = formatter.buildMessages(messages, {
        participantMode: 'multiuser',
        assistantParticipant: 'Claude',
      });

      expect(result.stopSequences).toContain('\nAlice:');
      expect(result.stopSequences).toContain('\nBob:');
      expect(result.stopSequences).toContain('</function_calls>');
    });

    it('includes thinking tag in prefill when enabled', () => {
      const formatter = new AnthropicXmlFormatter();
      const messages: NormalizedMessage[] = [
        textMessage('User', 'Think about this'),
        textMessage('Claude', ''),
      ];

      const result = formatter.buildMessages(messages, {
        participantMode: 'multiuser',
        assistantParticipant: 'Claude',
        thinking: { enabled: true },
      });

      const lastMsg = result.messages[result.messages.length - 1];
      expect(lastMsg?.content).toContain('<thinking>');
    });

    it('injects tool definitions when toolMode is xml', () => {
      const formatter = new AnthropicXmlFormatter({ toolMode: 'xml' });
      const messages: NormalizedMessage[] = [
        textMessage('User', 'Calculate something'),
        textMessage('Claude', ''),
      ];

      const result = formatter.buildMessages(messages, {
        participantMode: 'multiuser',
        assistantParticipant: 'Claude',
        tools: [calculatorTool],
      });

      const content = result.messages.map(m =>
        typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
      ).join('');
      expect(content).toContain('available_tools');
      expect(content).toContain('calculate');
    });

    it('places tools BEFORE the assistant turn prefix', () => {
      const formatter = new AnthropicXmlFormatter({ toolMode: 'xml' });
      const messages: NormalizedMessage[] = [
        textMessage('User', 'Hello'),
        textMessage('Claude', ''),
      ];

      const result = formatter.buildMessages(messages, {
        participantMode: 'multiuser',
        assistantParticipant: 'Claude',
        tools: [calculatorTool],
      });

      const lastMsg = result.messages[result.messages.length - 1];
      const prefill = typeof lastMsg?.content === 'string' ? lastMsg.content : '';

      const toolsPos = prefill.indexOf('<available_tools>');
      const turnPrefixPos = prefill.lastIndexOf('Claude:');

      expect(toolsPos).toBeGreaterThan(-1);
      expect(turnPrefixPos).toBeGreaterThan(-1);
      expect(toolsPos).toBeLessThan(turnPrefixPos);

      expect(prefill).not.toMatch(/Claude:\s*\n*<available_tools>/);
    });

    it('injects tools into system prompt when toolInjectionMode is system', () => {
      const formatter = new AnthropicXmlFormatter({
        toolMode: 'xml',
        toolInjectionMode: 'system',
      });
      const messages: NormalizedMessage[] = [
        textMessage('User', 'Calculate something'),
        textMessage('Claude', ''),
      ];

      const result = formatter.buildMessages(messages, {
        participantMode: 'multiuser',
        assistantParticipant: 'Claude',
        systemPrompt: 'You are helpful.',
        tools: [calculatorTool],
      });

      const systemText = Array.isArray(result.systemContent)
        ? (result.systemContent as any[]).map(b => b.text).join('')
        : '';
      expect(systemText).toContain('<available_tools>');

      const conversationContent = result.messages.map(m =>
        typeof m.content === 'string' ? m.content : ''
      ).join('');
      expect(conversationContent).not.toContain('<available_tools>');
    });

    it('places tools at correct position in multi-turn conversations', () => {
      const formatter = new AnthropicXmlFormatter({
        toolMode: 'xml',
        toolInjectionPosition: 3,
      });
      const messages: NormalizedMessage[] = [
        textMessage('User', 'Message 0'),
        textMessage('Claude', 'Response 1'),
        textMessage('User', 'Message 2'),
        textMessage('Claude', 'Response 3'),
        textMessage('User', 'Message 4'),
        textMessage('Claude', 'Response 5'),
        textMessage('User', 'Message 6'),
        textMessage('Claude', ''),
      ];

      const result = formatter.buildMessages(messages, {
        participantMode: 'multiuser',
        assistantParticipant: 'Claude',
        tools: [calculatorTool],
      });

      const lastMsg = result.messages[result.messages.length - 1];
      const prefill = typeof lastMsg?.content === 'string' ? lastMsg.content : '';

      const toolsPos = prefill.indexOf('<available_tools>');
      const message4Pos = prefill.indexOf('Message 4');
      const message6Pos = prefill.indexOf('Message 6');

      expect(toolsPos).toBeGreaterThan(-1);
      expect(toolsPos).toBeLessThan(message6Pos);
    });

    it('places tools before thinking-prefilled turn', () => {
      const formatter = new AnthropicXmlFormatter({ toolMode: 'xml' });
      const messages: NormalizedMessage[] = [
        textMessage('User', 'Think and calculate'),
        textMessage('Claude', ''),
      ];

      const result = formatter.buildMessages(messages, {
        participantMode: 'multiuser',
        assistantParticipant: 'Claude',
        tools: [calculatorTool],
        thinking: { enabled: true },
      });

      const lastMsg = result.messages[result.messages.length - 1];
      const prefill = typeof lastMsg?.content === 'string' ? lastMsg.content : '';

      const toolsEnd = prefill.indexOf('</function_calls>');
      const thinkingStart = prefill.indexOf('Claude: <thinking>');

      expect(toolsEnd).toBeGreaterThan(-1);
      expect(thinkingStart).toBeGreaterThan(-1);
      expect(toolsEnd).toBeLessThan(thinkingStart);
    });

    it('includes additional stop sequences', () => {
      const formatter = new AnthropicXmlFormatter();
      const messages: NormalizedMessage[] = [
        textMessage('User', 'Hello'),
        textMessage('Claude', ''),
      ];

      const result = formatter.buildMessages(messages, {
        participantMode: 'multiuser',
        assistantParticipant: 'Claude',
        additionalStopSequences: ['STOP', 'END'],
      });

      expect(result.stopSequences).toContain('STOP');
      expect(result.stopSequences).toContain('END');
    });

    it('returns native tools when toolMode is native', () => {
      const formatter = new AnthropicXmlFormatter({ toolMode: 'native' });
      const messages: NormalizedMessage[] = [
        textMessage('User', 'Calculate something'),
        textMessage('Claude', ''),
      ];

      const result = formatter.buildMessages(messages, {
        participantMode: 'multiuser',
        assistantParticipant: 'Claude',
        tools: [calculatorTool],
      });

      expect(result.nativeTools).toBeDefined();
      expect(result.nativeTools?.length).toBe(1);
      expect((result.nativeTools?.[0] as any)?.name).toBe('calculate');
    });

    it('adds context prefix as first cached assistant message', () => {
      const formatter = new AnthropicXmlFormatter();
      const messages: NormalizedMessage[] = [
        textMessage('User', 'Hello'),
        textMessage('Claude', ''),
      ];

      const result = formatter.buildMessages(messages, {
        participantMode: 'multiuser',
        assistantParticipant: 'Claude',
        systemPrompt: 'You are helpful.',
        contextPrefix: 'You are a helpful assistant named Bob.',
        promptCaching: true,
      });

      // The Claude Messages API requires the first message to be the user's.
      expect(result.messages.length).toBeGreaterThanOrEqual(3);
      expect(result.messages[0]?.role).toBe('user');
      expect(result.messages[0]?.content).toBe('[Start]');

      expect(result.messages[1]?.role).toBe('assistant');

      const prefixContent = result.messages[1]?.content as any[];
      expect(Array.isArray(prefixContent)).toBe(true);
      expect(prefixContent[0]?.text).toBe('You are a helpful assistant named Bob.');
      expect(prefixContent[0]?.cache_control).toEqual({ type: 'ephemeral' });

      expect(result.cacheMarkersApplied).toBe(2);
    });

    it('adds cache_control to system prompt when promptCaching is enabled', () => {
      const formatter = new AnthropicXmlFormatter();
      const messages: NormalizedMessage[] = [
        textMessage('User', 'Hello'),
        textMessage('Claude', ''),
      ];

      const result = formatter.buildMessages(messages, {
        participantMode: 'multiuser',
        assistantParticipant: 'Claude',
        systemPrompt: 'You are helpful.',
        promptCaching: true,
      });

      const systemContent = result.systemContent as any[];
      expect(Array.isArray(systemContent)).toBe(true);
      expect(systemContent[0]?.cache_control).toEqual({ type: 'ephemeral' });
      expect(result.cacheMarkersApplied).toBe(1);
    });

    it('flushes content with cache_control when hasCacheMarker returns true', () => {
      const formatter = new AnthropicXmlFormatter();
      const messages: NormalizedMessage[] = [
        textMessage('User', 'Message 1'),
        textMessage('Claude', 'Response 1'),
        textMessage('User', 'Message 2 - cache boundary'),
        textMessage('Claude', 'Response 2'),
        textMessage('User', 'Message 3'),
        textMessage('Claude', ''),
      ];

      const result = formatter.buildMessages(messages, {
        participantMode: 'multiuser',
        assistantParticipant: 'Claude',
        promptCaching: true,
        hasCacheMarker: (msg, index) => index === 2,
      });

      expect(result.cacheMarkersApplied).toBeGreaterThanOrEqual(1);

      const messagesWithCacheControl = result.messages.filter(m => {
        if (Array.isArray(m.content)) {
          return (m.content as any[]).some(block => block.cache_control);
        }
        return false;
      });

      expect(messagesWithCacheControl.length).toBeGreaterThanOrEqual(1);
    });

    it('does not add cache_control when promptCaching is false', () => {
      const formatter = new AnthropicXmlFormatter();
      const messages: NormalizedMessage[] = [
        textMessage('User', 'Hello'),
        textMessage('Claude', ''),
      ];

      const result = formatter.buildMessages(messages, {
        participantMode: 'multiuser',
        assistantParticipant: 'Claude',
        systemPrompt: 'You are helpful.',
        promptCaching: false,
      });

      const systemContent = result.systemContent as any[];
      expect(systemContent[0]?.cache_control).toBeUndefined();
      expect(result.cacheMarkersApplied).toBe(0);
    });

    it('applies cache_control when message has cacheBreakpoint', () => {
      const formatter = new AnthropicXmlFormatter();
      const messages: NormalizedMessage[] = [
        textMessage('User', 'Message 1'),
        textMessage('Claude', 'Response 1'),
        { ...textMessage('User', 'Message 2'), cacheBreakpoint: true },
        textMessage('Claude', 'Response 2'),
        textMessage('User', 'Message 3'),
        textMessage('Claude', ''),
      ];

      const result = formatter.buildMessages(messages, {
        participantMode: 'multiuser',
        assistantParticipant: 'Claude',
        promptCaching: true,
      });

      expect(result.cacheMarkersApplied).toBeGreaterThanOrEqual(1);

      const messagesWithCacheControl = result.messages.filter(m => {
        if (Array.isArray(m.content)) {
          return (m.content as any[]).some(block => block.cache_control);
        }
        return false;
      });

      expect(messagesWithCacheControl.length).toBeGreaterThanOrEqual(1);

      const cachedContent = messagesWithCacheControl[0]?.content as any[];
      expect(cachedContent[0]?.text).toContain('Message 2');
    });

    it('supports multiple cacheBreakpoint messages', () => {
      const formatter = new AnthropicXmlFormatter();
      const messages: NormalizedMessage[] = [
        textMessage('User', 'Message 1'),
        { ...textMessage('Claude', 'Response 1'), cacheBreakpoint: true },
        textMessage('User', 'Message 2'),
        { ...textMessage('Claude', 'Response 2'), cacheBreakpoint: true },
        textMessage('User', 'Message 3'),
        textMessage('Claude', ''),
      ];

      const result = formatter.buildMessages(messages, {
        participantMode: 'multiuser',
        assistantParticipant: 'Claude',
        promptCaching: true,
      });

      const messagesWithCacheControl = result.messages.filter(m => {
        if (Array.isArray(m.content)) {
          return (m.content as any[]).some(block => block.cache_control);
        }
        return false;
      });

      expect(messagesWithCacheControl.length).toBeGreaterThanOrEqual(2);
    });

    it('cacheBreakpoint has no effect when promptCaching is false', () => {
      const formatter = new AnthropicXmlFormatter();
      const messages: NormalizedMessage[] = [
        textMessage('User', 'Message 1'),
        { ...textMessage('Claude', 'Response 1'), cacheBreakpoint: true },
        textMessage('User', 'Message 2'),
        textMessage('Claude', ''),
      ];

      const result = formatter.buildMessages(messages, {
        participantMode: 'multiuser',
        assistantParticipant: 'Claude',
        promptCaching: false,
      });

      expect(result.cacheMarkersApplied).toBe(0);

      const messagesWithCacheControl = result.messages.filter(m => {
        if (Array.isArray(m.content)) {
          return (m.content as any[]).some(block => block.cache_control);
        }
        return false;
      });

      expect(messagesWithCacheControl.length).toBe(0);
    });
  });

  describe('formatToolResults', () => {
    it('formats tool results as XML', () => {
      const formatter = new AnthropicXmlFormatter();
      const results: ToolResult[] = [
        { toolUseId: 'tool_1', content: '42' },
      ];

      const xml = formatter.formatToolResults(results);

      expect(xml).toContain('<function_results>');
      expect(xml).toContain('</function_results>');
      expect(xml).toContain('42');
    });

    it('adds thinking tag when option is set', () => {
      const formatter = new AnthropicXmlFormatter();
      const results: ToolResult[] = [
        { toolUseId: 'tool_1', content: 'result' },
      ];

      const xml = formatter.formatToolResults(results, { thinking: true });

      expect(xml).toContain('<thinking>');
    });
  });

  describe('parseToolCalls', () => {
    it('parses tool calls from XML content', () => {
      const formatter = new AnthropicXmlFormatter();
      const content = `Some text
<function_calls>
<invoke name="calculate">
<parameter name="expression">2 + 2</parameter>
</invoke>
</function_calls>`;

      const calls = formatter.parseToolCalls(content);

      expect(calls.length).toBe(1);
      expect(calls[0]?.name).toBe('calculate');
      expect(calls[0]?.input).toEqual({ expression: '2 + 2' });
    });

    it('returns empty array when no tool calls', () => {
      const formatter = new AnthropicXmlFormatter();
      const content = 'Just regular text without any tool calls.';

      const calls = formatter.parseToolCalls(content);

      expect(calls).toEqual([]);
    });
  });

  describe('hasToolUse', () => {
    it('detects function_calls tag', () => {
      const formatter = new AnthropicXmlFormatter();

      expect(formatter.hasToolUse('<function_calls>')).toBe(true);
      expect(formatter.hasToolUse('<function_calls>')).toBe(true);
      expect(formatter.hasToolUse('no tools here')).toBe(false);
    });
  });

  describe('createStreamParser', () => {
    it('creates a working stream parser', () => {
      const formatter = new AnthropicXmlFormatter();
      const parser = formatter.createStreamParser();

      expect(parser).toBeDefined();
      expect(typeof parser.processChunk).toBe('function');
      expect(typeof parser.flush).toBe('function');
      expect(typeof parser.getAccumulated).toBe('function');
      expect(typeof parser.isInsideBlock).toBe('function');
    });

    it('parser tracks XML depth', () => {
      const formatter = new AnthropicXmlFormatter();
      const parser = formatter.createStreamParser();

      parser.processChunk('Hello <thinking>');
      expect(parser.isInsideBlock()).toBe(true);
      expect(parser.getCurrentBlockType()).toBe('thinking');

      parser.processChunk('some thoughts</thinking>');
      expect(parser.isInsideBlock()).toBe(false);
    });
  });

  describe('parseContentBlocks', () => {
    it('parses thinking blocks', () => {
      const formatter = new AnthropicXmlFormatter();
      const content = '<thinking>My thoughts</thinking>Final answer';

      const blocks = formatter.parseContentBlocks(content);

      expect(blocks.length).toBe(2);
      expect(blocks[0]?.type).toBe('thinking');
      expect((blocks[0] as any).thinking).toBe('My thoughts');
      expect(blocks[1]?.type).toBe('text');
    });

    it('parses tool use blocks', () => {
      const formatter = new AnthropicXmlFormatter();
      const content = `<function_calls>
<invoke name="test">
<parameter name="arg">value</parameter>
</invoke>
</function_calls>`;

      const blocks = formatter.parseContentBlocks(content);

      const toolUseBlock = blocks.find(b => b.type === 'tool_use');
      expect(toolUseBlock).toBeDefined();
    });
  });
});

describe('NativeFormatter', () => {
  describe('thinking block round-trip', () => {
    it('emits thinking blocks with signatures in assistant turns', () => {
      const formatter = new NativeFormatter();
      const messages: NormalizedMessage[] = [
        textMessage('Alice', 'Hello'),
        {
          participant: 'Claude',
          content: [
            { type: 'thinking', thinking: 'prior reasoning', signature: 'sig_123' } as any,
            { type: 'text', text: 'My answer' },
          ],
        },
        textMessage('Alice', 'Next question'),
      ];

      const result = formatter.buildMessages(messages, {
        participantMode: 'multiuser',
        assistantParticipant: 'Claude',
      });

      const assistant = result.messages.find(m => m.role === 'assistant');
      const content = assistant?.content as any[];
      expect(content[0].type).toBe('thinking');
      expect(content[0].thinking).toBe('prior reasoning');
      expect(content[0].signature).toBe('sig_123');
      expect(content[1].type).toBe('text');
    });

    it('emits signature-only thinking blocks (display omitted) verbatim', () => {
      const formatter = new NativeFormatter();
      const messages: NormalizedMessage[] = [
        textMessage('Alice', 'Hello'),
        {
          participant: 'Claude',
          content: [
            { type: 'thinking', thinking: '', signature: 'sig_encrypted' } as any,
            { type: 'text', text: 'My answer' },
          ],
        },
        textMessage('Alice', 'Next'),
      ];

      const result = formatter.buildMessages(messages, {
        participantMode: 'multiuser',
        assistantParticipant: 'Claude',
      });

      const assistant = result.messages.find(m => m.role === 'assistant');
      const content = assistant?.content as any[];
      expect(content[0].type).toBe('thinking');
      expect(content[0].thinking).toBe('');
      expect(content[0].signature).toBe('sig_encrypted');
    });
  });

  describe('buildMessages', () => {
    it('builds simple user/assistant messages', () => {
      const formatter = new NativeFormatter();
      const messages: NormalizedMessage[] = [
        textMessage('Human', 'Hello'),
        textMessage('Claude', 'Hi there!'),
        textMessage('Human', 'How are you?'),
      ];

      const result = formatter.buildMessages(messages, {
        participantMode: 'simple',
        assistantParticipant: 'Claude',
        humanParticipant: 'Human',
      });

      expect(result.messages.length).toBe(3);
      expect(result.messages[0]?.role).toBe('user');
      expect(result.messages[1]?.role).toBe('assistant');
      expect(result.messages[2]?.role).toBe('user');
    });

    it('throws error in simple mode with unknown participant', () => {
      const formatter = new NativeFormatter();
      const messages: NormalizedMessage[] = [
        textMessage('Alice', 'Hello'),
      ];

      expect(() => formatter.buildMessages(messages, {
        participantMode: 'simple',
        assistantParticipant: 'Claude',
        humanParticipant: 'Human',
      })).toThrow();
    });

    it('includes name prefix in multiuser mode', () => {
      const formatter = new NativeFormatter();
      const messages: NormalizedMessage[] = [
        textMessage('Alice', 'Hello'),
        textMessage('Bob', 'Hi'),
        textMessage('Claude', 'Hello everyone'),
      ];

      const result = formatter.buildMessages(messages, {
        participantMode: 'multiuser',
        assistantParticipant: 'Claude',
      });

      const firstContent = result.messages[0]?.content as any[];
      expect(firstContent[0]?.text).toContain('Alice:');
    });

    it('merges consecutive same-role messages', () => {
      const formatter = new NativeFormatter();
      const messages: NormalizedMessage[] = [
        textMessage('Alice', 'Hello'),
        textMessage('Bob', 'Hi'),
        textMessage('Claude', 'Hello everyone'),
      ];

      const result = formatter.buildMessages(messages, {
        participantMode: 'multiuser',
        assistantParticipant: 'Claude',
      });

      expect(result.messages.length).toBe(2);
      expect(result.messages[0]?.role).toBe('user');
      expect(result.messages[1]?.role).toBe('assistant');
    });

    it('returns native tools', () => {
      const formatter = new NativeFormatter();
      const messages: NormalizedMessage[] = [
        textMessage('Human', 'Calculate something'),
      ];

      const result = formatter.buildMessages(messages, {
        participantMode: 'simple',
        assistantParticipant: 'Claude',
        humanParticipant: 'Human',
        tools: [calculatorTool],
      });

      expect(result.nativeTools).toBeDefined();
      expect(result.nativeTools?.length).toBe(1);
    });

    it('returns empty stop sequences', () => {
      const formatter = new NativeFormatter();
      const messages: NormalizedMessage[] = [
        textMessage('Human', 'Hello'),
      ];

      const result = formatter.buildMessages(messages, {
        participantMode: 'simple',
        assistantParticipant: 'Claude',
        humanParticipant: 'Human',
      });

      expect(result.stopSequences).toEqual([]);
    });
  });

  describe('createStreamParser', () => {
    it('creates a passthrough parser', () => {
      const formatter = new NativeFormatter();
      const parser = formatter.createStreamParser();

      expect(parser).toBeDefined();
      expect(parser.isInsideBlock()).toBe(false);
    });

    it('parser accumulates content', () => {
      const formatter = new NativeFormatter();
      const parser = formatter.createStreamParser();

      parser.processChunk('Hello ');
      parser.processChunk('world');

      expect(parser.getAccumulated()).toBe('Hello world');
    });

    it('parser always reports text block type', () => {
      const formatter = new NativeFormatter();
      const parser = formatter.createStreamParser();

      parser.processChunk('any content');
      expect(parser.getCurrentBlockType()).toBe('text');
    });
  });

  describe('parseToolCalls', () => {
    it('returns empty array (native mode uses API)', () => {
      const formatter = new NativeFormatter();
      const calls = formatter.parseToolCalls('any content');
      expect(calls).toEqual([]);
    });
  });

  describe('hasToolUse', () => {
    it('returns false (native mode uses API stop_reason)', () => {
      const formatter = new NativeFormatter();
      expect(formatter.hasToolUse('any content')).toBe(false);
    });
  });

  describe('parseContentBlocks', () => {
    it('returns text block for plain content', () => {
      const formatter = new NativeFormatter();
      const blocks = formatter.parseContentBlocks('Hello world');

      expect(blocks.length).toBe(1);
      expect(blocks[0]?.type).toBe('text');
      expect((blocks[0] as any).text).toBe('Hello world');
    });

    it('returns empty array for empty content', () => {
      const formatter = new NativeFormatter();
      const blocks = formatter.parseContentBlocks('   ');
      expect(blocks).toEqual([]);
    });
  });

  describe('usesPrefill property', () => {
    it('NativeFormatter does not use prefill', () => {
      const formatter = new NativeFormatter();
      expect(formatter.usesPrefill).toBe(false);
    });

    it('AnthropicXmlFormatter uses prefill', () => {
      const formatter = new AnthropicXmlFormatter();
      expect(formatter.usesPrefill).toBe(true);
    });
  });
});

describe('CompletionsFormatter', () => {
  describe('buildMessages', () => {
    it('serializes conversation to prompt format', () => {
      const formatter = new CompletionsFormatter();
      const messages: NormalizedMessage[] = [
        textMessage('Alice', 'Hello'),
        textMessage('Bob', 'Hi there'),
        textMessage('Assistant', ''),
      ];

      const result = formatter.buildMessages(messages, {
        participantMode: 'multiuser',
        assistantParticipant: 'Assistant',
      });

      expect(result.messages.length).toBe(1);
      expect(result.assistantPrefill).toBeDefined();

      const prompt = result.assistantPrefill!;
      expect(prompt).toContain('Alice: Hello');
      expect(prompt).toContain('Bob: Hi there');
      expect(prompt).toContain('Assistant:');
    });

    it('adds EOT tokens after messages', () => {
      const formatter = new CompletionsFormatter({ eotToken: '<|eot|>' });
      const messages: NormalizedMessage[] = [
        textMessage('User', 'Hello'),
        textMessage('Assistant', ''),
      ];

      const result = formatter.buildMessages(messages, {
        participantMode: 'multiuser',
        assistantParticipant: 'Assistant',
      });

      const prompt = result.assistantPrefill!;
      expect(prompt).toContain('User: Hello<|eot|>');
      expect(prompt).toMatch(/Assistant:$/);
    });

    it('uses custom EOT token', () => {
      const formatter = new CompletionsFormatter({ eotToken: '</s>' });
      const messages: NormalizedMessage[] = [
        textMessage('User', 'Hello'),
        textMessage('Assistant', ''),
      ];

      const result = formatter.buildMessages(messages, {
        participantMode: 'multiuser',
        assistantParticipant: 'Assistant',
      });

      expect(result.assistantPrefill).toContain('Hello</s>');
    });

    it('generates stop sequences from participants', () => {
      const formatter = new CompletionsFormatter();
      const messages: NormalizedMessage[] = [
        textMessage('Alice', 'Hello'),
        textMessage('Bob', 'Hi'),
        textMessage('Claude', ''),
      ];

      const result = formatter.buildMessages(messages, {
        participantMode: 'multiuser',
        assistantParticipant: 'Claude',
      });

      expect(result.stopSequences).toContain('\n\nAlice:');
      expect(result.stopSequences).toContain('\nAlice:');
      expect(result.stopSequences).toContain('\n\nBob:');
      expect(result.stopSequences).toContain('\nBob:');
      expect(result.stopSequences).not.toContain('\nClaude:');
    });

    it('includes EOT token in stop sequences', () => {
      const formatter = new CompletionsFormatter({ eotToken: '<|eot|>' });
      const messages: NormalizedMessage[] = [
        textMessage('User', 'Hello'),
        textMessage('Assistant', ''),
      ];

      const result = formatter.buildMessages(messages, {
        participantMode: 'multiuser',
        assistantParticipant: 'Assistant',
      });

      expect(result.stopSequences).toContain('<|eot|>');
    });

    it('includes system prompt at beginning', () => {
      const formatter = new CompletionsFormatter();
      const messages: NormalizedMessage[] = [
        textMessage('User', 'Hello'),
        textMessage('Assistant', ''),
      ];

      const result = formatter.buildMessages(messages, {
        participantMode: 'multiuser',
        assistantParticipant: 'Assistant',
        systemPrompt: 'You are a helpful assistant.',
      });

      const prompt = result.assistantPrefill!;
      expect(prompt.startsWith('You are a helpful assistant.')).toBe(true);
    });

    it('uses custom name format', () => {
      const formatter = new CompletionsFormatter({ nameFormat: '[{name}] ' });
      const messages: NormalizedMessage[] = [
        textMessage('User', 'Hello'),
        textMessage('Bot', ''),
      ];

      const result = formatter.buildMessages(messages, {
        participantMode: 'multiuser',
        assistantParticipant: 'Bot',
      });

      const prompt = result.assistantPrefill!;
      expect(prompt).toContain('[User] Hello');
      expect(prompt).toContain('[Bot]');
    });

    it('uses custom message separator', () => {
      const formatter = new CompletionsFormatter({ messageSeparator: '\n---\n' });
      const messages: NormalizedMessage[] = [
        textMessage('User', 'Hello'),
        textMessage('Assistant', 'Hi'),
        textMessage('User', 'Bye'),
        textMessage('Assistant', ''),
      ];

      const result = formatter.buildMessages(messages, {
        participantMode: 'multiuser',
        assistantParticipant: 'Assistant',
      });

      const prompt = result.assistantPrefill!;
      expect(prompt).toContain('\n---\n');
    });

    it('includes additional stop sequences', () => {
      const formatter = new CompletionsFormatter();
      const messages: NormalizedMessage[] = [
        textMessage('User', 'Hello'),
        textMessage('Assistant', ''),
      ];

      const result = formatter.buildMessages(messages, {
        participantMode: 'multiuser',
        assistantParticipant: 'Assistant',
        additionalStopSequences: ['STOP', 'END'],
      });

      expect(result.stopSequences).toContain('STOP');
      expect(result.stopSequences).toContain('END');
    });
  });

  describe('createStreamParser', () => {
    it('creates a passthrough parser', () => {
      const formatter = new CompletionsFormatter();
      const parser = formatter.createStreamParser();

      expect(parser).toBeDefined();
      expect(parser.isInsideBlock()).toBe(false);
    });

    it('parser accumulates content', () => {
      const formatter = new CompletionsFormatter();
      const parser = formatter.createStreamParser();

      parser.processChunk('Hello ');
      parser.processChunk('world');

      expect(parser.getAccumulated()).toBe('Hello world');
    });
  });

  describe('parseContentBlocks', () => {
    it('trims leading whitespace', () => {
      const formatter = new CompletionsFormatter();
      const blocks = formatter.parseContentBlocks('  \n  Hello world');

      expect(blocks.length).toBe(1);
      expect((blocks[0] as any).text).toBe('Hello world');
    });

    it('returns empty array for whitespace-only content', () => {
      const formatter = new CompletionsFormatter();
      const blocks = formatter.parseContentBlocks('   \n  ');
      expect(blocks).toEqual([]);
    });
  });

  describe('parseToolCalls', () => {
    it('returns empty array (base models have no tools)', () => {
      const formatter = new CompletionsFormatter();
      const calls = formatter.parseToolCalls('any content');
      expect(calls).toEqual([]);
    });
  });

  describe('hasToolUse', () => {
    it('returns false (base models have no tools)', () => {
      const formatter = new CompletionsFormatter();
      expect(formatter.hasToolUse('any content')).toBe(false);
    });
  });

  describe('usesPrefill property', () => {
    it('CompletionsFormatter uses prefill', () => {
      const formatter = new CompletionsFormatter();
      expect(formatter.usesPrefill).toBe(true);
    });
  });
});

describe('NativeFormatter > tool blocks', () => {
  it('positive: well-formed [u: tool_use] → [u: tool_result] passes through unchanged', () => {
    const formatter = new NativeFormatter();
    const messages: NormalizedMessage[] = [
      { participant: 'Human', content: [{ type: 'text', text: 'go' }] },
      { participant: 'Claude', content: [
        { type: 'tool_use', id: 'A', name: 'calculate', input: { expression: '1+1' } },
      ]},
      { participant: 'Human', content: [
        { type: 'tool_result', toolUseId: 'A', content: '2' },
      ]},
    ];
    const result = formatter.buildMessages(messages, {
      participantMode: 'simple',
      assistantParticipant: 'Claude',
      humanParticipant: 'Human',
    });

    expect(result.ready).toBe(true);
    expect(result.messages.length).toBe(3);
    expect(result.messages[0]!.role).toBe('user');
    expect(result.messages[1]!.role).toBe('assistant');
    expect(result.messages[2]!.role).toBe('user');
    const assistantContent = result.messages[1]!.content as { type: string }[];
    expect(assistantContent.some((b) => b.type === 'tool_use')).toBe(true);
    const userContent = result.messages[2]!.content as { type: string }[];
    expect(userContent.some((b) => b.type === 'tool_result')).toBe(true);
  });

  it('inverse: tool_use in a user-participant message is re-roled to assistant', () => {
    // The API refuses a tool_use in a user-role message with a 400.
    const formatter = new NativeFormatter();
    const messages: NormalizedMessage[] = [
      {
        participant: 'Human',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'tool_use', id: 'A', name: 'calculate', input: {} },
          { type: 'tool_result', toolUseId: 'A', content: 'ok' },
          { type: 'text', text: 'continuing' },
        ],
      },
    ];
    const result = formatter.buildMessages(messages, {
      participantMode: 'simple',
      assistantParticipant: 'Claude',
      humanParticipant: 'Human',
    });

    const assistantEnv = result.messages.find((m) => m.role === 'assistant');
    expect(assistantEnv).toBeDefined();
    const assistantBlocks = assistantEnv!.content as { type: string }[];
    expect(assistantBlocks.some((b) => b.type === 'tool_use')).toBe(true);
    expect(assistantBlocks.some((b) => b.type === 'tool_result')).toBe(false);

    const assistantIdx = result.messages.findIndex((m) => m.role === 'assistant');
    const after = result.messages[assistantIdx + 1];
    expect(after).toBeDefined();
    expect(after!.role).toBe('user');
    const afterBlocks = after!.content as { type: string }[];
    expect(afterBlocks.some((b) => b.type === 'tool_result')).toBe(true);
  });

  it('emits NormalizeEvents via onNormalize callback', () => {
    const formatter = new NativeFormatter();
    const events: Array<{ kind: string }> = [];
    formatter.buildMessages(
      [
        {
          participant: 'Human',
          content: [
            { type: 'tool_use', id: 'A', name: 'calc', input: {} },
            { type: 'tool_result', toolUseId: 'A', content: 'ok' },
          ],
        },
      ],
      {
        participantMode: 'simple',
        assistantParticipant: 'Claude',
        humanParticipant: 'Human',
        onNormalize: (e) => events.push(e),
      },
    );
    expect(events.some((e) => e.kind === 'block_re_roled')).toBe(true);
  });
});
