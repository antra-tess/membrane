/**
 * Tests for tool schema handling, participant role mapping,
 * and tool mode resolution in Membrane.
 */

import { describe, it, expect } from 'vitest';
import { AnthropicXmlFormatter } from '../../src/formatters/anthropic-xml.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { Membrane } from '../../src/membrane.js';
import { MockAdapter } from '../../src/providers/mock.js';
import type { NormalizedMessage, NormalizedRequest, ToolDefinition } from '../../src/types/index.js';

// ============================================================================
// Helpers
// ============================================================================

function textMessage(participant: string, text: string): NormalizedMessage {
  return { participant, content: [{ type: 'text', text }] };
}

/** A tool with no properties key — valid JSON Schema for no-arg tools. */
const noArgTool: ToolDefinition = {
  name: 'get_status',
  description: 'Get current status',
  inputSchema: {
    type: 'object' as const,
  },
};

/** A tool with an explicit empty properties object. */
const emptyPropertiesTool: ToolDefinition = {
  name: 'ping',
  description: 'Ping the server',
  inputSchema: {
    type: 'object' as const,
    properties: {},
  },
};

/** A normal tool with properties for comparison. */
const normalTool: ToolDefinition = {
  name: 'calculate',
  description: 'Performs a calculation',
  inputSchema: {
    type: 'object' as const,
    properties: {
      expression: { type: 'string', description: 'Math expression' },
    },
    required: ['expression'],
  },
};

// ============================================================================
// 1. XML formatter: no-arg tools don't crash
// ============================================================================

describe('AnthropicXmlFormatter: no-properties tools', () => {
  it('formats a tool with no properties key without crashing', () => {
    const formatter = new AnthropicXmlFormatter();
    const messages: NormalizedMessage[] = [
      textMessage('User', 'Check status'),
      textMessage('Claude', ''),
    ];

    const result = formatter.buildMessages(messages, {
      participantMode: 'multiuser',
      assistantParticipant: 'Claude',
      tools: [noArgTool],
    });

    expect(result.messages.length).toBeGreaterThan(0);
    const allContent = result.messages
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('');
    expect(allContent).toContain('get_status');
  });

  it('formats a tool with empty properties object', () => {
    const formatter = new AnthropicXmlFormatter();
    const messages: NormalizedMessage[] = [
      textMessage('User', 'Ping'),
      textMessage('Claude', ''),
    ];

    const result = formatter.buildMessages(messages, {
      participantMode: 'multiuser',
      assistantParticipant: 'Claude',
      tools: [emptyPropertiesTool],
    });

    expect(result.messages.length).toBeGreaterThan(0);
    const allContent = result.messages
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('');
    expect(allContent).toContain('ping');
  });

  it('formats a mix of no-arg and normal tools', () => {
    const formatter = new AnthropicXmlFormatter();
    const messages: NormalizedMessage[] = [
      textMessage('User', 'Do things'),
      textMessage('Claude', ''),
    ];

    const result = formatter.buildMessages(messages, {
      participantMode: 'multiuser',
      assistantParticipant: 'Claude',
      tools: [noArgTool, normalTool],
    });

    const allContent = result.messages
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('');
    expect(allContent).toContain('get_status');
    expect(allContent).toContain('calculate');
  });
});

// ============================================================================
// 2. assistantParticipant role mapping
//
// The request-level assistantParticipant is used in buildNativeToolRequest,
// which is only called from the streaming native-tool path. The complete()
// path goes through transformRequest → formatter.buildMessages, which reads
// config-level assistantParticipant only. So we test:
//   - config-level via complete() (formatter path)
//   - request-level via stream() (buildNativeToolRequest path)
// ============================================================================

describe('Membrane: assistantParticipant role mapping', () => {
  it('maps non-Claude participant to assistant role via request field (stream path)', async () => {
    const adapter = new MockAdapter();
    const membrane = new Membrane(adapter, {
      formatter: new NativeFormatter(),
    });

    const request: NormalizedRequest = {
      messages: [
        textMessage('User', 'Hello'),
        textMessage('commander', 'Greetings.'),
        textMessage('User', 'Status?'),
      ],
      tools: [normalTool],
      config: { model: 'test-model', maxTokens: 100 },
      assistantParticipant: 'commander',
    };

    // stream() uses resolveToolMode → streamWithNativeTools → buildNativeToolRequest
    await membrane.stream(request);

    const lastRequest = adapter.getLastRequest()!;
    expect(lastRequest).toBeDefined();

    // The second message (participant 'commander') should have role 'assistant'
    const roles = lastRequest.messages.map((m: any) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'user']);
  });

  it('maps non-Claude participant to assistant role via config (complete path)', async () => {
    const adapter = new MockAdapter();
    const membrane = new Membrane(adapter, {
      formatter: new NativeFormatter(),
      assistantParticipant: 'agent',
    });

    const request: NormalizedRequest = {
      messages: [
        textMessage('User', 'Hello'),
        textMessage('agent', 'Hi.'),
        textMessage('User', 'Bye'),
      ],
      config: { model: 'test-model', maxTokens: 100 },
    };

    await membrane.complete(request);

    const lastRequest = adapter.getLastRequest()!;
    const roles = lastRequest.messages.map((m: any) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'user']);
  });

  it('request-level assistantParticipant overrides config-level (stream path)', async () => {
    const adapter = new MockAdapter();
    const membrane = new Membrane(adapter, {
      formatter: new NativeFormatter(),
      assistantParticipant: 'wrong-name',
    });

    const request: NormalizedRequest = {
      messages: [
        textMessage('User', 'Hello'),
        textMessage('correct-name', 'Hi.'),
      ],
      tools: [normalTool],
      config: { model: 'test-model', maxTokens: 100 },
      assistantParticipant: 'correct-name',
    };

    await membrane.stream(request);

    const lastRequest = adapter.getLastRequest()!;
    const roles = lastRequest.messages.map((m: any) => m.role);
    expect(roles).toEqual(['user', 'assistant']);
  });

  it('defaults to Claude when no assistantParticipant specified', async () => {
    const adapter = new MockAdapter();
    const membrane = new Membrane(adapter, {
      formatter: new NativeFormatter(),
    });

    const request: NormalizedRequest = {
      messages: [
        textMessage('User', 'Hello'),
        textMessage('Claude', 'Hi.'),
        textMessage('User', 'Bye'),
      ],
      config: { model: 'test-model', maxTokens: 100 },
    };

    await membrane.complete(request);

    const lastRequest = adapter.getLastRequest()!;
    const roles = lastRequest.messages.map((m: any) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'user']);
  });
});

// ============================================================================
// 3. resolveToolMode with NativeFormatter
// ============================================================================

describe('Membrane: resolveToolMode', () => {
  it('uses native tool mode when NativeFormatter is configured', async () => {
    const adapter = new MockAdapter();
    const membrane = new Membrane(adapter, {
      formatter: new NativeFormatter(),
    });

    const request: NormalizedRequest = {
      messages: [textMessage('User', 'Hello')],
      tools: [normalTool],
      config: { model: 'test-model', maxTokens: 100 },
    };

    await membrane.complete(request);

    const lastRequest = adapter.getLastRequest()!;
    // Native tool mode passes tools in the provider request
    expect(lastRequest.tools).toBeDefined();
    expect(lastRequest.tools.length).toBe(1);
    expect(lastRequest.tools[0].name).toBe('calculate');
  });

  it('uses XML tool mode with default AnthropicXmlFormatter', async () => {
    const adapter = new MockAdapter();
    const membrane = new Membrane(adapter);

    const request: NormalizedRequest = {
      messages: [
        textMessage('User', 'Hello'),
        textMessage('Claude', ''),
      ],
      tools: [normalTool],
      config: { model: 'test-model', maxTokens: 100 },
    };

    await membrane.complete(request);

    const lastRequest = adapter.getLastRequest()!;
    // XML tool mode injects tools into message content, not provider request
    expect(lastRequest.tools).toBeUndefined();
    // Tool definitions appear in the message content as XML
    const content = lastRequest.messages
      .map((m: any) => (typeof m.content === 'string' ? m.content : ''))
      .join('');
    expect(content).toContain('calculate');
  });

  it('explicit native toolMode with XML formatter sends tools natively', async () => {
    const adapter = new MockAdapter();
    const membrane = new Membrane(adapter); // default AnthropicXmlFormatter

    const request: NormalizedRequest = {
      messages: [textMessage('User', 'Hello')],
      tools: [normalTool],
      toolMode: 'native',
      config: { model: 'test-model', maxTokens: 100 },
    };

    // stream() with explicit 'native' should use streamWithNativeTools
    // even though the default formatter is AnthropicXmlFormatter
    await membrane.stream(request);

    const lastRequest = adapter.getLastRequest()!;
    expect(lastRequest.tools).toBeDefined();
    expect(lastRequest.tools.length).toBe(1);
    expect(lastRequest.tools[0].name).toBe('calculate');
  });
});
