/**
 * A routed turn can be served by DIFFERENT models on different rounds —
 * OpenRouter re-picks a provider per call, and an alias can resolve to a new
 * snapshot mid-turn. Each streaming loop re-resolved pricing when the served
 * model changed and then recomputed the WHOLE accumulated usage at that latest
 * rate, so every earlier round was retroactively re-billed at the newest
 * model's price.
 *
 * Probe (sol, 2026-08-25): two rounds of 1M input tokens, round 1 served by a
 * model priced 1,000/M and round 2 by one priced 10,000/M. The bill is
 * 1,000 + 10,000 = 11,000; membrane reported 2M × 10,000/M = 20,000.
 *
 * Every one of the four tool loops carried the bug, so every one is probed.
 */
import { describe, it, expect } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import type {
  ProviderAdapter,
  ProviderRequest,
  ProviderResponse,
  StreamCallbacks,
  NormalizedRequest,
  NormalizedResponse,
  ToolDefinition,
  ToolResult,
} from '../../src/types/index.js';

const ZZ_REQUESTED_MODEL = 'zz-model-req';
const ZZ_ROUND_ONE_MODEL = 'zz-model-a';
const ZZ_ROUND_TWO_MODEL = 'zz-model-b';

const ZZ_ROUND_TOKENS = 1_000_000;
const ZZ_ROUND_ONE_RATE = 1_000;
const ZZ_ROUND_TWO_RATE = 10_000;
/** 1M at 1,000/M plus 1M at 10,000/M — what the provider actually bills. */
const ZZ_BILLED_TOTAL = ZZ_ROUND_ONE_RATE + ZZ_ROUND_TWO_RATE;

const zzRates: Record<string, number> = {
  [ZZ_ROUND_ONE_MODEL]: ZZ_ROUND_ONE_RATE,
  [ZZ_ROUND_TWO_MODEL]: ZZ_ROUND_TWO_RATE,
  // Deliberately absurd: a fallback to the requested id shows up immediately.
  [ZZ_REQUESTED_MODEL]: 7,
};

const zzRegistry = {
  getPricing: (modelId: string) => (
    zzRates[modelId] === undefined
      ? undefined
      : { inputPerMillion: zzRates[modelId]!, outputPerMillion: zzRates[modelId]!, currency: 'USD' }
  ),
  getCapabilities: () => undefined,
  getQuirks: () => undefined,
  getModel: () => undefined,
  resolveAlias: (id: string) => id,
  listModels: () => [],
} as any;

const zzTool: ToolDefinition = {
  name: 'zz-noop',
  description: 'Forces a second round.',
  inputSchema: { type: 'object', properties: {} },
};

/**
 * Serves one scripted round per call: round 1 asks for a tool (so the loop
 * runs again), round 2 ends the turn. Each round names its own served model.
 */
function zzScriptedAdapter(mode: 'xml' | 'native'): ProviderAdapter {
  const servedModels = [ZZ_ROUND_ONE_MODEL, ZZ_ROUND_TWO_MODEL];
  let round = 0;

  const xmlText = (n: number) => (
    n === 0
      ? 'zz-prose\n<function_calls><invoke name="zz-noop">'
        + '<parameter name="p">1</parameter></invoke></function_calls>'
      : 'zz-final'
  );

  const respond = (n: number, request: ProviderRequest): ProviderResponse => ({
    content: mode === 'native'
      ? (n === 0
        ? [{ type: 'tool_use', id: 'zz-call-1', name: 'zz-noop', input: {} }]
        : [{ type: 'text', text: 'zz-final' }])
      : [{ type: 'text', text: xmlText(n) }],
    stopReason: mode === 'native' && n === 0 ? 'tool_use' : 'end_turn',
    usage: { inputTokens: ZZ_ROUND_TOKENS, outputTokens: 0 },
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
      if (mode === 'xml') callbacks.onChunk(xmlText(n));
      else if (n > 0) callbacks.onChunk('zz-final');
      return respond(n, request);
    },
  };
}

function zzRequest(mode: 'xml' | 'native'): NormalizedRequest {
  return {
    messages: [{ role: 'user', content: [{ type: 'text', text: 'zz-prompt' }] }],
    config: { model: ZZ_REQUESTED_MODEL, maxTokens: 64 },
    tools: [zzTool],
    ...(mode === 'native' ? { toolMode: 'native' } : {}),
  } as unknown as NormalizedRequest;
}

const zzResults = (calls: Array<{ id: string }>): ToolResult[] =>
  calls.map((c) => ({ toolUseId: c.id, content: 'zz-result', isError: false }));

async function driveCallback(mode: 'xml' | 'native'): Promise<NormalizedResponse> {
  const membrane = new Membrane(zzScriptedAdapter(mode), { registry: zzRegistry });
  const response = await membrane.stream(zzRequest(mode), {
    onToolCalls: async (calls) => zzResults(calls),
  });
  return response as NormalizedResponse;
}

async function driveYielding(mode: 'xml' | 'native'): Promise<NormalizedResponse> {
  const membrane = new Membrane(zzScriptedAdapter(mode), { registry: zzRegistry });
  const stream = membrane.streamYielding(zzRequest(mode), {});
  let final: NormalizedResponse | undefined;
  for await (const event of stream) {
    if (event.type === 'tool-calls') {
      stream.provideToolResults(zzResults(event.calls));
    } else if (event.type === 'complete') {
      final = event.response as NormalizedResponse;
      break;
    } else if (event.type === 'aborted' || event.type === 'error') {
      break;
    }
  }
  if (!final) throw new Error('zz-drive: no complete event');
  return final;
}

const zzPaths: Array<[string, () => Promise<NormalizedResponse>]> = [
  ['stream() + XML tools', () => driveCallback('xml')],
  ['stream() + native tools', () => driveCallback('native')],
  ['streamYielding() + XML tools', () => driveYielding('xml')],
  ['streamYielding() + native tools', () => driveYielding('native')],
];

describe('multi-round pricing', () => {
  for (const [label, drive] of zzPaths) {
    it(`prices each round at its own served model's rate on ${label}`, async () => {
      const response = await drive();

      expect(response.usage.inputTokens).toBe(ZZ_ROUND_TOKENS * 2);
      expect(response.usage.estimatedCost?.total).toBeCloseTo(ZZ_BILLED_TOTAL, 6);
      expect(response.details.usage.estimatedCost?.total).toBeCloseTo(ZZ_BILLED_TOTAL, 6);
    });

    it(`reports the last served model and a per-round roster on ${label}`, async () => {
      const response = await drive();

      expect(response.details.model.requested).toBe(ZZ_REQUESTED_MODEL);
      expect(response.details.model.actual).toBe(ZZ_ROUND_TWO_MODEL);

      const perRound = response.details.model.perRound;
      expect(perRound?.map((r) => r.model)).toEqual([ZZ_ROUND_ONE_MODEL, ZZ_ROUND_TWO_MODEL]);
      expect(perRound?.[0]?.usage.estimatedCost?.total).toBeCloseTo(ZZ_ROUND_ONE_RATE, 6);
      expect(perRound?.[1]?.usage.estimatedCost?.total).toBeCloseTo(ZZ_ROUND_TWO_RATE, 6);
      expect(perRound?.[0]?.usage.inputTokens).toBe(ZZ_ROUND_TOKENS);
    });
  }

  it('omits the turn total when a round has no rates, rather than under-reporting', async () => {
    const sparseRegistry = {
      ...zzRegistry,
      getPricing: (modelId: string) => (
        modelId === ZZ_ROUND_ONE_MODEL
          ? { inputPerMillion: ZZ_ROUND_ONE_RATE, outputPerMillion: ZZ_ROUND_ONE_RATE, currency: 'USD' }
          : undefined
      ),
    };
    const membrane = new Membrane(zzScriptedAdapter('xml'), { registry: sparseRegistry });
    const response = await membrane.stream(zzRequest('xml'), {
      onToolCalls: async (calls) => zzResults(calls),
    }) as NormalizedResponse;

    expect(response.usage.estimatedCost).toBeUndefined();
    expect(response.details.usage.estimatedCost).toBeUndefined();
    // The priced round is still recoverable from the roster.
    expect(response.details.model.perRound?.[0]?.usage.estimatedCost?.total)
      .toBeCloseTo(ZZ_ROUND_ONE_RATE, 6);
    expect(response.details.model.perRound?.[1]?.usage.estimatedCost).toBeUndefined();
  });
});
