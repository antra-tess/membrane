/**
 * Discarded refusal-retry spend is reported (A3 MAJOR-2 / A4 MAJOR 6).
 *
 * A refused attempt is a completed, billed provider call: full input tokens
 * plus the refusal's output. Both refusal-retry implementations kept only the
 * surviving attempt's usage, so response.usage under-reported real spend by
 * one whole call per retry — silently, on the exact path a fleet enables to
 * paper over probabilistic refusals.
 *
 * The response's own usage still describes the attempt that STANDS; the
 * discarded spend is reported beside it in details.usage.discardedAttempts.
 */

import { describe, it, expect } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import type {
  ProviderAdapter,
  ProviderRequest,
  ProviderRequestOptions,
  ProviderResponse,
  StreamCallbacks,
} from '../../src/types/provider.js';
import type { NormalizedRequest, StreamEvent } from '../../src/types/index.js';

const REFUSED_USAGE = { inputTokens: 700, outputTokens: 70 };
const SURVIVING_USAGE = { inputTokens: 700, outputTokens: 30 };

/** Refuses the first `refusals` attempts with a real (billed) usage record. */
class BilledRefusingAdapter implements ProviderAdapter {
  readonly name = 'zz-billed-refusing';
  calls = 0;

  constructor(private refusals: number) {}

  supportsModel(): boolean {
    return true;
  }

  private response(refusing: boolean): ProviderResponse {
    return {
      content: [{ type: 'text', text: refusing ? 'zz refused' : 'zz answer' }],
      stopReason: refusing ? 'refusal' : 'end_turn',
      usage: refusing ? { ...REFUSED_USAGE } : { ...SURVIVING_USAGE },
      raw: { response: { stop_reason: refusing ? 'refusal' : 'end_turn' } },
    } as unknown as ProviderResponse;
  }

  async complete(): Promise<ProviderResponse> {
    this.calls++;
    return this.response(this.calls <= this.refusals);
  }

  async stream(
    _request: ProviderRequest,
    callbacks: StreamCallbacks,
    _options?: ProviderRequestOptions,
  ): Promise<ProviderResponse> {
    this.calls++;
    const refusing = this.calls <= this.refusals;
    callbacks.onChunk?.(refusing ? 'zz refused' : 'zz answer');
    return this.response(refusing);
  }
}

function createRequest(): NormalizedRequest {
  return {
    messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz hello' }] }],
    toolMode: 'native',
    tools: [{ name: 'zz_noop', description: 'zz no-op', inputSchema: { type: 'object', properties: {} } }],
    config: { model: 'zz-model', maxTokens: 100 },
  };
}

describe('complete() refusal retries report discarded spend', () => {
  it('sums the abandoned attempt into details.usage.discardedAttempts', async () => {
    const adapter = new BilledRefusingAdapter(1);
    const response = await new Membrane(adapter).complete(createRequest(), { refusalRetries: 1 });

    expect(adapter.calls).toBe(2);
    // The response describes the attempt that stands.
    expect(response.usage).toMatchObject(SURVIVING_USAGE);
    expect(response.details.usage.discardedAttempts).toMatchObject({
      attempts: 1,
      inputTokens: 700,
      outputTokens: 70,
    });
  });

  it('sums MULTIPLE discarded attempts', async () => {
    const adapter = new BilledRefusingAdapter(2);
    const response = await new Membrane(adapter).complete(createRequest(), { refusalRetries: 2 });

    expect(adapter.calls).toBe(3);
    expect(response.details.usage.discardedAttempts).toMatchObject({
      attempts: 2,
      inputTokens: 1400,
      outputTokens: 140,
    });
  });

  it('leaves discardedAttempts unset when nothing was discarded', async () => {
    const adapter = new BilledRefusingAdapter(0);
    const response = await new Membrane(adapter).complete(createRequest(), { refusalRetries: 2 });
    expect(response.details.usage.discardedAttempts).toBeUndefined();
  });
});

describe('streamYielding() refusal retries report discarded spend', () => {
  async function collect(stream: AsyncIterable<StreamEvent>) {
    const events: StreamEvent[] = [];
    for await (const ev of stream) events.push(ev);
    return events;
  }

  it('carries the discarded attempt into the completed response details', async () => {
    const adapter = new BilledRefusingAdapter(1);
    const events = await collect(
      new Membrane(adapter).streamYielding(createRequest(), { refusalRetries: 1 }),
    );

    const complete = events.find((e) => e.type === 'complete');
    expect(complete).toBeDefined();
    const response = (complete as { response: import('../../src/types/index.js').NormalizedResponse }).response;

    expect(adapter.calls).toBe(2);
    expect(response.usage).toMatchObject(SURVIVING_USAGE);
    expect(response.details.usage.discardedAttempts).toMatchObject({
      attempts: 1,
      inputTokens: 700,
      outputTokens: 70,
    });
  });
});
