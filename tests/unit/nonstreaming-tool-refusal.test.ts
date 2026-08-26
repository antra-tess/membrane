/**
 * stream({ streaming: false }) and onToolCalls (A3 MAJOR-6).
 *
 * The non-streaming fallback routes to complete(), which has no tool loop:
 * onToolCalls was accepted, dropped and never called. The turn ended after
 * one provider call with raw <function_calls> XML in the returned text — a
 * working agent silently converted into one that narrates tool calls it
 * never makes. There is no tool loop on that path, so the option is refused
 * where it is passed rather than honoured halfway.
 */

import { describe, it, expect } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { MembraneError } from '../../src/types/errors.js';
import type { NormalizedRequest } from '../../src/types/index.js';
import type {
  ProviderAdapter,
  ProviderRequest,
  ProviderRequestOptions,
  ProviderResponse,
} from '../../src/types/provider.js';
import type { StreamCallbacks } from '../../src/types/streaming.js';

const TOOL_TEXT =
  'zz preamble\n<function_calls>\n<invoke name="zz_shot">\n<parameter name="fld1">ite1</parameter>\n</invoke>\n</function_calls>';

class ToolCallingAdapter implements ProviderAdapter {
  readonly name = 'zz-tool-calling';
  completeCalls = 0;

  supportsModel(): boolean {
    return true;
  }

  async complete(request: ProviderRequest, _options?: ProviderRequestOptions): Promise<ProviderResponse> {
    this.completeCalls++;
    return {
      content: [{ type: 'text', text: TOOL_TEXT }],
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 5 },
      model: request.model,
      rawRequest: request,
      raw: {},
    } as unknown as ProviderResponse;
  }

  async stream(
    request: ProviderRequest,
    callbacks: StreamCallbacks,
    options?: ProviderRequestOptions,
  ): Promise<ProviderResponse> {
    callbacks.onChunk(TOOL_TEXT);
    return this.complete(request, options);
  }
}

const REQUEST: NormalizedRequest = {
  messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz please shoot' }] }],
  config: { model: 'zz-model', maxTokens: 100 },
  streaming: false,
};

describe('stream({ streaming: false }) with onToolCalls', () => {
  it('refuses loudly instead of silently skipping every tool', async () => {
    const adapter = new ToolCallingAdapter();
    let handlerRuns = 0;

    await expect(
      new Membrane(adapter).stream(REQUEST, {
        onToolCalls: async () => {
          handlerRuns++;
          return [];
        },
      }),
    ).rejects.toThrow(MembraneError);

    expect(handlerRuns).toBe(0);
    // Refused before the provider call, not after billing one.
    expect(adapter.completeCalls).toBe(0);
  });

  it('names the unsupported combination in a typed error', async () => {
    const adapter = new ToolCallingAdapter();
    const error = await new Membrane(adapter)
      .stream(REQUEST, { onToolCalls: async () => [] })
      .then(
        () => undefined,
        (e: unknown) => e as MembraneError,
      );

    expect(error).toBeInstanceOf(MembraneError);
    expect(error!.type).toBe('unsupported');
    expect(error!.message).toContain('onToolCalls');
    expect(error!.message).toContain('streaming: false');
  });

  it('still serves the fallback when no tool handler is supplied', async () => {
    const adapter = new ToolCallingAdapter();
    const chunks: string[] = [];
    const response = await new Membrane(adapter).stream(REQUEST, {
      onChunk: (chunk) => chunks.push(chunk),
    });

    expect('content' in response).toBe(true);
    expect(chunks.join('')).toContain('zz preamble');
    expect(adapter.completeCalls).toBe(1);
  });
});
