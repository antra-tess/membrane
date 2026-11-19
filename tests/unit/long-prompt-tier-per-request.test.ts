/**
 * A long-prompt tier is chosen per request. Two 60,000-token Haiku 5.5
 * requests are two short prompts, whether they are the rounds of one turn or
 * two abandoned attempts — never one 120,000-token prompt.
 */
import { describe, it, expect } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { TurnUsageAccumulator } from '../../src/utils/usage.js';
import { getDefaultPricing } from '../../src/registry/default-pricing.js';
import type { ModelRegistry, ProviderAdapter, ProviderResponse, StreamCallbacks } from '../../src/types/provider.js';
import type { NormalizedRequest, NormalizedResponse, StreamEvent } from '../../src/types/index.js';

const HAIKU = 'claude-haiku-5-5';
const SHORT = { inputTokens: 60_000, outputTokens: 1_000 };
// Base tier: $0.10 input, $0.50 output per million.
const SHORT_COST = (60_000 * 0.10 + 1_000 * 0.50) / 1e6;

describe('long-prompt tier, per request', () => {
  it('prices each round of a turn on its own prompt', () => {
    const turn = new TurnUsageAccumulator(HAIKU, () => getDefaultPricing(HAIKU));
    turn.addRound(HAIKU, SHORT);
    const total = turn.addRound(HAIKU, SHORT);
    expect(total.inputTokens).toBe(120_000);
    expect(total.estimatedCost?.total).toBeCloseTo(2 * SHORT_COST, 12);
    // Had the 120,000 been priced as one prompt: $0.50 input, $2.50 output.
    expect(total.estimatedCost?.total).not.toBeCloseTo((120_000 * 0.50 + 2_000 * 2.50) / 1e6, 12);
  });

  it('prices each abandoned attempt on its own prompt', async () => {
    class RefusingTwice implements ProviderAdapter {
      readonly name = 'zz-tier';
      calls = 0;
      supportsModel() { return true; }
      async complete(): Promise<ProviderResponse> {
        const refusing = this.calls < 2;
        this.calls++;
        return {
          content: [{ type: 'text', text: refusing ? 'no' : 'yes' }],
          stopReason: refusing ? 'refusal' : 'end_turn',
          usage: refusing ? { ...SHORT } : { inputTokens: 10, outputTokens: 1 },
          model: HAIKU,
          raw: { response: { stop_reason: refusing ? 'refusal' : 'end_turn' } },
        } as unknown as ProviderResponse;
      }
      async stream(): Promise<ProviderResponse> { return this.complete(); }
    }
    const request: NormalizedRequest = {
      messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz' }] }],
      toolMode: 'native',
      tools: [{ name: 'zz_noop', description: 'zz', inputSchema: { type: 'object', properties: {} } }],
      config: { model: HAIKU, maxTokens: 10 },
    };
    const response = await new Membrane(new RefusingTwice()).complete(request, { refusalRetries: 2 });
    const discarded = response.details.usage.discardedAttempts!;
    expect(discarded).toMatchObject({ attempts: 2, inputTokens: 120_000, outputTokens: 2_000 });
    expect(discarded.estimatedCost?.total).toBeCloseTo(2 * SHORT_COST, 12);
  });

  it('carries no summed cost once a round had none, and does not pick it up again after a priced round', async () => {
    const turn = new TurnUsageAccumulator('zz-unpriced', () => undefined);
    turn.addRound('zz-unpriced', SHORT);
    expect(turn.addRound('zz-unpriced', SHORT).estimatedCost).toBeUndefined();
    // Priced, unpriced, priced: a partial total would be a wrong one.
    const mixed = new TurnUsageAccumulator(HAIKU, (served) => (served === 'zz-unpriced-served' ? undefined : getDefaultPricing(HAIKU)));
    expect(mixed.addRound(HAIKU, SHORT).estimatedCost?.total).toBeCloseTo(SHORT_COST, 12);
    expect(mixed.addRound('zz-unpriced-served', SHORT).estimatedCost).toBeUndefined();
    expect(mixed.addRound(HAIKU, SHORT).estimatedCost).toBeUndefined();
  });

  /** Refuses `refusals` times, each attempt served by the model `served(n)` names, then answers. */
  function refusing(refusals: number, served: (attempt: number) => string): ProviderAdapter & { calls: number; response: () => ProviderResponse } {
    return new class implements ProviderAdapter {
      readonly name = 'zz-tier-served';
      calls = 0;
      supportsModel() { return true; }
      response(): ProviderResponse {
        const n = ++this.calls;
        const refusing = n <= refusals;
        return {
          content: [{ type: 'text', text: refusing ? 'no' : 'yes' }],
          stopReason: refusing ? 'refusal' : 'end_turn',
          usage: refusing ? { ...SHORT } : { inputTokens: 10, outputTokens: 1 },
          model: served(n),
          raw: { response: { stop_reason: refusing ? 'refusal' : 'end_turn' } },
        } as unknown as ProviderResponse;
      }
      async complete(): Promise<ProviderResponse> { return this.response(); }
      async stream(_request: unknown, callbacks: StreamCallbacks): Promise<ProviderResponse> {
        callbacks.onChunk?.('zz');
        return this.response();
      }
    }();
  }
  const request = (model: string): NormalizedRequest => ({
    messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz' }] }],
    toolMode: 'native',
    tools: [{ name: 'zz_noop', description: 'zz', inputSchema: { type: 'object', properties: {} } }],
    config: { model, maxTokens: 10 },
  });

  it('carries no summed cost over the abandoned attempts once one of them had none', async () => {
    // The requested model has no price; the first attempt was served by one that
    // does, the second by one that doesn't. A sum with an unpriced part is no sum.
    // First, that a Haiku-served attempt under an unpriced requested model is priced at all.
    const one = await new Membrane(refusing(1, () => HAIKU)).complete(request('zz-unpriced'), { refusalRetries: 1 });
    expect(one.details.usage.discardedAttempts!.estimatedCost?.total).toBeCloseTo(SHORT_COST, 12);
    const adapter = refusing(2, (n) => (n === 1 ? HAIKU : 'zz-unpriced-served'));
    const response = await new Membrane(adapter).complete(request('zz-unpriced'), { refusalRetries: 2 });
    const discarded = response.details.usage.discardedAttempts!;
    expect(discarded).toMatchObject({ attempts: 2, inputTokens: 120_000 });
    expect(discarded.estimatedCost).toBeUndefined();
    // The other order too: the priced attempt second.
    const reversed = refusing(2, (n) => (n === 2 ? HAIKU : 'zz-unpriced-served'));
    const again = await new Membrane(reversed).complete(request('zz-unpriced'), { refusalRetries: 2 });
    expect(again.details.usage.discardedAttempts!.estimatedCost).toBeUndefined();
    // Priced, unpriced, priced: the sum does not come back with the third.
    const three = refusing(3, (n) => (n === 2 ? 'zz-unpriced-served' : HAIKU));
    const thrice = await new Membrane(three).complete(request('zz-unpriced'), { refusalRetries: 3 });
    expect(thrice.details.usage.discardedAttempts).toMatchObject({ attempts: 3 });
    expect(thrice.details.usage.discardedAttempts!.estimatedCost).toBeUndefined();
  });

  it('prices no attempt whose provider left a usage count unreported, so the attempts carry no sum', async () => {
    const adapter = refusing(2, () => HAIKU);
    const original = adapter.response.bind(adapter);
    adapter.response = () => {
      const r = original();
      // The first refusal came with no usage: zeros kept for accounting, marked unreported.
      if (adapter.calls === 1) Object.assign(r, { usage: { inputTokens: 0, outputTokens: 0 }, unreportedUsage: ['inputTokens', 'outputTokens'] });
      return r;
    };
    const response = await new Membrane(adapter).complete(request(HAIKU), { refusalRetries: 2 });
    const discarded = response.details.usage.discardedAttempts!;
    expect(discarded).toMatchObject({ attempts: 2, inputTokens: 60_000 });
    expect(discarded.estimatedCost).toBeUndefined();
  });

  it('pricingFor gives a copy whose tier is the caller\'s own', () => {
    const membrane = new Membrane(refusing(0, () => HAIKU));
    const copy = membrane.pricingFor(HAIKU)!;
    copy.longPrompt!.inputPerMillion = 999;
    expect(membrane.pricingFor(HAIKU)!.longPrompt!.inputPerMillion).toBe(0.50);
    expect(getDefaultPricing(HAIKU)!.longPrompt!.inputPerMillion).toBe(0.50);
  });

  it('prices each abandoned attempt on its own prompt at the streaming refusal-retry site too', async () => {
    const adapter = refusing(2, () => HAIKU);
    const events: StreamEvent[] = [];
    for await (const ev of new Membrane(adapter).streamYielding(request(HAIKU), { refusalRetries: 2 })) events.push(ev);
    const complete = events.find((e) => e.type === 'complete') as { response: NormalizedResponse } | undefined;
    expect(complete).toBeDefined();
    const discarded = complete!.response.details.usage.discardedAttempts!;
    expect(discarded).toMatchObject({ attempts: 2, inputTokens: 120_000, outputTokens: 2_000 });
    // Twice the short price; priced as one 120,000-token prompt it would be $0.065.
    expect(discarded.estimatedCost?.total).toBeCloseTo(2 * SHORT_COST, 12);
    expect(discarded.estimatedCost?.total).not.toBeCloseTo((120_000 * 0.50 + 2_000 * 2.50) / 1e6, 12);
  });

  it("prices an abandoned attempt from the caller's model when a beforeRequest hook sent another and the served one is unpriced, at the streaming site", async () => {
    // The caller's registry prices zz-caller; the hook sends zz-hooked (unpriced); the adapter reports an unpriced served model.
    const registry: ModelRegistry = {
      getPricing: (id: string) => (id === 'zz-caller' ? { inputPerMillion: 1, outputPerMillion: 2, currency: 'USD' } : undefined),
      getCapabilities: () => undefined,
      getQuirks: () => undefined,
      getModel: () => undefined,
    } as unknown as ModelRegistry;
    const adapter = refusing(1, () => 'zz-unpriced-served');
    const membrane = new Membrane(adapter, {
      registry,
      hooks: { beforeRequest: (_normalized, raw) => ({ ...(raw as Record<string, unknown>), model: 'zz-hooked' }) },
    });
    const events: StreamEvent[] = [];
    for await (const ev of membrane.streamYielding(request('zz-caller'), { refusalRetries: 1 })) events.push(ev);
    const complete = events.find((e) => e.type === 'complete') as { response: NormalizedResponse } | undefined;
    const discarded = complete!.response.details.usage.discardedAttempts!;
    expect(discarded.attempts).toBe(1);
    // zz-caller's rates: $1 input, $2 output on 60,000 / 1,000.
    expect(discarded.estimatedCost?.total).toBeCloseTo((60_000 * 1 + 1_000 * 2) / 1e6, 12);
  });

  it('normalizes a cache-inclusive attempt before choosing its tier', async () => {
    // 100,000 input tokens of which 50,000 cached, cache-inclusive: a 100,000-token
    // prompt, at the threshold, so the base tier — not 150,000 and the long one.
    const inclusive = refusing(1, () => HAIKU);
    (inclusive as { usageCacheConvention?: string }).usageCacheConvention = 'cache-inclusive';
    const original = inclusive.response.bind(inclusive);
    inclusive.response = () => {
      const r = original();
      if (r.stopReason === 'refusal') (r as { usage: unknown }).usage = { inputTokens: 100_000, outputTokens: 1_000, cacheReadTokens: 50_000 };
      return r;
    };
    const response = await new Membrane(inclusive).complete(request(HAIKU), { refusalRetries: 1 });
    const discarded = response.details.usage.discardedAttempts!;
    expect(discarded).toMatchObject({ attempts: 1, inputTokens: 50_000, cacheReadTokens: 50_000 });
    // Base tier: $0.10 input, $0.01 cached, $0.50 output.
    expect(discarded.estimatedCost?.total).toBeCloseTo((50_000 * 0.10 + 50_000 * 0.01 + 1_000 * 0.50) / 1e6, 12);
  });
});
