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

const NO_FIELD = Symbol('no refusalCategory');

class RefusingAdapter implements ProviderAdapter {
  readonly name = 'refusing';
  calls = 0;

  constructor(
    private refusals: number,
    private refusalText = 'PARTIAL-REFUSED',
    private successText = 'GOOD',
    private fieldCategory: unknown = 'cyber',
  ) {}

  private response(text: string, stopReason: string): ProviderResponse {
    const refused = stopReason === 'refusal';
    const reports = this.fieldCategory !== NO_FIELD;
    const stopDetails = { type: 'refusal', category: 'cyber' };
    return {
      content: [{ type: 'text', text }],
      stopReason,
      ...(refused && reports ? { refusalCategory: this.fieldCategory } : {}),
      usage: { inputTokens: 1, outputTokens: 1 },
      raw: refused && !reports
        ? { stop_reason: stopReason, stop_details: stopDetails, response: { stop_details: stopDetails } }
        : { stop_reason: stopReason },
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
    callbacks.onChunk?.(text);
    return this.response(text, refusing ? 'refusal' : 'end_turn');
  }
}

function createRequest(): NormalizedRequest {
  return {
    messages: [{ participant: 'User', content: [{ type: 'text', text: 'Hello' }] }],
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
    expect(adapter.calls).toBe(3);
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

    const complete = events.find((e) => e.type === 'complete');
    expect(complete).toBeDefined();
    const text = JSON.stringify((complete as { response: unknown }).response);
    expect(text).toContain('GOOD');
    expect(text).not.toContain('PARTIAL-REFUSED');
  });

  it('announces no category when the adapter reports none, whatever its raw response holds', async () => {
    const adapter = new RefusingAdapter(1, 'PARTIAL-REFUSED', 'GOOD', NO_FIELD);
    const events = await collect(
      new Membrane(adapter).streamYielding(createRequest(), { refusalRetries: 1 }),
    );

    const retrying = events.filter((e) => e.type === 'retrying');
    expect(retrying).toEqual([{ type: 'retrying', attempt: 1, maxAttempts: 1, reason: 'refusal' }]);
    // toEqual reads a key holding undefined as absent.
    expect(Object.keys(retrying[0]!)).not.toContain('category');
  });

  it.each([
    ['a number', 7],
    ['an empty string', ''],
    ['an array', ['cyber']],
  ])('announces no category when an untyped adapter reports %s as one', async (_name, value) => {
    const adapter = new RefusingAdapter(1, 'PARTIAL-REFUSED', 'GOOD', value);
    const events = await collect(
      new Membrane(adapter).streamYielding(createRequest(), { refusalRetries: 1 }),
    );

    const retrying = events.filter((e) => e.type === 'retrying');
    expect(retrying).toEqual([{ type: 'retrying', attempt: 1, maxAttempts: 1, reason: 'refusal' }]);
    expect(Object.keys(retrying[0]!)).not.toContain('category');
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
