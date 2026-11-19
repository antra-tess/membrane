import { describe, it, expect } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { AnthropicXmlFormatter } from '../../src/formatters/anthropic-xml.js';
import { getDefaultPricing } from '../../src/registry/default-pricing.js';
import type { ModelPricing, ModelRegistry, ProviderAdapter, ProviderRequest, ProviderResponse } from '../../src/types/index.js';

function adapter(sendsSystemChanges: boolean | undefined): ProviderAdapter {
  const response = (request: ProviderRequest): ProviderResponse => ({
    content: [{ type: 'text', text: 'zz-reply' }],
    stopReason: 'end_turn',
    usage: { inputTokens: 1, outputTokens: 1 },
    model: request.model,
    rawRequest: request,
    raw: {},
  });
  return {
    name: 'zz-adapter',
    ...(sendsSystemChanges === undefined ? {} : { sendsSystemChanges }),
    supportsModel: () => true,
    async complete(request: ProviderRequest) { return response(request); },
    async stream(request: ProviderRequest) { return response(request); },
  };
}

const sending = () => new Membrane(adapter(true), { formatter: new NativeFormatter() });

describe('takesToolOrSystemChanges', () => {
  it('refuses the models that refused a change in a run, by their dated, Vertex and gateway ids too', () => {
    const membrane = sending();
    for (const model of [
      'claude-sonnet-5',
      'claude-sonnet-5-20260115',
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-opus-4-5',
      'claude-opus-4-5-20251101',
      'claude-opus-4-5@20251101',
      'claude-sonnet-4-6',
      'anthropic/claude-sonnet-4.6',
      'us.anthropic.claude-sonnet-4-6-v1:0',
      'claude-sonnet-4-5',
      'claude-haiku-4-5',
    ]) expect(membrane.takesToolOrSystemChanges(model), model).toBe(false);
  });

  it('refuses the Claude models that come before those', () => {
    const membrane = sending();
    for (const model of [
      'claude-opus-4-1',
      'claude-opus-4-1-20250805',
      'claude-opus-4-0',
      'claude-opus-4-20250514',
      'claude-sonnet-4-0',
      'claude-sonnet-4-20250514',
      'claude-3-7-sonnet-20250219',
      'claude-3-5-sonnet-v2@20241022',
      'claude-3-5-haiku',
      'claude-3-opus-20240229',
      'claude-2.1',
      'claude-1.3',
      'claude-v1',
      'claude-instant-1.2',
      'claude-instant-v1',
    ]) expect(membrane.takesToolOrSystemChanges(model), model).toBe(false);
  });

  it('takes the models that took a change in a run', () => {
    const membrane = sending();
    for (const model of [
      'claude-fable-5-1',
      'claude-fable-5',
      'claude-opus-5-5',
      'claude-opus-5',
      'claude-opus-4-8',
      'bedrock:claude-opus-4-8',
      'claude-sonnet-5-5',
      'anthropic/claude-sonnet-5.5',
      'claude-haiku-5-5',
    ]) expect(membrane.takesToolOrSystemChanges(model), model).toBe(true);
  });

  it('tries a model that no run covers, a later minor version of a refusing model included', () => {
    const membrane = sending();
    for (const model of ['claude-sonnet-5-1', 'claude-opus-4-9', 'claude-haiku-4-6', 'claude-fable-5-2', 'claude-mythos-5', 'claude-opus-6', 'claude-10', 'zz-unknown-model']) {
      expect(membrane.takesToolOrSystemChanges(model), model).toBe(true);
    }
  });

  it("goes by the request's own formatter where it names one, and by the membrane's otherwise", () => {
    const xmlByDefault = new Membrane(adapter(true));
    expect(xmlByDefault.takesToolOrSystemChanges('claude-opus-5')).toBe(false);
    expect(xmlByDefault.takesToolOrSystemChanges('claude-opus-5', { formatter: new NativeFormatter() })).toBe(true);
    expect(sending().takesToolOrSystemChanges('claude-opus-5', { formatter: new AnthropicXmlFormatter() })).toBe(false);
  });

  it('is false for every model where the adapter sends no change', () => {
    for (const membrane of [
      new Membrane(adapter(undefined), { formatter: new NativeFormatter() }),
      new Membrane(adapter(false), { formatter: new NativeFormatter() }),
    ]) {
      expect(membrane.takesToolOrSystemChanges('claude-opus-5')).toBe(false);
      expect(membrane.takesToolOrSystemChanges('zz-unknown-model')).toBe(false);
    }
  });
});

describe('pricingFor', () => {
  const registry = (prices: Record<string, ModelPricing>): ModelRegistry => ({
    getPricing: (model) => prices[model],
    getCapabilities: () => undefined,
    getQuirks: () => undefined,
    getModel: () => undefined,
    resolveModel: (model) => model,
    listModels: () => [],
  });

  it("gives the registry's prices for a model it prices", () => {
    const own: ModelPricing = { inputPerMillion: 7, outputPerMillion: 9, cacheWritePerMillion: 8, cacheReadPerMillion: 0.7, currency: 'USD' };
    const membrane = new Membrane(adapter(true), { registry: registry({ 'claude-opus-5': own }) });
    expect(membrane.pricingFor('claude-opus-5')).toEqual(own);
  });

  it("gives the built-in table's prices where the registry has none", () => {
    const membrane = new Membrane(adapter(true), { registry: registry({}) });
    expect(membrane.pricingFor('claude-opus-5')?.cacheWritePerMillion).toBeGreaterThan(0);
    expect(membrane.pricingFor('claude-opus-5')).toEqual(getDefaultPricing('claude-opus-5'));
  });

  it('gives a copy, so a change to it changes no later price', () => {
    const membrane = new Membrane(adapter(true));
    const first = membrane.pricingFor('claude-opus-5');
    if (!first) throw new Error('the built-in table prices claude-opus-5');
    const before = first.inputPerMillion;
    first.inputPerMillion = before + 1000;
    expect(membrane.pricingFor('claude-opus-5')?.inputPerMillion).toBe(before);
    expect(getDefaultPricing('claude-opus-5')?.inputPerMillion).toBe(before);
  });

  it('gives nothing for a model that neither prices', () => {
    expect(new Membrane(adapter(true)).pricingFor('zz-unknown-model')).toBeUndefined();
  });
});
