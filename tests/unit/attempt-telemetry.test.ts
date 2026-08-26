/**
 * Honest provider-call telemetry on stitched turns (A3 MINOR-1).
 *
 * A turn that made several provider calls — tool rounds, automatic
 * resumptions, refusal re-issues — reported `details.timing.attempts: 1`,
 * because every streaming path passed the literal 1. Nothing else in the
 * response carries a round count either, so a stitched multi-call turn was
 * indistinguishable from a single-shot one in durable logs.
 */

import { describe, it, expect } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import type { NormalizedRequest, NormalizedResponse, StreamEvent } from '../../src/types/index.js';
import type {
  ProviderAdapter,
  ProviderRequest,
  ProviderRequestOptions,
  ProviderResponse,
} from '../../src/types/provider.js';
import type { StreamCallbacks } from '../../src/types/streaming.js';

const CALL_XML =
  '<function_calls>\n<invoke name="zz_probe">\n<parameter name="fld1">ite1</parameter>\n</invoke>';

/** Two XML tool rounds, then a natural finish. */
class TwoRoundXmlAdapter implements ProviderAdapter {
  readonly name = 'zz-two-round';
  streamCalls = 0;

  supportsModel(): boolean {
    return true;
  }

  async complete(): Promise<ProviderResponse> {
    throw new Error('zz-two-round adapter: complete() is not used by these tests');
  }

  async stream(
    request: ProviderRequest,
    callbacks: StreamCallbacks,
    _options?: ProviderRequestOptions,
  ): Promise<ProviderResponse> {
    const round = this.streamCalls++;
    const finished = round >= 2;
    const text = finished ? 'zz final answer' : `zz round ${round}\n${CALL_XML}`;
    callbacks.onChunk(text);
    return {
      content: [{ type: 'text', text }],
      stopReason: finished ? 'end_turn' : 'stop_sequence',
      stopSequence: finished ? undefined : '</function_calls>',
      usage: { inputTokens: 100, outputTokens: 5 },
      model: request.model,
      rawRequest: request,
      raw: {},
    };
  }
}

/** Native tool mode: one tool round, then a text answer. */
class NativeToolAdapter implements ProviderAdapter {
  readonly name = 'zz-native-two-round';
  streamCalls = 0;

  supportsModel(): boolean {
    return true;
  }

  async complete(): Promise<ProviderResponse> {
    throw new Error('zz-native-two-round adapter: complete() is not used by these tests');
  }

  async stream(
    request: ProviderRequest,
    callbacks: StreamCallbacks,
    _options?: ProviderRequestOptions,
  ): Promise<ProviderResponse> {
    const round = this.streamCalls++;
    if (round === 0) {
      return {
        content: [{ type: 'tool_use', id: 'zz_call_1', name: 'zz_probe', input: { fld1: 'ite1' } }],
        stopReason: 'tool_use',
        usage: { inputTokens: 100, outputTokens: 5 },
        model: request.model,
        rawRequest: request,
        raw: {},
      } as unknown as ProviderResponse;
    }
    callbacks.onChunk('zz final answer');
    return {
      content: [{ type: 'text', text: 'zz final answer' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 100, outputTokens: 5 },
      model: request.model,
      rawRequest: request,
      raw: {},
    } as unknown as ProviderResponse;
  }
}

const REQUEST: NormalizedRequest = {
  messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz hello' }] }],
  config: { model: 'zz-model', maxTokens: 100 },
};

const NATIVE_REQUEST: NormalizedRequest = {
  ...REQUEST,
  toolMode: 'native',
  tools: [
    {
      name: 'zz_probe',
      description: 'zz probe tool',
      inputSchema: { type: 'object', properties: { fld1: { type: 'string' } } },
    },
  ],
};

const toolResults = (calls: Array<{ id: string }>) =>
  calls.map((c) => ({ toolUseId: c.id, toolName: 'zz_probe', content: 'zz ok' }));

async function completedResponse(stream: AsyncIterable<StreamEvent>): Promise<NormalizedResponse> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  const complete = events.find((e) => e.type === 'complete');
  expect(complete).toBeDefined();
  return (complete as { response: NormalizedResponse }).response;
}

describe('details.timing counts real provider calls', () => {
  it('stream(), XML tool rounds', async () => {
    const adapter = new TwoRoundXmlAdapter();
    const response = await new Membrane(adapter).stream(REQUEST, {
      onToolCalls: async (calls) => toolResults(calls),
    });

    expect(adapter.streamCalls).toBe(3);
    expect('details' in response && response.details.timing.attempts).toBe(3);
    expect('details' in response && response.details.timing.rounds).toBe(3);
  });

  it('stream(), native tool rounds', async () => {
    const adapter = new NativeToolAdapter();
    const response = await new Membrane(adapter).stream(NATIVE_REQUEST, {
      onToolCalls: async (calls) => toolResults(calls),
    });

    expect(adapter.streamCalls).toBe(2);
    expect('details' in response && response.details.timing.attempts).toBe(2);
    expect('details' in response && response.details.timing.rounds).toBe(2);
  });

  it('streamYielding(), XML tool rounds', async () => {
    const adapter = new TwoRoundXmlAdapter();
    const membrane = new Membrane(adapter);
    const stream = membrane.streamYielding(REQUEST);

    const events: StreamEvent[] = [];
    for await (const event of stream) {
      events.push(event);
      if (event.type === 'tool-calls') {
        stream.provideToolResults(toolResults(event.calls));
      }
    }

    const complete = events.find((e) => e.type === 'complete');
    const response = (complete as { response: NormalizedResponse }).response;
    expect(adapter.streamCalls).toBe(3);
    expect(response.details.timing.attempts).toBe(3);
    expect(response.details.timing.rounds).toBe(3);
  });

  it('single-call turns still report 1', async () => {
    class SingleShotAdapter implements ProviderAdapter {
      readonly name = 'zz-single-shot';
      streamCalls = 0;
      supportsModel(): boolean {
        return true;
      }
      async complete(): Promise<ProviderResponse> {
        throw new Error('zz-single-shot adapter: complete() is not used here');
      }
      async stream(
        request: ProviderRequest,
        callbacks: StreamCallbacks,
        _options?: ProviderRequestOptions,
      ): Promise<ProviderResponse> {
        this.streamCalls++;
        callbacks.onChunk('zz one and done');
        return {
          content: [{ type: 'text', text: 'zz one and done' }],
          stopReason: 'end_turn',
          usage: { inputTokens: 100, outputTokens: 5 },
          model: request.model,
          rawRequest: request,
          raw: {},
        };
      }
    }

    const adapter = new SingleShotAdapter();
    const response = await new Membrane(adapter).stream(REQUEST, {});
    expect(adapter.streamCalls).toBe(1);
    expect('details' in response && response.details.timing.attempts).toBe(1);
    expect('details' in response && response.details.timing.rounds).toBe(1);
  });

  it('counts a refusal re-issue as a provider call on the native yielding path', async () => {
    class RefusingOnceAdapter implements ProviderAdapter {
      readonly name = 'zz-refusing-once';
      calls = 0;
      supportsModel(): boolean {
        return true;
      }
      async complete(): Promise<ProviderResponse> {
        throw new Error('zz-refusing-once adapter: complete() is not used here');
      }
      async stream(
        request: ProviderRequest,
        callbacks: StreamCallbacks,
        _options?: ProviderRequestOptions,
      ): Promise<ProviderResponse> {
        const refusing = this.calls++ === 0;
        callbacks.onChunk?.(refusing ? 'zz refused' : 'zz answer');
        return {
          content: [{ type: 'text', text: refusing ? 'zz refused' : 'zz answer' }],
          stopReason: refusing ? 'refusal' : 'end_turn',
          usage: { inputTokens: 100, outputTokens: 5 },
          model: request.model,
          rawRequest: request,
          raw: {},
        } as unknown as ProviderResponse;
      }
    }

    const adapter = new RefusingOnceAdapter();
    const response = await completedResponse(
      new Membrane(adapter).streamYielding(NATIVE_REQUEST, { refusalRetries: 1 }),
    );

    expect(adapter.calls).toBe(2);
    // Two provider calls, one continuation round.
    expect(response.details.timing.attempts).toBe(2);
    expect(response.details.timing.rounds).toBe(1);
  });
});
