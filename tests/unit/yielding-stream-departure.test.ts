/**
 * Consumer departure on the yielding stream (A3 MAJOR-4, MINOR-6).
 *
 * `for await (… of stream) { break }` calls iterator.return() when the
 * iterator implements it. Without it the loop simply walks away while the
 * background inference promise keeps streaming, keeps auto-resuming and
 * keeps re-sending full context on membrane's own initiative — events piling
 * into an unbounded queue nobody drains, tokens billed for a consumer that
 * left. The stream also kept one abort listener per instance alive on a
 * long-lived caller signal.
 */

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

/**
 * Streams a long, always-progressing round that stops on a stop sequence
 * inside a block the model opened — the automatic-resumption shape. Left to
 * itself it re-sends full context until the issue-#39 round cap trips.
 */
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

const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));

describe('breaking out of the loop stops the producer', () => {
  it('stops buying tokens once the consumer departs', async () => {
    const adapter = new ResumingAdapter();
    const stream = new Membrane(adapter).streamYielding(REQUEST);

    for await (const event of stream) {
      if (event.type === 'tokens') break;
    }

    const callsAtDeparture = adapter.streamCalls;
    await settle();

    // At most the round already in flight may finish. Unfixed, the loop ran
    // to the resumption cap — ~25 full-context calls after the consumer left.
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

    // An async generator with no handler of its own rejects with the injected
    // error. Reporting `done: true` instead made the error vanish: a `yield*`
    // delegating to this stream resumed after the delegation as if nothing
    // had been thrown into it.
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

    // Unfixed: one closure per stream, accumulating on a long-lived signal.
    expect(getEventListeners(controller.signal, 'abort').length).toBe(0);
  });
});
