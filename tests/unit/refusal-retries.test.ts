/**
 * Unit tests for opt-in refusal retries (refusalRetries).
 *
 * The contract under test:
 *  - default OFF, so existing callers are untouched;
 *  - complete() retries invisibly (nothing was emitted yet);
 *  - streamYielding() announces each retry with a `retrying` event, and the
 *    tokens of the abandoned attempt must NOT survive into the final text.
 *    That discard is the whole reason the event exists — a silent retry
 *    would concatenate two attempts in any consumer that renders tokens.
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

/** Adapter that refuses its first `refusals` attempts, then succeeds. */
class RefusingAdapter implements ProviderAdapter {
  readonly name = 'refusing';
  calls = 0;

  constructor(
    private refusals: number,
    private refusalText = 'PARTIAL-REFUSED',
    private successText = 'GOOD',
  ) {}

  private response(text: string, stopReason: string): ProviderResponse {
    return {
      content: [{ type: 'text', text }],
      stopReason,
      usage: { inputTokens: 1, outputTokens: 1 },
      raw: { response: { stop_reason: stopReason, stop_details: { category: 'cyber' } } },
    } as unknown as ProviderResponse;
  }

  async complete(_request: ProviderRequest, _options?: ProviderRequestOptions): Promise<ProviderResponse> {
    this.calls++;
    return this.calls <= this.refusals
      ? this.response(this.refusalText, 'refusal')
      : this.response(this.successText, 'end_turn');
  }

  async stream(
    _request: ProviderRequest,
    callbacks: StreamCallbacks,
    _options?: ProviderRequestOptions,
  ): Promise<ProviderResponse> {
    this.calls++;
    const refusing = this.calls <= this.refusals;
    const text = refusing ? this.refusalText : this.successText;
    // Emit the text as the provider would, BEFORE the refusal verdict lands —
    // this is what a consumer would have rendered and must discard.
    callbacks.onChunk?.(text);
    return this.response(text, refusing ? 'refusal' : 'end_turn');
  }
}

function createRequest(): NormalizedRequest {
  return {
    messages: [{ participant: 'User', content: [{ type: 'text', text: 'Hello' }] }],
    // Native tool mode: what Connectome runs, and the only mode in which
    // refusalRetries is supported (see the XML-mode guard in streamYielding).
    toolMode: 'native',
    tools: [{ name: 'noop', description: 'no-op', inputSchema: { type: 'object', properties: {} } }],
    config: { model: 'test-model', maxTokens: 100 },
  };
}

describe('refusalRetries — complete()', () => {
  it('is OFF by default: a refusal is returned as-is, one call', async () => {
    const adapter = new RefusingAdapter(1);
    const response = await new Membrane(adapter).complete(createRequest());
    expect(response.stopReason).toBe('refusal');
    expect(adapter.calls).toBe(1);
  });

  it('retries up to the budget and returns the attempt that stands', async () => {
    const adapter = new RefusingAdapter(2);
    const response = await new Membrane(adapter).complete(createRequest(), { refusalRetries: 2 });
    expect(response.stopReason).toBe('end_turn');
    expect(adapter.calls).toBe(3); // original + 2 retries
  });

  it('gives up after the budget and surfaces the refusal rather than hiding it', async () => {
    const adapter = new RefusingAdapter(5);
    const response = await new Membrane(adapter).complete(createRequest(), { refusalRetries: 2 });
    expect(response.stopReason).toBe('refusal');
    expect(adapter.calls).toBe(3);
  });
});

describe('refusalRetries — streamYielding()', () => {
  async function collect(stream: AsyncIterable<StreamEvent>) {
    const events: StreamEvent[] = [];
    for await (const ev of stream) events.push(ev);
    return events;
  }

  it('is OFF by default: no retrying event, refusal stands', async () => {
    const adapter = new RefusingAdapter(1);
    const events = await collect(new Membrane(adapter).streamYielding(createRequest()));
    expect(events.some((e) => e.type === 'retrying')).toBe(false);
    expect(adapter.calls).toBe(1);
  });

  it('announces each retry and DISCARDS the refused attempt\'s tokens', async () => {
    const adapter = new RefusingAdapter(1);
    const events = await collect(
      new Membrane(adapter).streamYielding(createRequest(), { refusalRetries: 1 }),
    );

    const retrying = events.filter((e) => e.type === 'retrying');
    expect(retrying).toHaveLength(1);
    expect(retrying[0]).toMatchObject({ attempt: 1, maxAttempts: 1, reason: 'refusal', category: 'cyber' });

    // Both attempts' tokens were emitted, so a consumer needs the event to
    // know which to drop — but the accumulated assistant text must contain
    // only the surviving attempt.
    const complete = events.find((e) => e.type === 'complete');
    expect(complete).toBeDefined();
    const text = JSON.stringify((complete as { response: unknown }).response);
    expect(text).toContain('GOOD');
    expect(text).not.toContain('PARTIAL-REFUSED');
  });

  it('emits the retrying event BEFORE the tokens it invalidates are superseded', async () => {
    const adapter = new RefusingAdapter(1);
    const events = await collect(
      new Membrane(adapter).streamYielding(createRequest(), { refusalRetries: 1 }),
    );
    const order = events.map((e) => e.type);
    const firstTokens = order.indexOf('tokens');
    const retryAt = order.indexOf('retrying');
    expect(firstTokens).toBeGreaterThanOrEqual(0);
    expect(retryAt).toBeGreaterThan(firstTokens);
  });
});
