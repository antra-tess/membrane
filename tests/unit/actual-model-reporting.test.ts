/**
 * The model that served a request is frequently not the one that was asked
 * for: aliases resolve to dated snapshots (a live 2026-08-25 call asking for
 * `gpt-4o-mini` was served by `gpt-4o-mini-2024-07-18`), and OpenRouter routes
 * to whichever provider it picked. `complete()` reported that resolved model as
 * `details.model.actual`; the streaming paths echoed the REQUESTED id back
 * under a `// TODO: get from response` and discarded the value the adapter was
 * already handing them.
 *
 * Pricing had the mirror of the same bug: it was always resolved from the
 * requested id, so an alias priced against a string the provider replaced.
 */
import { describe, it, expect } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import type {
  ProviderAdapter,
  ProviderRequest,
  ProviderResponse,
  StreamCallbacks,
  NormalizedRequest,
} from '../../src/types/index.js';

const ZZ_REQUESTED_MODEL = 'zz-model-1';
const ZZ_SERVED_MODEL = 'zz-model-1-snapshot-fld1';

/** Priced 10x apart so which id was used is unambiguous in the arithmetic. */
const zzRegistry = {
  getPricing: (modelId: string) => (
    modelId === ZZ_SERVED_MODEL
      ? { inputPerMillion: 10_000, outputPerMillion: 10_000, currency: 'USD' }
      : { inputPerMillion: 1_000, outputPerMillion: 1_000, currency: 'USD' }
  ),
  getCapabilities: () => undefined,
  getQuirks: () => undefined,
  getModel: () => undefined,
  resolveAlias: (id: string) => id,
  listModels: () => [],
} as any;

function adapterServing(servedModel: string): ProviderAdapter {
  const response = (request: ProviderRequest): ProviderResponse => ({
    content: [{ type: 'text', text: 'zz-reply' }],
    stopReason: 'end_turn',
    usage: { inputTokens: 1_000_000, outputTokens: 0 },
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
  config: { model: ZZ_REQUESTED_MODEL, maxTokens: 64 },
  messages: [{ role: 'user', content: [{ type: 'text', text: 'zz-prompt' }] }],
} as unknown as NormalizedRequest;

describe('details.model.actual', () => {
  it('reports the served model on complete() (regression)', async () => {
    const membrane = new Membrane(adapterServing(ZZ_SERVED_MODEL), { registry: zzRegistry });
    const response = await membrane.complete(ZZ_REQUEST);

    expect(response.details.model.requested).toBe(ZZ_REQUESTED_MODEL);
    expect(response.details.model.actual).toBe(ZZ_SERVED_MODEL);
  });

  it('reports the served model on stream()', async () => {
    const membrane = new Membrane(adapterServing(ZZ_SERVED_MODEL), { registry: zzRegistry });
    const response = await membrane.stream(ZZ_REQUEST);

    expect(response.details.model.requested).toBe(ZZ_REQUESTED_MODEL);
    expect(response.details.model.actual).toBe(ZZ_SERVED_MODEL);
  });

  it('falls back to the requested model when the adapter reports none', async () => {
    const membrane = new Membrane(adapterServing('' as string), { registry: zzRegistry });
    const response = await membrane.stream(ZZ_REQUEST);

    expect(response.details.model.actual).toBe(ZZ_REQUESTED_MODEL);
  });
});

describe('pricing resolution', () => {
  it('prices against the served model on complete()', async () => {
    const membrane = new Membrane(adapterServing(ZZ_SERVED_MODEL), { registry: zzRegistry });
    const response = await membrane.complete(ZZ_REQUEST);

    // 1M input tokens at the served model's 10,000/M rate.
    expect(response.details.usage.estimatedCost?.input).toBeCloseTo(10_000, 6);
  });

  it('prices against the served model on stream()', async () => {
    const membrane = new Membrane(adapterServing(ZZ_SERVED_MODEL), { registry: zzRegistry });
    const response = await membrane.stream(ZZ_REQUEST);

    expect(response.details.usage.estimatedCost?.input).toBeCloseTo(10_000, 6);
  });

  it('falls back to the requested model when the served model has no pricing', async () => {
    const sparseRegistry = {
      ...zzRegistry,
      getPricing: (modelId: string) => (
        modelId === ZZ_REQUESTED_MODEL
          ? { inputPerMillion: 1_000, outputPerMillion: 1_000, currency: 'USD' }
          : undefined
      ),
    };
    const membrane = new Membrane(adapterServing(ZZ_SERVED_MODEL), { registry: sparseRegistry });
    const response = await membrane.complete(ZZ_REQUEST);

    expect(response.details.usage.estimatedCost?.input).toBeCloseTo(1_000, 6);
  });
});
