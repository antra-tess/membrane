/** `for await (… of stream) { break }` calls iterator.return() when the iterator implements it. */

import { describe, it, expect } from 'vitest';
import { getEventListeners } from 'node:events';
import { Membrane } from '../../src/membrane.js';
import type { NormalizedRequest, StreamEvent } from '../../src/types/index.js';
import type {
  ProviderAdapter,
  ProviderRequest,
  ProviderRequestOptions,
  ProviderResponse,
} from '../../src/types/provider.js';
import type { StreamCallbacks } from '../../src/types/streaming.js';

class ResumingAdapter implements ProviderAdapter {
  readonly name = 'zz-resuming';
  streamCalls = 0;

  supportsModel(): boolean {
    return true;
  }

  async complete(): Promise<ProviderResponse> {
    throw new Error('zz-resuming adapter: complete() is not used by these tests');
  }

  async stream(
    request: ProviderRequest,
    callbacks: StreamCallbacks,
    _options?: ProviderRequestOptions,
  ): Promise<ProviderResponse> {
    const round = this.streamCalls++;
    const text =
      round === 0
        ? '<function_calls>\n<invoke name="zz_never">'
        : `zz round ${round} keeps making real progress, comfortably past the stall threshold`;
    callbacks.onChunk(text);
    return {
      content: [{ type: 'text', text }],
      stopReason: 'stop_sequence',
      stopSequence: '\nUser:',
      usage: { inputTokens: 100, outputTokens: 5 },
      model: request.model,
      rawRequest: request,
      raw: {},
    };
  }
}

const REQUEST: NormalizedRequest = {
  messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz hello' }] }],
  config: { model: 'zz-model', maxTokens: 100 },
};

const settle = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

describe('breaking out of the loop stops the producer', () => {
  it('stops buying tokens once the consumer departs', async () => {
    const adapter = new ResumingAdapter();
    const stream = new Membrane(adapter).streamYielding(REQUEST);

    for await (const event of stream) {
      if (event.type === 'tokens') break;
    }

    const callsAtDeparture = adapter.streamCalls;
    await settle();

    expect(adapter.streamCalls).toBeLessThanOrEqual(callsAtDeparture + 1);
    expect(adapter.streamCalls).toBeLessThan(6);
  });

  it('does not replay a pile of queued events to a returning consumer', async () => {
    const adapter = new ResumingAdapter();
    const stream = new Membrane(adapter).streamYielding(REQUEST);

    for await (const event of stream) {
      if (event.type === 'tokens') break;
    }
    await settle();

    const afterDeparture: StreamEvent[] = [];
    for await (const event of stream) afterDeparture.push(event);
    expect(afterDeparture).toEqual([]);
  });

  it('throw() stops the producer AND rejects with the error it was given', async () => {
    const adapter = new ResumingAdapter();
    const stream = new Membrane(adapter).streamYielding(REQUEST);
    const iterator = stream[Symbol.asyncIterator]();

    await iterator.next();
    expect(typeof iterator.throw).toBe('function');

    // An async generator with no handler of its own rejects with the injected error.
    const injected = new Error('zz consumer gave up');
    const outcome = await iterator.throw!(injected).then(
      (result) => ({ resolved: result }),
      (error: unknown) => ({ rejected: error }),
    );
    expect(outcome).toEqual({ rejected: injected });

    const callsAtDeparture = adapter.streamCalls;
    await settle();
    expect(adapter.streamCalls).toBeLessThanOrEqual(callsAtDeparture + 1);
  });

  it('an error thrown into a yield* delegation reaches the delegating generator', async () => {
    const adapter = new ResumingAdapter();
    const stream = new Membrane(adapter).streamYielding(REQUEST);

    async function* delegating(): AsyncGenerator<StreamEvent> {
      yield* stream;
    }

    const outer = delegating();
    await outer.next();

    const injected = new Error('zz delegating consumer gave up');
    const outcome = await outer.throw(injected).then(
      (result) => ({ resolved: result }),
      (error: unknown) => ({ rejected: error }),
    );
    expect(outcome).toEqual({ rejected: injected });
  });
});

describe('external abort signal listeners', () => {
  it('removes its listener from a shared signal at terminal', async () => {
    const controller = new AbortController();
    const membrane = new Membrane(new ResumingAdapter());

    for (let i = 0; i < 5; i++) {
      const stream = membrane.streamYielding(REQUEST, { signal: controller.signal });
      for await (const event of stream) {
        if (event.type === 'tokens') break;
      }
      await settle(20);
    }

    expect(getEventListeners(controller.signal, 'abort').length).toBe(0);
  });
});
