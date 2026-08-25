/**
 * Tool-mode resolution against measured model capability.
 *
 * The default tool mode is native wherever the target can carry native tools;
 * XML/prefill is an explicit opt-in or the fallback for a native-less
 * formatter. A prefill build aimed at a model that refuses assistant prefill
 * fails here, typed, instead of surfacing a provider 400.
 */

import { describe, it, expect } from 'vitest';
import { AnthropicXmlFormatter } from '../../src/formatters/anthropic-xml.js';
import { CompletionsFormatter } from '../../src/formatters/completions.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { Membrane } from '../../src/membrane.js';
import { MockAdapter } from '../../src/providers/mock.js';
import { supportsAssistantPrefill } from '../../src/registry/model-capabilities.js';
import { MembraneError } from '../../src/types/errors.js';
import type { NormalizedMessage, NormalizedRequest, ToolDefinition } from '../../src/types/index.js';

function textMessage(participant: string, text: string): NormalizedMessage {
  return { participant, content: [{ type: 'text', text }] };
}

const zzTool1: ToolDefinition = {
  name: 'zz_lookup1',
  description: 'Look up a zz-record',
  inputSchema: {
    type: 'object' as const,
    properties: {
      fld1: { type: 'string', description: 'record key' },
    },
    required: ['fld1'],
  },
};

describe('supportsAssistantPrefill', () => {
  it('reports refusal for the Claude 4.6+ and 5-series ids measured 2026-08-25', () => {
    expect(supportsAssistantPrefill('claude-sonnet-4-6')).toBe(false);
    expect(supportsAssistantPrefill('claude-opus-4-6')).toBe(false);
    expect(supportsAssistantPrefill('claude-opus-4-7')).toBe(false);
    expect(supportsAssistantPrefill('claude-opus-4-8')).toBe(false);
    expect(supportsAssistantPrefill('claude-sonnet-5')).toBe(false);
    expect(supportsAssistantPrefill('claude-fable-5')).toBe(false);
  });

  it('reports support for the ids that accepted prefill live', () => {
    expect(supportsAssistantPrefill('claude-haiku-4-5-20251001')).toBe(true);
    expect(supportsAssistantPrefill('claude-sonnet-4-5')).toBe(true);
  });

  it('matches dated snapshots and vendor-prefixed ids', () => {
    expect(supportsAssistantPrefill('claude-opus-4-8-20251001')).toBe(false);
    expect(supportsAssistantPrefill('anthropic/claude-sonnet-4-6')).toBe(false);
    expect(supportsAssistantPrefill('us.anthropic.claude-sonnet-4-6-v1:0')).toBe(false);
  });

  it('treats unknown and non-Anthropic models as prefill-capable', () => {
    expect(supportsAssistantPrefill('gpt-5.6')).toBe(true);
    expect(supportsAssistantPrefill('zz-model-1')).toBe(true);
  });
});

describe('resolveToolMode default', () => {
  it('defaults to native tools with the default AnthropicXmlFormatter', async () => {
    const adapter = new MockAdapter();
    const membrane = new Membrane(adapter);

    const request: NormalizedRequest = {
      messages: [textMessage('User', 'Hello')],
      tools: [zzTool1],
      config: { model: 'claude-sonnet-4-6', maxTokens: 100 },
    };

    // The default path now reaches a prefill-refusing model at all: native
    // tools build through buildNativeToolRequest, which ends on the user turn.
    await membrane.stream(request);

    const lastRequest = adapter.getLastRequest()!;
    expect(lastRequest.tools).toBeDefined();
    expect(lastRequest.tools.length).toBe(1);
    expect(lastRequest.tools[0].name).toBe('zz_lookup1');
    expect(lastRequest.messages[lastRequest.messages.length - 1].role).toBe('user');
  });

  it('keeps XML tools when the caller asks for them on a prefill-capable model', async () => {
    const adapter = new MockAdapter();
    const membrane = new Membrane(adapter);

    const request: NormalizedRequest = {
      messages: [textMessage('User', 'Hello')],
      tools: [zzTool1],
      toolMode: 'xml',
      config: { model: 'claude-haiku-4-5-20251001', maxTokens: 100 },
    };

    await membrane.stream(request);

    const lastRequest = adapter.getLastRequest()!;
    expect(lastRequest.tools).toBeUndefined();
    const content = lastRequest.messages
      .map((m: any) => (typeof m.content === 'string' ? m.content : ''))
      .join('');
    expect(content).toContain('zz_lookup1');
  });

  it('falls back to XML for a formatter that cannot carry native tools', () => {
    expect(new CompletionsFormatter().supportsNativeTools).toBe(false);
    expect(new AnthropicXmlFormatter().supportsNativeTools).toBe(true);
    expect(new NativeFormatter().supportsNativeTools).toBe(true);
  });
});

describe('prefill-incompatibility fails fast', () => {
  it('refuses explicit XML tool mode against a prefill-refusing model', async () => {
    const adapter = new MockAdapter();
    const membrane = new Membrane(adapter);

    const request: NormalizedRequest = {
      messages: [textMessage('User', 'Hello')],
      tools: [zzTool1],
      toolMode: 'xml',
      config: { model: 'claude-sonnet-4-6', maxTokens: 100 },
    };

    await expect(membrane.complete(request)).rejects.toThrow(MembraneError);
    await expect(membrane.complete(request)).rejects.toThrow(/does not support assistant prefill/i);
    expect(adapter.getLastRequest()).toBeUndefined();
  });

  it('refuses a prefill build against a prefill-refusing model even with no tools', async () => {
    const adapter = new MockAdapter();
    const membrane = new Membrane(adapter);

    const request: NormalizedRequest = {
      messages: [textMessage('User', 'Hello')],
      config: { model: 'claude-opus-4-8', maxTokens: 100 },
    };

    await expect(membrane.complete(request)).rejects.toMatchObject({
      name: 'MembraneError',
      type: 'unsupported',
    });
    expect(adapter.getLastRequest()).toBeUndefined();
  });

  it('names the model, the formatter and the remedy', async () => {
    const adapter = new MockAdapter();
    const membrane = new Membrane(adapter);

    const request: NormalizedRequest = {
      messages: [textMessage('User', 'Hello')],
      config: { model: 'claude-sonnet-5', maxTokens: 100 },
    };

    const error = await membrane.complete(request).then(
      () => undefined,
      (e: unknown) => e as MembraneError,
    );
    expect(error).toBeInstanceOf(MembraneError);
    expect(error!.message).toContain('claude-sonnet-5');
    expect(error!.message).toContain('anthropic-xml');
    expect(error!.message).toContain('NativeFormatter');
    expect(error!.retryable).toBe(false);
  });

  it('lets a prefill-capable model through the same path', async () => {
    const adapter = new MockAdapter();
    const membrane = new Membrane(adapter);

    const request: NormalizedRequest = {
      messages: [textMessage('User', 'Hello')],
      config: { model: 'claude-haiku-4-5-20251001', maxTokens: 100 },
    };

    await expect(membrane.complete(request)).resolves.toBeDefined();
    expect(adapter.getLastRequest()).toBeDefined();
  });
});
