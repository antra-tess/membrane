/**
 * Google publishes some Gemini rates together with the date they change:
 * gemini-4-argon at 2/10 "through November 30, 2026" and 4/20 "starting
 * December 1, 2026", the 3.6 and 3.8 Flash models at 0.75/3.75 through
 * December 31 and 1.50/7.50 from January 1, 2027. Some Gemini ids that a text
 * model's row matches by prefix are image or speech models, whose output a
 * text rate underprices.
 *
 * Every rate below is from https://ai.google.dev/gemini-api/docs/pricing
 * (Standard, paid tier).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { resetUnpricedModelWarnings } from '../../src/utils/cost.js';
import {
  getDefaultPricing,
  PRICING_TABLE,
  GOOGLE_PRICING_LAST_VERIFIED,
} from '../../src/registry/default-pricing.js';
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

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetUnpricedModelWarnings();
});

// Google names no time zone; the table takes Pacific midnight, UTC-8 on both dates.
const BEFORE_DEC_1 = Date.parse('2026-12-01T07:59:59.999Z');
const FROM_DEC_1 = Date.parse('2026-12-01T08:00:00.000Z');
const BEFORE_JAN_1 = Date.parse('2027-01-01T07:59:59.999Z');
const FROM_JAN_1 = Date.parse('2027-01-01T08:00:00.000Z');

const rates = (pricing: ReturnType<typeof getDefaultPricing>) => (
  pricing && [pricing.inputPerMillion, pricing.outputPerMillion, pricing.cacheReadPerMillion]
);

describe('every row of the table', () => {
  it('has a prefix no other row has', () => {
    const prefixes = PRICING_TABLE.map((row) => row.prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it('lists its changes as instants, in ascending order, each after its row was read', () => {
    const dated = PRICING_TABLE.flatMap((row) => (
      row.pricing !== null && row.changes?.length ? [{ prefix: row.prefix, pricing: row.pricing, changes: row.changes }] : []
    ));
    expect(dated.map((row) => row.prefix)).toEqual(expect.arrayContaining(['gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.6-flash']));
    for (const row of dated) {
      const read = row.pricing.asOf ?? '';
      expect(read, `${row.prefix}: a dated row says when it was read`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      let previous = Date.parse(read);
      for (const change of row.changes) {
        // With an offset or Z, Date parses the same instant in any host time zone.
        expect(change.from, row.prefix).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/);
        const from = Date.parse(change.from);
        expect(from, `${row.prefix}: ${change.from} comes after what precedes it`).toBeGreaterThan(previous);
        expect(change.pricing.currency, row.prefix).toBe(row.pricing.currency);
        expect((change.pricing.asOf ?? '') >= read, `${row.prefix}: ${change.from} was read on ${change.pricing.asOf}`).toBe(true);
        previous = from;
      }
    }
  });

  it("gives an id under a row with no price no price, not a shorter row's", () => {
    const unpricedRows = PRICING_TABLE.filter((row) => row.pricing === null);
    expect(unpricedRows.length).toBeGreaterThan(0);
    for (const row of unpricedRows) {
      expect(getDefaultPricing(`${row.prefix}-zz-variant`), row.prefix).toBeUndefined();
    }
  });
});

describe("Google's dated rates", () => {
  it('prices gemini-4-argon at its introductory rate through November 30, and double from December 1', () => {
    expect(rates(getDefaultPricing('gemini-4-argon', BEFORE_DEC_1))).toEqual([2, 10, 0.10]);
    expect(rates(getDefaultPricing('gemini-4-argon', FROM_DEC_1))).toEqual([4, 20, 0.20]);
  });

  it('prices gemini-3.8-flash and gemini-3.6-flash at theirs through December 31, and double from January 1', () => {
    for (const model of ['gemini-3.8-flash', 'gemini-3.6-flash']) {
      expect(rates(getDefaultPricing(model, BEFORE_JAN_1)), model).toEqual([0.75, 3.75, 0.075]);
      expect(rates(getDefaultPricing(model, FROM_JAN_1)), model).toEqual([1.50, 7.50, 0.15]);
    }
  });

  it('keeps the date the rates were read as asOf, on both sides of a change', () => {
    expect(GOOGLE_PRICING_LAST_VERIFIED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const cases: Array<[string, number]> = [
      ['gemini-4-argon', BEFORE_DEC_1], ['gemini-4-argon', FROM_DEC_1],
      ['gemini-3.8-flash', BEFORE_JAN_1], ['gemini-3.8-flash', FROM_JAN_1],
      ['gemini-3.6-flash', BEFORE_JAN_1], ['gemini-3.6-flash', FROM_JAN_1],
    ];
    for (const [model, at] of cases) expect(getDefaultPricing(model, at)?.asOf, `${model} at ${at}`).toBe(GOOGLE_PRICING_LAST_VERIFIED);
  });

  it("prices at membrane's clock, Date.now, when no instant is given", () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(BEFORE_DEC_1);
    expect(getDefaultPricing('gemini-4-argon')?.inputPerMillion).toBe(2);
    now.mockReturnValue(FROM_DEC_1);
    expect(getDefaultPricing('gemini-4-argon')?.inputPerMillion).toBe(4);
  });

  it('prices each routed model at the rate of the model Google routes it to', () => {
    // Google's deprecations table: requests for gemini-3.7-flash go to
    // gemini-3.8-flash, and requests for gemini-3.5-flash to gemini-3.6-flash.
    for (const at of [BEFORE_JAN_1, FROM_JAN_1]) {
      expect(getDefaultPricing('gemini-3.7-flash', at)).toEqual(getDefaultPricing('gemini-3.8-flash', at));
      expect(getDefaultPricing('gemini-3.5-flash', at)).toEqual(getDefaultPricing('gemini-3.6-flash', at));
    }
  });

  it('prices the Gemini models that had no row', () => {
    expect(rates(getDefaultPricing('gemini-3.1-pro-preview'))).toEqual([2, 12, 0.20]);
    expect(rates(getDefaultPricing('gemini-3.1-pro-preview-customtools'))).toEqual([2, 12, 0.20]);
    expect(rates(getDefaultPricing('gemini-3.1-flash-lite'))).toEqual([0.25, 1.50, 0.025]);
    expect(rates(getDefaultPricing('gemini-3-flash-preview'))).toEqual([0.50, 3, 0.05]);
  });

  it("keeps gemini-3.5-flash-lite out of the routed gemini-3.5-flash row", () => {
    expect(rates(getDefaultPricing('gemini-3.5-flash-lite'))).toEqual([0.30, 2.50, 0.03]);
  });
});

describe('image, speech and audio models', () => {
  const unpriced = [
    'gemini-3.8-flash-tts',
    'gemini-3.8-flash-lite-tts',
    'gemini-3.1-flash-lite-image',
    'gemini-2.5-flash-image',
    'gemini-2.5-flash-preview-tts',
    'gemini-2.5-flash-native-audio-preview-12-2025',
    'gemini-2.5-pro-preview-tts',
    'gemini-3.1-flash-image',
    'gemini-3-pro-image',
  ];

  it('read as unpriced', () => {
    for (const model of unpriced) expect(getDefaultPricing(model), model).toBeUndefined();
  });

  it('leave the text rows they stand in front of priced', () => {
    for (const model of ['gemini-3.8-flash', 'gemini-3.1-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-pro']) {
      expect(getDefaultPricing(model)?.inputPerMillion, model).toBeGreaterThan(0);
    }
  });
});

const ZZ_USAGE = { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 500_000 };
const ARGON_INTRO_TOTAL = 2 + 1 + 0.05;
const ARGON_LATER_TOTAL = 4 + 2 + 0.10;
const FLASH_INTRO_TOTAL = 0.75 + 0.375 + 0.0375;
const FLASH_LATER_TOTAL = 1.50 + 0.75 + 0.075;

const zzTool: ToolDefinition = {
  name: 'zz-noop',
  description: 'Forces a second round.',
  inputSchema: { type: 'object', properties: {} },
};

const ZZ_XML_CALL = 'zz-prose\n<function_calls><invoke name="zz-noop">'
  + '<parameter name="p">1</parameter></invoke></function_calls>';

function zzAdapter(options: { served?: string; rounds?: number[]; mode?: 'xml' | 'native' } = {}): ProviderAdapter {
  let round = 0;
  const mode = options.mode ?? 'native';
  const respond = (n: number, request: ProviderRequest): ProviderResponse => {
    const rounds = options.rounds;
    if (rounds) vi.setSystemTime(rounds[Math.min(n, rounds.length - 1)]!);
    const asksForTool = rounds !== undefined && n === 0;
    return {
      content: asksForTool && mode === 'native'
        ? [{ type: 'tool_use', id: 'zz-call-1', name: 'zz-noop', input: {} }]
        : [{ type: 'text', text: asksForTool ? ZZ_XML_CALL : 'zz-reply' }],
      stopReason: asksForTool && mode === 'native' ? 'tool_use' : 'end_turn',
      usage: { ...ZZ_USAGE },
      model: options.served ?? request.model,
      rawRequest: request,
      raw: {},
    } as ProviderResponse;
  };
  return {
    name: 'zz-adapter',
    usageCacheConvention: 'cache-excluded',
    supportsModel: () => true,
    async complete(request: ProviderRequest) { return respond(round++, request); },
    async stream(request: ProviderRequest, callbacks: StreamCallbacks) {
      const n = round++;
      const asksForTool = options.rounds !== undefined && n === 0;
      if (!asksForTool) callbacks.onChunk('zz-reply');
      else if (mode === 'xml') callbacks.onChunk(ZZ_XML_CALL);
      return respond(n, request);
    },
  };
}

const zzRequest = (model: string, toolMode?: 'xml' | 'native') => ({
  config: { model, maxTokens: 64 },
  messages: [{ role: 'user', content: [{ type: 'text', text: 'zz-prompt' }] }],
  ...(toolMode ? { tools: [zzTool], toolMode } : {}),
} as unknown as NormalizedRequest);

const zzResults = (calls: Array<{ id: string }>): ToolResult[] =>
  calls.map((c) => ({ toolUseId: c.id, content: 'zz-result', isError: false }));

const paths: Array<[string, (membrane: Membrane, request: NormalizedRequest) => Promise<NormalizedResponse>]> = [
  ['complete()', (membrane, request) => membrane.complete(request)],
  ['stream()', async (membrane, request) => await membrane.stream(request) as NormalizedResponse],
];

async function driveTurn(membrane: Membrane, request: NormalizedRequest, yielding: boolean): Promise<NormalizedResponse> {
  if (!yielding) {
    return await membrane.stream(request, { onToolCalls: async (calls) => zzResults(calls) }) as NormalizedResponse;
  }
  const stream = membrane.streamYielding(request, {});
  for await (const event of stream) {
    if (event.type === 'tool-calls') stream.provideToolResults(zzResults(event.calls));
    else if (event.type === 'complete') return event.response as NormalizedResponse;
    else if (event.type === 'aborted' || event.type === 'error') break;
  }
  throw new Error('zz-drive: no complete event');
}

describe('through Membrane, on each side of each change', () => {
  for (const [label, call] of paths) {
    it(`prices gemini-4-argon at the rate in force on ${label}`, async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const membrane = new Membrane(zzAdapter());

      vi.setSystemTime(BEFORE_DEC_1);
      const before = await call(membrane, zzRequest('gemini-4-argon'));
      vi.setSystemTime(FROM_DEC_1);
      const after = await call(membrane, zzRequest('gemini-4-argon'));

      expect(before.details.usage.estimatedCost?.total).toBeCloseTo(ARGON_INTRO_TOTAL, 9);
      expect(before.details.usage.estimatedCost?.cacheRead).toBeCloseTo(0.05, 9);
      expect(after.details.usage.estimatedCost?.total).toBeCloseTo(ARGON_LATER_TOTAL, 9);
      expect(after.details.usage.estimatedCost?.cacheRead).toBeCloseTo(0.10, 9);
      expect(after.details.usage.estimatedCost?.pricingAsOf).toBe(GOOGLE_PRICING_LAST_VERIFIED);
    });

    it(`prices gemini-3.8-flash at the rate in force on ${label}`, async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const membrane = new Membrane(zzAdapter());

      vi.setSystemTime(BEFORE_JAN_1);
      const before = await call(membrane, zzRequest('gemini-3.8-flash'));
      vi.setSystemTime(FROM_JAN_1);
      const after = await call(membrane, zzRequest('gemini-3.8-flash'));

      expect(before.details.usage.estimatedCost?.total).toBeCloseTo(FLASH_INTRO_TOTAL, 9);
      expect(after.details.usage.estimatedCost?.total).toBeCloseTo(FLASH_LATER_TOTAL, 9);
    });

    it(`prices a routed gemini-3.5-flash request the same whichever id the response names, on ${label}`, async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(BEFORE_JAN_1);
      const namesTarget = await call(new Membrane(zzAdapter({ served: 'gemini-3.6-flash' })), zzRequest('gemini-3.5-flash'));
      const namesItself = await call(new Membrane(zzAdapter({ served: 'gemini-3.5-flash' })), zzRequest('gemini-3.5-flash'));

      expect(namesTarget.details.usage.estimatedCost?.total).toBeCloseTo(FLASH_INTRO_TOTAL, 9);
      expect(namesItself.details.usage.estimatedCost?.total).toBeCloseTo(FLASH_INTRO_TOTAL, 9);
    });

    it(`omits the cost of an image model a text row used to price, and says so once, on ${label}`, async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => { });
      const response = await call(new Membrane(zzAdapter()), zzRequest('gemini-2.5-flash-image'));

      expect(response.details.usage.estimatedCost).toBeUndefined();
      expect(warn.mock.calls.filter((args) => String(args[0]).includes('gemini-2.5-flash-image'))).toHaveLength(1);
    });

    it(`lets a caller's ModelRegistry price an image model the table leaves unpriced, on ${label}`, async () => {
      const registry = {
        getPricing: (modelId: string) => (modelId === 'gemini-2.5-flash-image'
          ? { inputPerMillion: 0.30, outputPerMillion: 30, currency: 'USD' }
          : undefined),
        getCapabilities: () => undefined,
        getQuirks: () => undefined,
        getModel: () => undefined,
        resolveModel: (id: string) => id,
        listModels: () => [],
      };
      const response = await call(new Membrane(zzAdapter(), { registry }), zzRequest('gemini-2.5-flash-image'));

      expect(response.details.usage.estimatedCost?.total).toBeCloseTo(3.30, 9);
    });
  }

  const loops: Array<[string, 'xml' | 'native', boolean]> = [
    ['stream() with native tools', 'native', false],
    ['stream() with XML tools', 'xml', false],
    ['streamYielding() with native tools', 'native', true],
    ['streamYielding() with XML tools', 'xml', true],
  ];
  for (const [label, mode, yielding] of loops) {
    it(`prices each round of a turn that crosses December 1 at the rate of its own end, on ${label}`, async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const membrane = new Membrane(zzAdapter({ rounds: [BEFORE_DEC_1, FROM_DEC_1], mode }));
      const response = await driveTurn(membrane, zzRequest('gemini-4-argon', mode), yielding);

      const perRound = response.details.model.perRound;
      expect(perRound).toHaveLength(2);
      expect(perRound?.[0]?.usage.estimatedCost?.total).toBeCloseTo(ARGON_INTRO_TOTAL, 9);
      expect(perRound?.[1]?.usage.estimatedCost?.total).toBeCloseTo(ARGON_LATER_TOTAL, 9);
      expect(response.details.usage.estimatedCost?.total).toBeCloseTo(ARGON_INTRO_TOTAL + ARGON_LATER_TOTAL, 9);
    });
  }
});
