import { describe, it, expect } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { getDefaultPricing } from '../../src/registry/default-pricing.js';
import type {
  ModelPricing,
  ProviderAdapter,
  ProviderRequest,
  ProviderResponse,
  StreamCallbacks,
  NormalizedRequest,
  NormalizedResponse,
  ToolDefinition,
  ToolResult,
} from '../../src/types/index.js';

const ZZ_REQUESTED_ALIAS = 'gpt-4o-zz-alias1';
const ZZ_SERVED_SNAPSHOT = 'gpt-4o-2024-05-13-zz-snapshot1';
const ZZ_SERVED_UNSHIPPED = 'zz-unshipped-model-fld1';

const ZZ_TOKENS = 1_000_000;
const ZZ_REGISTRY_REQUESTED_RATE = 1_000;
const ZZ_REGISTRY_SERVED_RATE = 10_000;

function zzRegistryPricing(rates: Record<string, number>) {
  return {
    getPricing: (modelId: string): ModelPricing | undefined => (
      rates[modelId] === undefined
        ? undefined
        : { inputPerMillion: rates[modelId]!, outputPerMillion: rates[modelId]!, currency: 'USD' }
    ),
    getCapabilities: () => undefined,
    getQuirks: () => undefined,
    getModel: () => undefined,
    resolveModel: (id: string) => id,
    listModels: () => [],
  } as any;
}

function adapterServing(servedModel: string): ProviderAdapter {
  const response = (request: ProviderRequest): ProviderResponse => ({
    content: [{ type: 'text', text: 'zz-reply' }],
    stopReason: 'end_turn',
    usage: { inputTokens: ZZ_TOKENS, outputTokens: 0 },
    model: servedModel,
    rawRequest: request,
    raw: {},
  } as ProviderResponse);

  return {
    name: 'zz-adapter',
    usageCacheConvention: 'cache-excluded',
    supportsModel: () => true,
    async complete(request: ProviderRequest) { return response(request); },
    async stream(request: ProviderRequest, callbacks: StreamCallbacks) {
      callbacks.onChunk('zz-reply');
      return response(request);
    },
  };
}

const ZZ_REQUEST = {
  config: { model: ZZ_REQUESTED_ALIAS, maxTokens: 64 },
  messages: [{ role: 'user', content: [{ type: 'text', text: 'zz-prompt' }] }],
} as unknown as NormalizedRequest;

function inputCostOf(perMillion: number): number {
  return ZZ_TOKENS * perMillion / 1_000_000;
}

function shippedInputRate(modelId: string): number {
  const pricing = getDefaultPricing(modelId);
  if (!pricing) throw new Error(`zz-fixture: expected a shipped row for ${modelId}`);
  return pricing.inputPerMillion;
}

describe('pricing source precedence', () => {
  it('is only discriminating while the two shipped fixture rows differ', () => {
    expect(shippedInputRate(ZZ_SERVED_SNAPSHOT)).not.toBe(shippedInputRate(ZZ_REQUESTED_ALIAS));
    expect(getDefaultPricing(ZZ_SERVED_UNSHIPPED)).toBeUndefined();
  });

  it('prefers the registry on the REQUESTED alias over a builtin on the served snapshot', async () => {
    const membrane = new Membrane(
      adapterServing(ZZ_SERVED_SNAPSHOT),
      { registry: zzRegistryPricing({ [ZZ_REQUESTED_ALIAS]: ZZ_REGISTRY_REQUESTED_RATE }) },
    );
    const response = await membrane.complete(ZZ_REQUEST);

    expect(response.details.usage.estimatedCost?.input)
      .toBeCloseTo(inputCostOf(ZZ_REGISTRY_REQUESTED_RATE), 6);
  });

  it('prefers the registry on the requested alias on the streaming path too', async () => {
    const membrane = new Membrane(
      adapterServing(ZZ_SERVED_SNAPSHOT),
      { registry: zzRegistryPricing({ [ZZ_REQUESTED_ALIAS]: ZZ_REGISTRY_REQUESTED_RATE }) },
    );
    const response = await membrane.stream(ZZ_REQUEST);

    expect(response.details.usage.estimatedCost?.input)
      .toBeCloseTo(inputCostOf(ZZ_REGISTRY_REQUESTED_RATE), 6);
  });

  it('breaks the tie on served-model specificity when the registry prices BOTH ids', async () => {
    const membrane = new Membrane(adapterServing(ZZ_SERVED_SNAPSHOT), {
      registry: zzRegistryPricing({
        [ZZ_REQUESTED_ALIAS]: ZZ_REGISTRY_REQUESTED_RATE,
        [ZZ_SERVED_SNAPSHOT]: ZZ_REGISTRY_SERVED_RATE,
      }),
    });
    const response = await membrane.complete(ZZ_REQUEST);

    expect(response.details.usage.estimatedCost?.input)
      .toBeCloseTo(inputCostOf(ZZ_REGISTRY_SERVED_RATE), 6);
  });

  it('falls to the builtin on the SERVED snapshot when no registry is configured', async () => {
    const membrane = new Membrane(adapterServing(ZZ_SERVED_SNAPSHOT));
    const response = await membrane.complete(ZZ_REQUEST);

    expect(response.details.usage.estimatedCost?.input)
      .toBeCloseTo(inputCostOf(shippedInputRate(ZZ_SERVED_SNAPSHOT)), 6);
  });

  it('falls to the builtin on the requested alias when the served id ships no row', async () => {
    const membrane = new Membrane(adapterServing(ZZ_SERVED_UNSHIPPED));
    const response = await membrane.complete(ZZ_REQUEST);

    expect(response.details.usage.estimatedCost?.input)
      .toBeCloseTo(inputCostOf(shippedInputRate(ZZ_REQUESTED_ALIAS)), 6);
  });

  it('still reports no cost when neither source prices either id', async () => {
    const unshippedRequest = {
      config: { model: 'zz-unshipped-alias-fld1', maxTokens: 64 },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'zz-prompt' }] }],
    } as unknown as NormalizedRequest;
    const membrane = new Membrane(adapterServing(ZZ_SERVED_UNSHIPPED));
    const response = await membrane.complete(unshippedRequest);

    expect(response.details.usage.estimatedCost).toBeUndefined();
  });
});

const ZZ_ROUND_ONE_SERVED = 'gpt-4o-zz-round1';
const ZZ_ROUND_TWO_SERVED = 'gpt-4o-2024-05-13-zz-round2';

const zzTool: ToolDefinition = {
  name: 'zz-noop',
  description: 'Forces a second round.',
  inputSchema: { type: 'object', properties: {} },
};

function zzTwoRoundAdapter(): ProviderAdapter {
  const servedModels = [ZZ_ROUND_ONE_SERVED, ZZ_ROUND_TWO_SERVED];
  let round = 0;

  const xmlText = (n: number) => (
    n === 0
      ? 'zz-prose\n<function_calls><invoke name="zz-noop">'
        + '<parameter name="p">1</parameter></invoke></function_calls>'
      : 'zz-final'
  );

  const respond = (n: number, request: ProviderRequest): ProviderResponse => ({
    content: [{ type: 'text', text: xmlText(n) }],
    stopReason: 'end_turn',
    usage: { inputTokens: ZZ_TOKENS, outputTokens: 0 },
    model: servedModels[Math.min(n, servedModels.length - 1)]!,
    rawRequest: request,
    raw: {},
  } as ProviderResponse);

  return {
    name: 'zz-adapter',
    usageCacheConvention: 'cache-excluded',
    supportsModel: () => true,
    async complete(request: ProviderRequest) { return respond(round++, request); },
    async stream(request: ProviderRequest, callbacks: StreamCallbacks) {
      const n = round++;
      callbacks.onChunk(xmlText(n));
      return respond(n, request);
    },
  };
}

describe('pricing source precedence, per round', () => {
  it('applies the same precedence to every perRound row independently', async () => {
    const membrane = new Membrane(zzTwoRoundAdapter(), {
      registry: zzRegistryPricing({
        [ZZ_REQUESTED_ALIAS]: ZZ_REGISTRY_REQUESTED_RATE,
        [ZZ_ROUND_TWO_SERVED]: ZZ_REGISTRY_SERVED_RATE,
      }),
    });
    const response = await membrane.stream(
      { ...ZZ_REQUEST, tools: [zzTool], toolMode: 'xml' } as unknown as NormalizedRequest,
      { onToolCalls: async (calls: Array<{ id: string }>): Promise<ToolResult[]> =>
        calls.map((call) => ({ toolUseId: call.id, content: 'zz-result', isError: false })) },
    ) as NormalizedResponse;

    const perRound = response.details.model.perRound;
    expect(perRound?.map((r) => r.model)).toEqual([ZZ_ROUND_ONE_SERVED, ZZ_ROUND_TWO_SERVED]);
    expect(perRound?.[0]?.usage.estimatedCost?.total)
      .toBeCloseTo(inputCostOf(ZZ_REGISTRY_REQUESTED_RATE), 6);
    expect(perRound?.[1]?.usage.estimatedCost?.total)
      .toBeCloseTo(inputCostOf(ZZ_REGISTRY_SERVED_RATE), 6);
    expect(response.usage.estimatedCost?.total)
      .toBeCloseTo(inputCostOf(ZZ_REGISTRY_REQUESTED_RATE + ZZ_REGISTRY_SERVED_RATE), 6);
  });
});
