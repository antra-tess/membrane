/**
 * A long-prompt tier is chosen per request. Two 60,000-token Haiku 5.5
 * requests are two short prompts, whether they are the rounds of one turn or
 * two abandoned attempts — never one 120,000-token prompt.
 */
import { describe, it, expect } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { TurnUsageAccumulator } from '../../src/utils/usage.js';
import { getDefaultPricing } from '../../src/registry/default-pricing.js';
import type { ProviderAdapter, ProviderResponse } from '../../src/types/provider.js';
import type { NormalizedRequest } from '../../src/types/index.js';

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

  it('carries no summed cost once an attempt had none', async () => {
    const turn = new TurnUsageAccumulator('zz-unpriced', () => undefined);
    turn.addRound('zz-unpriced', SHORT);
    expect(turn.addRound('zz-unpriced', SHORT).estimatedCost).toBeUndefined();
  });
});
