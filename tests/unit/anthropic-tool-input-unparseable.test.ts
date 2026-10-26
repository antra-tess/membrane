/** Anthropic's tool_use content_block_start event carries `input: {}`. */
import { describe, it, expect } from 'vitest';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { Membrane } from '../../src/membrane.js';
import type {
  ProviderAdapter,
  ProviderRequest,
  ProviderRequestOptions,
  ProviderResponse,
  StreamCallbacks,
} from '../../src/types/provider.js';
import type { NormalizedRequest } from '../../src/types/index.js';

function fakeAnthropicStream(events: unknown[]) {
  return {
    controller: { abort() { /* noop */ } },
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i < events.length) return { value: events[i++], done: false };
          return { value: undefined, done: true };
        },
      };
    },
  };
}

const truncatedArguments = '{"path":"/zz/fld1.ts","new_string":"const ite1 = ';

function adapterStreamingTruncatedToolCall(): AnthropicAdapter {
  const adapter = new AnthropicAdapter({ apiKey: 'zz-key' });
  (adapter as any).client = {
    withOptions() { return this; },
    messages: {
      stream: async () => fakeAnthropicStream([
        { type: 'message_start', message: { model: 'claude-zz-1', usage: { input_tokens: 10 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_zz1', name: 'zz_edit', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: truncatedArguments } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 50 } },
      ]),
    },
  };
  return adapter;
}

/**
 * Anthropic's event sequence for a forced tool call that max_tokens cuts off:
 *   message_start -> content_block_start(tool_use) -> content_block_delta x4
 *   -> message_delta(max_tokens) -> message_stop
 * No content_block_stop: the block is left open.
 */
function adapterStreamingUnterminatedToolCall(): AnthropicAdapter {
  const adapter = new AnthropicAdapter({ apiKey: 'zz-key' });
  (adapter as any).client = {
    withOptions() { return this; },
    messages: {
      stream: async () => fakeAnthropicStream([
        { type: 'message_start', message: { model: 'claude-zz-1', usage: { input_tokens: 10 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_zz3', name: 'zz_edit', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: truncatedArguments } },
        { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 40 } },
      ]),
    },
  };
  return adapter;
}

describe('AnthropicAdapter streaming: unparseable tool_use input', () => {
  it('keeps the raw accumulation and marks the block instead of persisting input:{}', async () => {
    const res: any = await adapterStreamingTruncatedToolCall().stream(
      { model: 'claude-zz-1', maxTokens: 64, messages: [{ role: 'user', content: [{ type: 'text', text: 'zz prompt' }] }] } as any,
      { onChunk: () => {} } as any,
    );

    const toolUse = res.content.find((b: any) => b.type === 'tool_use');
    expect(toolUse).toBeDefined();
    expect(res.stopReason).toBe('max_tokens');
    expect(toolUse.unparseableInput).toBe(truncatedArguments);
  });

  it('finalizes a block the stream left open (truncation sends no content_block_stop)', async () => {
    const res: any = await adapterStreamingUnterminatedToolCall().stream(
      { model: 'claude-zz-1', maxTokens: 64, messages: [{ role: 'user', content: [{ type: 'text', text: 'zz prompt' }] }] } as any,
      { onChunk: () => {} } as any,
    );

    const toolUse = res.content.find((b: any) => b.type === 'tool_use');
    expect(res.stopReason).toBe('max_tokens');
    expect(toolUse.unparseableInput).toBe(truncatedArguments);
  });

  it('leaves the marker off a call whose arguments parsed', async () => {
    const adapter = new AnthropicAdapter({ apiKey: 'zz-key' });
    (adapter as any).client = {
      withOptions() { return this; },
      messages: {
        stream: async () => fakeAnthropicStream([
          { type: 'message_start', message: { model: 'claude-zz-1', usage: { input_tokens: 10 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_zz2', name: 'zz_edit', input: {} } },
          { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"/zz/fld1.ts"}' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 12 } },
        ]),
      },
    };
    const res: any = await adapter.stream(
      { model: 'claude-zz-1', maxTokens: 64, messages: [{ role: 'user', content: [{ type: 'text', text: 'zz prompt' }] }] } as any,
      { onChunk: () => {} } as any,
    );
    const toolUse = res.content.find((b: any) => b.type === 'tool_use');
    expect(toolUse.input).toEqual({ path: '/zz/fld1.ts' });
    expect(toolUse.unparseableInput).toBeUndefined();
  });
});

/** Adapter returning a provider block that already carries the marker. */
class TruncatedToolCallAdapter implements ProviderAdapter {
  readonly name = 'zz-truncated';

  private response(): ProviderResponse {
    return {
      content: [
        { type: 'tool_use', id: 'toolu_zz1', name: 'zz_edit', input: {}, unparseableInput: truncatedArguments },
      ],
      stopReason: 'max_tokens',
      usage: { inputTokens: 10, outputTokens: 50 },
      raw: {},
    } as unknown as ProviderResponse;
  }

  async complete(_request: ProviderRequest, _options?: ProviderRequestOptions): Promise<ProviderResponse> {
    return this.response();
  }

  async stream(_request: ProviderRequest, callbacks: StreamCallbacks, _options?: ProviderRequestOptions): Promise<ProviderResponse> {
    callbacks.onChunk?.('');
    return this.response();
  }
}

function createRequest(): NormalizedRequest {
  return {
    messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz prompt' }] }],
    toolMode: 'native',
    tools: [{ name: 'zz_edit', description: 'zz', inputSchema: { type: 'object', properties: {} } }],
    config: { model: 'zz-model-1', maxTokens: 64 },
  } as NormalizedRequest;
}

describe('membrane parseProviderContent', () => {
  it('surfaces the unparseable-input marker to the caller', async () => {
    // The streamed native-tools path here; complete() carries it too
    // (tool-input-object.test.ts).
    const response: any = await new Membrane(new TruncatedToolCallAdapter()).stream(createRequest(), {
      onChunk: () => {},
    });
    const toolUse = response.content.find((b: any) => b.type === 'tool_use');
    expect(toolUse).toBeDefined();
    expect(toolUse.unparseableInput).toBe(truncatedArguments);
  });
});
