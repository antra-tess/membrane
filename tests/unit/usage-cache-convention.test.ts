/**
 * Providers disagree about whether the prompt-token count INCLUDES the span
 * served from cache. Both conventions were measured live on 2026-08-25:
 *
 *   Anthropic (cache-excluded): a 4,650-token cached system prompt returned
 *     input_tokens 8 / cache_creation 4650 on the first call and
 *     input_tokens 8 / cache_read 4650 on the second — `input_tokens` never
 *     counts the cached span.
 *   OpenAI (cache-inclusive): the same shape on gpt-4o-mini returned
 *     prompt_tokens 1732 / cached 0, then prompt_tokens 1732 / cached 1664 —
 *     `prompt_tokens` is CONSTANT across a cache hit, so cached ⊆ prompt.
 *
 * `inputTokens` therefore carried two incomparable meanings, which broke two
 * things: the cache "hit ratio" was unbounded under the Anthropic convention
 * (cacheRead/inputTokens = 400, not a ratio), and cost arithmetic priced the
 * cached span twice under the OpenAI convention (full rate on the whole
 * prompt PLUS the discounted rate on the cached subset).
 *
 * Membrane now normalizes every adapter onto ONE convention — cache-excluded,
 * where inputTokens/cacheReadTokens/cacheCreationTokens are disjoint and each
 * is priced at its own rate.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { OpenRouterAdapter } from '../../src/providers/openrouter.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { resetUndeclaredConventionWarnings } from '../../src/utils/usage.js';
import { sseResponse } from '../helpers/sse-fixtures.js';
import type {
  ProviderAdapter,
  ProviderRequest,
  ProviderResponse,
  StreamCallbacks,
  UsageCacheConvention,
  NormalizedRequest,
  NormalizedResponse,
} from '../../src/types/index.js';

// Every rate differs, so a cost assertion can tell which rate priced a count.
const ZZ_PRICING = {
  inputPerMillion: 1000,
  outputPerMillion: 1000,
  cacheWritePerMillion: 1250,
  cacheReadPerMillion: 100,
  currency: 'USD',
};

/** A registry stub so the cost assertions do not depend on the default table. */
const zzRegistry = {
  getPricing: () => ZZ_PRICING,
  getCapabilities: () => undefined,
  getQuirks: () => undefined,
  getModel: () => undefined,
  resolveAlias: (id: string) => id,
  listModels: () => [],
} as any;

function adapterReporting(
  usage: ProviderResponse['usage'],
  usageCacheConvention?: UsageCacheConvention,
): ProviderAdapter {
  return {
    name: 'zz-adapter',
    ...(usageCacheConvention ? { usageCacheConvention } : {}),
    supportsModel: () => true,
    async complete(request: ProviderRequest): Promise<ProviderResponse> {
      return {
        content: [{ type: 'text', text: 'zz-reply' }],
        stopReason: 'end_turn',
        usage,
        model: 'zz-model-1',
        rawRequest: request,
        raw: {},
      } as ProviderResponse;
    },
    async stream(request: ProviderRequest, callbacks: StreamCallbacks): Promise<ProviderResponse> {
      callbacks.onChunk('zz-reply');
      return {
        content: [{ type: 'text', text: 'zz-reply' }],
        stopReason: 'end_turn',
        usage,
        model: 'zz-model-1',
        rawRequest: request,
        raw: {},
      } as ProviderResponse;
    },
  };
}

const ZZ_REQUEST: NormalizedRequest = {
  config: { model: 'zz-model-1', maxTokens: 64 },
  messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz-prompt' }] }],
};

async function yielded(membrane: Membrane, request: NormalizedRequest): Promise<NormalizedResponse> {
  for await (const event of membrane.streamYielding(request)) {
    if (event.type === 'complete') return event.response as NormalizedResponse;
    if (event.type === 'error') throw event.error;
    if (event.type === 'aborted') break;
  }
  throw new Error('zz-yield: no complete event');
}

type Door = [string, (membrane: Membrane, request: NormalizedRequest) => Promise<NormalizedResponse>];

/** Each way a turn leaves membrane, by the tool loop each one runs. */
const DOORS: Door[] = [
  ['complete()', (membrane, request) => membrane.complete(request)],
  ['stream() in native tool mode',
    async (membrane, request) => await membrane.stream({ ...request, toolMode: 'native' }) as NormalizedResponse],
  ['stream() in XML tool mode',
    async (membrane, request) => await membrane.stream({ ...request, toolMode: 'xml' }) as NormalizedResponse],
  ['streamYielding() in native tool mode', (membrane, request) => yielded(membrane, { ...request, toolMode: 'native' })],
  ['streamYielding() in XML tool mode', (membrane, request) => yielded(membrane, { ...request, toolMode: 'xml' })],
];

// The undeclared-convention warning latches per adapter NAME, process-wide,
// and these cases all use the same one.
beforeEach(() => { resetUndeclaredConventionWarnings(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('cache-excluded adapters (Anthropic convention)', () => {
  it('reports a hit ratio bounded by 1', async () => {
    const membrane = new Membrane(
      adapterReporting({ inputTokens: 120, outputTokens: 40, cacheReadTokens: 48_000 }, 'cache-excluded'),
      { registry: zzRegistry },
    );
    const response = await membrane.complete(ZZ_REQUEST);

    // 48000 / (48000 + 120) — was 48000/120 = 400 before normalization.
    expect(response.details.cache.hitRatio).toBeCloseTo(48_000 / 48_120, 10);
    expect(response.details.cache.hitRatio).toBeLessThanOrEqual(1);
  });

  it('leaves the disjoint token counts untouched', async () => {
    const membrane = new Membrane(
      adapterReporting({ inputTokens: 120, outputTokens: 40, cacheReadTokens: 48_000 }, 'cache-excluded'),
      { registry: zzRegistry },
    );
    const response = await membrane.complete(ZZ_REQUEST);

    expect(response.usage.inputTokens).toBe(120);
    expect(response.usage.cacheReadTokens).toBe(48_000);
    // 120 fresh at 1000/M + 48000 cached at 100/M.
    expect(response.details.usage.estimatedCost?.input).toBeCloseTo(120 * 1000 / 1e6, 12);
    expect(response.details.usage.estimatedCost?.cacheRead).toBeCloseTo(48_000 * 100 / 1e6, 12);
  });

  it.each(DOORS)('counts cache writes as part of the prompt in the hit ratio, through %s', async (_door, call) => {
    // 100 fresh + 5,000 written + 5,000 read is a 10,100-token prompt, half
    // of it served from cache. Leaving the writes out of the prompt made it
    // 5,100 tokens and the ratio 98%.
    const membrane = new Membrane(
      adapterReporting(
        { inputTokens: 100, outputTokens: 40, cacheCreationTokens: 5_000, cacheReadTokens: 5_000 },
        'cache-excluded',
      ),
      { registry: zzRegistry },
    );
    const response = await call(membrane, ZZ_REQUEST);

    expect(response.details.cache.hitRatio).toBeCloseTo(5_000 / 10_100, 10);
    expect(response.usage.inputTokens).toBe(100);
    expect(response.usage.cacheCreationTokens).toBe(5_000);
  });
});

describe('cache-inclusive adapters (OpenAI convention)', () => {
  it('subtracts the cached span from inputTokens so downstream sees one convention', async () => {
    const membrane = new Membrane(
      adapterReporting({ inputTokens: 1732, outputTokens: 2, cacheReadTokens: 1664 }, 'cache-inclusive'),
      { registry: zzRegistry },
    );
    const response = await membrane.complete(ZZ_REQUEST);

    expect(response.usage.inputTokens).toBe(68);
    expect(response.usage.cacheReadTokens).toBe(1664);
  });

  it('stops double-counting the cached span in cost', async () => {
    const membrane = new Membrane(
      adapterReporting({ inputTokens: 1732, outputTokens: 2, cacheReadTokens: 1664 }, 'cache-inclusive'),
      { registry: zzRegistry },
    );
    const response = await membrane.complete(ZZ_REQUEST);

    // Fresh input is prompt - cached = 68, not the full 1732.
    expect(response.details.usage.estimatedCost?.input).toBeCloseTo(68 * 1000 / 1e6, 12);
    expect(response.details.usage.estimatedCost?.cacheRead).toBeCloseTo(1664 * 100 / 1e6, 12);
  });

  it.each(DOORS)('subtracts cache writes too, since an inclusive input count holds every cached token, through %s', async (_door, call) => {
    // No built-in inclusive adapter reports writes. One that did would count
    // them inside its input, as it counts its reads: a 10,000-token prompt
    // with 1,000 written and 2,000 read has 7,000 fresh.
    const membrane = new Membrane(
      adapterReporting(
        { inputTokens: 10_000, outputTokens: 2, cacheCreationTokens: 1_000, cacheReadTokens: 2_000 },
        'cache-inclusive',
      ),
      { registry: zzRegistry },
    );
    const response = await call(membrane, ZZ_REQUEST);

    expect(response.usage.inputTokens).toBe(7_000);
    expect(response.usage.cacheCreationTokens).toBe(1_000);
    expect(response.usage.cacheReadTokens).toBe(2_000);
    // Each part priced once at its own rate.
    expect(response.details.usage.estimatedCost?.input).toBeCloseTo(7_000 * 1000 / 1e6, 12);
    expect(response.details.usage.estimatedCost?.cacheWrite).toBeCloseTo(1_000 * 1250 / 1e6, 12);
    expect(response.details.usage.estimatedCost?.cacheRead).toBeCloseTo(2_000 * 100 / 1e6, 12);
    expect(response.details.cache.hitRatio).toBeCloseTo(2_000 / 10_000, 10);
  });

  it('subtracts the writes of a response that reports no reads', async () => {
    const membrane = new Membrane(
      adapterReporting({ inputTokens: 10_000, outputTokens: 2, cacheCreationTokens: 1_000 }, 'cache-inclusive'),
      { registry: zzRegistry },
    );
    const response = await membrane.complete(ZZ_REQUEST);

    expect(response.usage.inputTokens).toBe(9_000);
  });

  it('clamps the fresh input at zero when the cached counts exceed the input count', async () => {
    // A count that can't be right: an adapter declaring itself inclusive
    // while reporting its cached span outside the input count.
    const membrane = new Membrane(
      adapterReporting(
        { inputTokens: 1_000, outputTokens: 2, cacheCreationTokens: 600, cacheReadTokens: 600 },
        'cache-inclusive',
      ),
      { registry: zzRegistry },
    );
    const response = await membrane.complete(ZZ_REQUEST);

    expect(response.usage.inputTokens).toBe(0);
  });

  it('normalizes the streaming path too', async () => {
    const membrane = new Membrane(
      adapterReporting({ inputTokens: 1732, outputTokens: 2, cacheReadTokens: 1664 }, 'cache-inclusive'),
      { registry: zzRegistry },
    );
    const response = await membrane.stream(ZZ_REQUEST);

    expect(response.usage.inputTokens).toBe(68);
    expect(response.details.cache.hitRatio).toBeCloseTo(1664 / 1732, 10);
  });
});

describe('per-response convention override', () => {
  it('wins over the adapter default (OpenRouter routes to both conventions)', async () => {
    const membrane = new Membrane(
      adapterReporting(
        { inputTokens: 120, outputTokens: 40, cacheReadTokens: 48_000, cacheConvention: 'cache-excluded' },
        'cache-inclusive',
      ),
      { registry: zzRegistry },
    );
    const response = await membrane.complete(ZZ_REQUEST);

    expect(response.usage.inputTokens).toBe(120);
  });
});

describe('undeclared conventions', () => {
  it('passes the counts through and warns once when a cache read is present', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* silence */ });
    const membrane = new Membrane(
      adapterReporting({ inputTokens: 1732, outputTokens: 2, cacheReadTokens: 1664 }, 'unknown'),
      { registry: zzRegistry },
    );

    const first = await membrane.complete(ZZ_REQUEST);
    await membrane.complete(ZZ_REQUEST);

    expect(first.usage.inputTokens).toBe(1732);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('usageCacheConvention');
  });

  it('treats an adapter that declares NOTHING the same as one declaring "unknown"', async () => {
    // `usageCacheConvention` is optional on the interface so external custom
    // adapters keep compiling. Silence is not a licence to guess: an
    // undeclared adapter gets `unknown`'s exact behaviour — counts through
    // untouched, one warning when a cache read makes the ambiguity bite.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* silence */ });
    const membrane = new Membrane(
      adapterReporting({ inputTokens: 1732, outputTokens: 2, cacheReadTokens: 1664 }),
      { registry: zzRegistry },
    );

    const response = await membrane.complete(ZZ_REQUEST);

    expect(response.usage.inputTokens).toBe(1732);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('"unknown"');
  });

  it('warns once when an undeclared adapter reports cache writes alone', async () => {
    // Writes enter the total prompt and the hit ratio, so whether the input
    // count already holds them matters as much as it does for reads.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* silence */ });
    const membrane = new Membrane(
      adapterReporting({ inputTokens: 11_000, outputTokens: 2, cacheCreationTokens: 1_000 }, 'unknown'),
      { registry: zzRegistry },
    );

    const first = await membrane.complete(ZZ_REQUEST);
    await membrane.complete(ZZ_REQUEST);

    expect(first.usage.inputTokens).toBe(11_000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('1000 cache-write tokens');
  });

  it('stays silent when no cache read or write is reported', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* silence */ });
    const membrane = new Membrane(
      adapterReporting({ inputTokens: 1732, outputTokens: 2 }, 'unknown'),
      { registry: zzRegistry },
    );
    await membrane.complete(ZZ_REQUEST);

    expect(warn).not.toHaveBeenCalled();
  });
});

describe("OpenRouter's per-response convention, with cache writes", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  /** One OpenRouter reply carrying `usage`, as complete() or a stream receives it. */
  function openRouterReply(streamed: boolean, usage: Record<string, unknown>): Response {
    return streamed
      ? sseResponse([JSON.stringify({ choices: [{ delta: { content: 'zz-reply' }, finish_reason: 'stop' }], usage })])
      : new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'zz-reply' }, finish_reason: 'stop' }],
        usage,
      }));
  }

  // Anthropic's fields are disjoint from prompt_tokens and OpenAI's is inside
  // it, so an Anthropic-shaped field, read or write, marks the response
  // cache-excluded and keeps its writes out of the subtraction.
  const SHAPES: Array<[string, Record<string, unknown>, { input: number; written: number; read: number }]> = [
    ["Anthropic's write field and OpenAI's read field at zero",
      { prompt_tokens: 100, completion_tokens: 2, cache_creation_input_tokens: 5_000, prompt_tokens_details: { cached_tokens: 0 } },
      { input: 100, written: 5_000, read: 0 }],
    ["Anthropic's write field and OpenAI's read field above zero",
      { prompt_tokens: 1_000, completion_tokens: 2, cache_creation_input_tokens: 500, prompt_tokens_details: { cached_tokens: 300 } },
      { input: 1_000, written: 500, read: 300 }],
    ["Anthropic's write field alone",
      { prompt_tokens: 100, completion_tokens: 2, cache_creation_input_tokens: 5_000 },
      { input: 100, written: 5_000, read: 0 }],
    ["both of Anthropic's fields",
      { prompt_tokens: 100, completion_tokens: 2, cache_creation_input_tokens: 5_000, cache_read_input_tokens: 5_000 },
      { input: 100, written: 5_000, read: 5_000 }],
    ["OpenAI's read field alone, an inclusive count",
      { prompt_tokens: 1_732, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 1_664 } },
      { input: 68, written: 0, read: 1_664 }],
  ];

  for (const [door, call] of DOORS.filter(([label]) => !label.includes('XML'))) {
    it.each(SHAPES)(`restates a response reporting %s, through ${door}`, async (_shape, usage, expected) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* silence */ });
      vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => openRouterReply(door !== 'complete()', usage)));
      const membrane = new Membrane(new OpenRouterAdapter({ apiKey: 'zz-key' }), {
        registry: zzRegistry,
        formatter: new NativeFormatter(),
      });
      const response = await call(membrane, ZZ_REQUEST);

      expect(response.usage.inputTokens).toBe(expected.input);
      expect(response.usage.cacheCreationTokens ?? 0).toBe(expected.written);
      expect(response.usage.cacheReadTokens ?? 0).toBe(expected.read);
      const prompt = expected.input + expected.written + expected.read;
      expect(response.details.cache.hitRatio).toBeCloseTo(expected.read / prompt, 10);
      // Each shape resolves to a declared convention, so none warns about it.
      expect(warn.mock.calls.filter((args) => String(args[0]).includes('usageCacheConvention'))).toHaveLength(0);
    });
  }
});
