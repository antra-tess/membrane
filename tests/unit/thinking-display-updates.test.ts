/**
 * `thinking.display: 'updates'` (Anthropic beta
 * `thinking-display-updates-2026-08-18`).
 *
 * On Fable 5 / 5.1 and Mythos 5.1, and on Opus 5.5 and Sonnet 5.5 for notes
 * longer than a sentence or two, the notes the model writes between tool
 * calls come back as signed `thinking` blocks placed before the `tool_use`
 * they introduce, empty under the default 'omitted'. 'updates' returns their
 * text while reasoning stays hidden. Without the beta the API rejects it.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { AnthropicAdapter, THINKING_DISPLAY_UPDATES_BETA } from '../../src/providers/anthropic.js';
import { BedrockAdapter } from '../../src/providers/bedrock.js';
import type {
  NormalizedRequest,
  ProviderAdapter,
  ProviderRequest,
  ProviderResponse,
  StreamCallbacks,
} from '../../src/types/index.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const BETA = 'thinking-display-updates-2026-08-18';

class RecordingAdapter implements ProviderAdapter {
  readonly name = 'recording';
  requests: ProviderRequest[] = [];
  supportsModel(): boolean {
    return true;
  }
  async complete(): Promise<ProviderResponse> {
    throw new Error('not used');
  }
  async stream(request: ProviderRequest, callbacks: StreamCallbacks): Promise<ProviderResponse> {
    this.requests.push(request);
    callbacks.onChunk('done');
    return {
      content: [{ type: 'text', text: 'done' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
      model: request.model,
      raw: {},
    };
  }
}

function request(config: Partial<NormalizedRequest['config']>): NormalizedRequest {
  return {
    messages: [{ participant: 'User', content: [{ type: 'text', text: 'hi' }] }],
    config: { model: 'claude-opus-5-5', maxTokens: 4000, ...config },
    toolMode: 'native',
  };
}

async function sent(config: Partial<NormalizedRequest['config']>): Promise<ProviderRequest> {
  const adapter = new RecordingAdapter();
  await new Membrane(adapter).stream(request(config));
  return adapter.requests[0]!;
}

describe('membrane builds the config', () => {
  it('sends display updates in an adaptive or enabled config', async () => {
    expect((await sent({ thinking: { enabled: true, type: 'adaptive', display: 'updates' } })).thinking)
      .toEqual({ type: 'adaptive', display: 'updates' });
    expect((await sent({ thinking: { enabled: true, budgetTokens: 2000, display: 'updates' } })).thinking)
      .toEqual({ type: 'enabled', budget_tokens: 2000, display: 'updates' });
  });

  it('sends a model whose thinking is always on an adaptive config for updates, where another display alone sends none', async () => {
    // These models think whatever `enabled` says.
    expect((await sent({ model: 'claude-fable-5-1', thinking: { enabled: false, display: 'updates' } })).thinking)
      .toEqual({ type: 'adaptive', display: 'updates' });
    expect((await sent({ model: 'claude-mythos-5-1', thinking: { enabled: true, display: 'updates' } })).thinking)
      .toEqual({ type: 'adaptive', display: 'updates' });
    expect((await sent({ model: 'claude-fable-5-1', thinking: { enabled: true, display: 'summarized' } })).thinking)
      .toBeUndefined();
    expect((await sent({ model: 'claude-fable-5-1', thinking: { enabled: true, display: 'omitted' } })).thinking)
      .toBeUndefined();
    expect((await sent({
      model: 'claude-fable-5-1',
      thinking: { enabled: true, display: 'updates', blockBinding: { prefixMismatchBehavior: 'drop_block' } },
    })).thinking).toEqual({ type: 'adaptive', display: 'updates', block_binding: { prefix_mismatch_behavior: 'drop_block' } });
  });

  it('sends no sampling params to an always-thinking model with updates on', async () => {
    const req = await sent({ model: 'claude-fable-5-1', temperature: 0.3, thinking: { enabled: true, display: 'updates' } });
    expect(req.temperature).toBeUndefined();
  });
});

describe('the adapters add the beta', () => {
  it('exports the beta value', () => {
    expect(THINKING_DISPLAY_UPDATES_BETA).toBe(BETA);
  });

  it('Anthropic: adds it to the header when the body carries display updates, beside a default beta', async () => {
    const seen: Array<Record<string, string> | undefined> = [];
    const adapter = new AnthropicAdapter({ apiKey: 'sk-test', cacheKeepalive: { enabled: false }, defaultHeaders: { 'anthropic-beta': 'oauth-2025-04-20' } });
    (adapter as any).client = { messages: { create: async (_body: unknown, opts: { headers?: Record<string, string> }) => {
      seen.push(opts.headers);
      return { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', model: 'm', usage: { input_tokens: 1, output_tokens: 1 } };
    } } };
    const base = { messages: [{ role: 'user', content: 'hi' }], maxTokens: 4000, model: 'claude-opus-5-5' } as const;
    await adapter.complete({ ...base, thinking: { type: 'adaptive', display: 'updates' } } as any);
    await adapter.complete({ ...base, extra: { thinking: { type: 'adaptive', display: 'updates' } } } as any);
    await adapter.complete({ ...base, thinking: { type: 'adaptive', display: 'updates', block_binding: { prefix_mismatch_behavior: 'drop_block' } } } as any);
    await adapter.complete({ ...base, thinking: { type: 'adaptive', display: 'summarized' } } as any);
    expect(seen.map((h) => h?.['anthropic-beta'])).toEqual([
      `oauth-2025-04-20,${BETA}`,
      `oauth-2025-04-20,${BETA}`,
      `oauth-2025-04-20,thinking-binding-controls-2026-08-01,${BETA}`,
      undefined,
    ]);
  });

  it('Anthropic, streamed: the stream\'s headers carry it too', async () => {
    const seen: Array<Record<string, string> | undefined> = [];
    const adapter = new AnthropicAdapter({ apiKey: 'sk-test', cacheKeepalive: { enabled: false } });
    (adapter as any).client = { withOptions() { return this; }, messages: { stream: async (_body: unknown, opts: { headers?: Record<string, string> }) => {
      seen.push(opts.headers);
      return fakeStream(endTurn);
    } } };
    const base = { messages: [{ role: 'user', content: 'hi' }], maxTokens: 4000, model: 'claude-opus-5-5' } as const;
    await adapter.stream({ ...base, thinking: { type: 'adaptive', display: 'updates' } } as any, { onChunk: () => {} });
    await adapter.stream({ ...base, thinking: { type: 'adaptive' } } as any, { onChunk: () => {} });
    expect(seen[0]?.['anthropic-beta']).toBe(BETA);
    expect(seen[1]?.['anthropic-beta']).toBeUndefined();
  });

  it('Bedrock: adds it to anthropic_beta, merged with the caller\'s', () => {
    const adapter = new BedrockAdapter({ accessKeyId: 'k', secretAccessKey: 's', region: 'us-east-1' }) as any;
    const base = { model: 'claude-opus-5-5', maxTokens: 4000, messages: [{ role: 'user', content: 'hi' }] };
    const built = adapter.buildRequest({
      ...base,
      thinking: { type: 'adaptive', display: 'updates' },
      extra: { anthropic_beta: ['context-1m-2025-08-07'] },
    });
    expect(built.anthropic_beta).toEqual(['context-1m-2025-08-07', BETA]);
    const viaExtra = adapter.buildRequest({ ...base, extra: { thinking: { type: 'adaptive', display: 'updates' } } });
    expect(viaExtra.anthropic_beta).toEqual([BETA]);
    const summarized = adapter.buildRequest({ ...base, thinking: { type: 'adaptive', display: 'summarized' } });
    expect(summarized.anthropic_beta).toBeUndefined();
  });
});

describe('a progress update comes back as a thinking block', () => {
  it('Anthropic, streamed: keeps an empty reasoning block and the note after it, each signed, before the tool call', async () => {
    const adapter = new AnthropicAdapter({ apiKey: 'sk-test', cacheKeepalive: { enabled: false } });
    (adapter as any).client = { withOptions() { return this; }, messages: { stream: async () => fakeStream([
      { type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 9 } } },
      // Under 'updates', hidden reasoning comes as a thinking block with no text and a signature.
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG-R' } },
      { type: 'content_block_stop', index: 0 },
      // A progress note streams its text, then its own signature.
      { type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'Found the config; checking the loader next.' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'signature_delta', signature: 'SIG-U' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read', input: {} } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":"loader.ts"}' } },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 40 } },
    ]) } };
    const response = await adapter.stream({
      model: 'claude-opus-5-5', maxTokens: 4000,
      messages: [{ role: 'user', content: 'go' }],
      thinking: { type: 'adaptive', display: 'updates' },
    } as any, { onChunk: () => {} });
    const content = response.content as Array<{ type: string; thinking?: string; signature?: string; name?: string }>;
    expect(content.map((b) => b.type)).toEqual(['thinking', 'thinking', 'tool_use']);
    expect(content[0]).toMatchObject({ thinking: '', signature: 'SIG-R' });
    expect(content[1]).toMatchObject({ thinking: 'Found the config; checking the loader next.', signature: 'SIG-U' });
    expect(content[2]).toMatchObject({ name: 'read' });
  });
});

const endTurn = [
  { type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 9 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
];

function fakeStream(events: unknown[]) {
  return {
    controller: { abort() {} },
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
  };
}
