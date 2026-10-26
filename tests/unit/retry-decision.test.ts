import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MEMBRANE_RETRY_SETTINGS,
  classifyFailure,
  delayFor,
  membraneRetrySettings,
  retryDecision,
  type RetrySettings,
} from '../../src/retry.js';
import { DEFAULT_RETRY_CONFIG, type RetryConfig } from '../../src/types/config.js';
import { isOverloadedError, MembraneError } from '../../src/types/errors.js';
import { Membrane } from '../../src/membrane.js';
import { MockAdapter } from '../../src/providers/mock.js';
import type { NormalizedRequest } from '../../src/types/index.js';
import type { ProviderRequest, ProviderRequestOptions, ProviderResponse } from '../../src/types/provider.js';
import type { StreamCallbacks } from '../../src/types/streaming.js';

const config = (change: Partial<Omit<RetryConfig, 'overloaded'>> & { overloaded?: Partial<RetryConfig['overloaded']> } = {}): RetryConfig => ({
  ...DEFAULT_RETRY_CONFIG,
  ...change,
  overloaded: { ...DEFAULT_RETRY_CONFIG.overloaded, ...change.overloaded },
});
const settings = MEMBRANE_RETRY_SETTINGS;
const NON_FINITE_STEPS = [
  { firstDelayMs: Number.NaN }, { multiplier: Number.NaN }, { maxDelayMs: Number.NaN },
  { firstDelayMs: Infinity, maxDelayMs: Infinity }, { multiplier: 1e308, maxDelayMs: Infinity },
];
const ATTEMPT_WITHIN_DEFAULT_BOUND = 2;
const at = (value: number) => () => value;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('classifyFailure', () => {
  it('takes a deadline first, then a failure that is not retryable, then overloaded, a rate limit, and any other retryable failure', () => {
    expect(classifyFailure({ retryable: true, type: 'rate_limit', httpStatus: 429, deadline: true })).toBe('deadline');
    expect(classifyFailure({ retryable: false, type: 'server', httpStatus: 529, deadline: false })).toBe('final');
    expect(classifyFailure({ retryable: true, type: 'server', httpStatus: 529 })).toBe('overloaded');
    expect(classifyFailure({ retryable: true, type: 'rate_limit', httpStatus: 429 })).toBe('rate_limited');
    expect(classifyFailure({ retryable: true, type: 'server', httpStatus: 503 })).toBe('retryable');
    expect(classifyFailure({ retryable: true, type: 'network' })).toBe('retryable');
  });

  it("reads an overloaded error's status when it has one, and its message only when it has none", () => {
    // Mid-stream, after the 200, an overloaded error has no status.
    expect(classifyFailure({ retryable: true, type: 'server', message: 'stream error: overloaded_error' })).toBe('overloaded');
    expect(classifyFailure({ retryable: true, type: 'server', message: 'upstream said 529' })).toBe('overloaded');
    expect(classifyFailure({ retryable: true, type: 'server', httpStatus: 503, message: 'overloaded_error' })).toBe('retryable');
    expect(classifyFailure({ retryable: true, type: 'server', message: 'worker pool overloaded' })).toBe('retryable');
    expect(classifyFailure({ retryable: true, type: 'server', message: 'timeout after 5290 ms' })).toBe('retryable');
    expect(classifyFailure({ retryable: true, type: 'server', message: 'request 1529 failed' })).toBe('retryable');
    expect(classifyFailure({ retryable: true, type: 'server', message: 'OVERLOADED_ERROR' })).toBe('overloaded');
  });

  it('takes a deadline first whatever else is said of the failure', () => {
    expect(classifyFailure({ retryable: false, type: 'server', httpStatus: 400, deadline: true })).toBe('deadline');
    expect(classifyFailure({ retryable: true, type: 'server', httpStatus: 529, deadline: true })).toBe('deadline');
  });

  it('puts a failure in one class: an overloaded error typed rate_limit is overloaded', () => {
    expect(classifyFailure({ retryable: true, type: 'rate_limit', message: 'rate_limit overloaded_error' })).toBe('overloaded');
    expect(classifyFailure({ retryable: true, type: 'rate_limit', httpStatus: 529 })).toBe('overloaded');
  });

  it('is the rule isOverloadedError keeps', () => {
    const error = (facts: { httpStatus?: number; message: string; retryable?: boolean }) =>
      isOverloadedError({ type: 'server', retryable: true, ...facts });
    expect(error({ httpStatus: 529, message: 'x' })).toBe(true);
    expect(error({ httpStatus: 503, message: 'overloaded_error' })).toBe(false);
    expect(error({ message: 'overloaded_error' })).toBe(true);
    expect(error({ message: 'fine' })).toBe(false);
    expect(error({ httpStatus: 529, message: 'x', retryable: false })).toBe(false);
  });
});

describe('membraneRetrySettings', () => {
  it("gives membrane's default config its three schedules, each with its stated-wait ceiling", () => {
    expect(settings).toEqual({
      retryable: { maxAttempts: 3, firstDelayMs: 1000, multiplier: 2, maxDelayMs: 30_000, statedWaitCeilingMs: 60_000 },
      rate_limited: { maxAttempts: 5, firstDelayMs: 1000, multiplier: 2, maxDelayMs: 30_000, statedWaitCeilingMs: 60_000 },
      overloaded: { maxAttempts: 7, firstDelayMs: 10_000, multiplier: 2, maxDelayMs: 300_000, statedWaitCeilingMs: 300_000 },
    });
    expect(settings.deadline).toBeUndefined();
    expect(settings.final).toBeUndefined();
  });

  it("freezes membrane's default settings and each schedule, which every importer shares", () => {
    expect(Object.isFrozen(settings)).toBe(true);
    for (const schedule of Object.values(settings)) expect(Object.isFrozen(schedule)).toBe(true);
    expect(() => { (settings.retryable as { maxAttempts: number | null }).maxAttempts = 99; }).toThrow(TypeError);
  });

  it('gives a rate limit at least five attempts and overloaded the larger count, on their own delays', () => {
    const many = membraneRetrySettings(config({ maxRetries: 9 }));
    expect([many.retryable!.maxAttempts, many.rate_limited!.maxAttempts, many.overloaded!.maxAttempts]).toEqual([9, 9, 9]);
    const none = membraneRetrySettings(config({ maxRetries: 0 }));
    expect([none.retryable!.maxAttempts, none.rate_limited!.maxAttempts, none.overloaded!.maxAttempts]).toEqual([0, 5, 7]);
  });

  it('gives overloaded no schedule when overloaded.maxRetries is 0', () => {
    expect(membraneRetrySettings(config({ overloaded: { maxRetries: 0 } })).overloaded).toBeUndefined();
  });

  it("maps every field of a config's two schedules", () => {
    expect(membraneRetrySettings(config({
      maxRetries: 4, retryDelayMs: 20, backoffMultiplier: 3, maxRetryDelayMs: 900,
      overloaded: { maxRetries: 6, retryDelayMs: 30, backoffMultiplier: 5, maxRetryDelayMs: 7000 },
    }))).toEqual({
      retryable: { maxAttempts: 4, firstDelayMs: 20, multiplier: 3, maxDelayMs: 900, statedWaitCeilingMs: 60_000 },
      rate_limited: { maxAttempts: 5, firstDelayMs: 20, multiplier: 3, maxDelayMs: 900, statedWaitCeilingMs: 60_000 },
      overloaded: { maxAttempts: 6, firstDelayMs: 30, multiplier: 5, maxDelayMs: 7000, statedWaitCeilingMs: 60_000 },
    });
  });

  it("puts each schedule's ceiling at a minute, or its maxDelayMs where that's longer", () => {
    const long = membraneRetrySettings(config({ maxRetryDelayMs: 90_000, overloaded: { maxRetryDelayMs: 40 } }));
    expect(long.retryable!.statedWaitCeilingMs).toBe(90_000);
    expect(long.rate_limited!.statedWaitCeilingMs).toBe(90_000);
    expect(long.overloaded!.statedWaitCeilingMs).toBe(60_000);
  });
});

describe('delayFor', () => {
  it('counts attempts as tries made so far: attempt 1 is the first retry, at firstDelayMs, then each step multiplies, up to maxDelayMs', () => {
    expect([1, 2, 3, 5, 6, 30].map((attempt) => delayFor('retryable', attempt, settings).delayMs))
      .toEqual([1000, 2000, 4000, 16_000, 30_000, 30_000]);
  });

  it("jitters the overloaded class's delay into its step's second half, and gives the un-jittered step as nominalMs", () => {
    expect(delayFor('overloaded', 1, settings, at(0))).toEqual({ delayMs: 5000, nominalMs: 10_000 });
    expect(delayFor('overloaded', 2, settings, at(0.5))).toEqual({ delayMs: 15_000, nominalMs: 20_000 });
    const top = delayFor('overloaded', 3, settings, at(0.999_999));
    expect(top.nominalMs).toBe(40_000);
    expect(top.delayMs).toBeGreaterThanOrEqual(39_999);
    expect(top.delayMs).toBeLessThan(40_000);
    expect(delayFor('overloaded', 9, settings, at(0)).nominalMs).toBe(300_000);
  });

  it('draws the jitter from Math.random when no random is given', () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(delayFor('overloaded', 1, settings).delayMs).toBe(5000);
    expect(retryDecision('overloaded', 1, undefined, settings)).toEqual({ retry: true, delayMs: 5000 });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('jitters no other class', () => {
    for (const cls of ['retryable', 'rate_limited'] as const) {
      expect(delayFor(cls, 2, settings, at(0))).toEqual({ delayMs: 2000, nominalMs: 2000 });
    }
  });

  it('keeps a zero first delay at zero when the multiplier overflows', () => {
    const zero: RetrySettings = { retryable: { maxAttempts: null, firstDelayMs: 0, multiplier: 1e308, maxDelayMs: 30_000, statedWaitCeilingMs: null } };
    expect(delayFor('retryable', 3, zero)).toEqual({ delayMs: 0, nominalMs: 0 });
  });

  it('takes the retryable schedule, with no jitter, for an overloaded failure whose settings have no overloaded schedule', () => {
    const noOverloaded = membraneRetrySettings(config({ overloaded: { maxRetries: 0 } }));
    expect(delayFor('overloaded', 2, noOverloaded, at(0))).toEqual({ delayMs: 2000, nominalMs: 2000 });
  });

  it('throws for an attempt that is not a whole count from 1', () => {
    for (const attempt of [Number.NaN, Infinity, 0, -1, 1.5]) {
      expect(() => delayFor('retryable', attempt, settings)).toThrow(RangeError);
      expect(() => delayFor('overloaded', attempt, settings)).toThrow(RangeError);
    }
  });

  it("throws for a schedule whose numbers give no finite step", () => {
    for (const change of NON_FINITE_STEPS) {
      const broken: RetrySettings = { retryable: { ...settings.retryable!, ...change } };
      expect(() => delayFor('retryable', ATTEMPT_WITHIN_DEFAULT_BOUND, broken)).toThrow(RangeError);
    }
  });

  it('throws for a class with no schedule', () => {
    expect(() => delayFor('final', 1, settings)).toThrow(RangeError);
    expect(() => delayFor('deadline', 1, settings)).toThrow(RangeError);
  });
});

describe('retryDecision', () => {
  it('retries while the attempts last, and not after', () => {
    expect(retryDecision('retryable', 2, undefined, settings)).toEqual({ retry: true, delayMs: 2000 });
    expect(retryDecision('retryable', 3, undefined, settings)).toEqual({ retry: false });
    expect(retryDecision('rate_limited', 4, undefined, settings)).toEqual({ retry: true, delayMs: 8000 });
    expect(retryDecision('rate_limited', 5, undefined, settings)).toEqual({ retry: false });
    expect(retryDecision('overloaded', 6, undefined, settings, at(0))).toEqual({ retry: true, delayMs: 150_000 });
    expect(retryDecision('overloaded', 7, undefined, settings, at(0))).toEqual({ retry: false });
  });

  it('ends the retries on an attempt that is not a whole count from 1, bound or none', () => {
    const unbounded: RetrySettings = { retryable: { ...settings.retryable!, maxAttempts: null } };
    for (const attempt of [Number.NaN, Infinity, 0, -1, 1.5]) {
      expect(retryDecision('retryable', attempt, undefined, unbounded)).toEqual({ retry: false });
      expect(retryDecision('retryable', attempt, undefined, settings)).toEqual({ retry: false });
    }
  });

  it("ends the retries on a wait that isn't a finite number, with a stated wait or none", () => {
    for (const change of NON_FINITE_STEPS) {
      const broken: RetrySettings = { retryable: { ...settings.retryable!, ...change } };
      expect(retryDecision('retryable', ATTEMPT_WITHIN_DEFAULT_BOUND, undefined, broken)).toEqual({ retry: false });
      expect(retryDecision('retryable', ATTEMPT_WITHIN_DEFAULT_BOUND, 500, broken)).toEqual({ retry: false });
    }
  });

  it('gives an Infinity stated wait back to the caller, whatever the ceiling, and lets -Infinity lose to the backoff', () => {
    const holds: RetrySettings = { retryable: { ...settings.retryable!, statedWaitCeilingMs: null } };
    expect(retryDecision('retryable', 1, Infinity, holds)).toEqual({ retry: false, statedWaitMs: Infinity });
    expect(retryDecision('retryable', 1, Infinity, settings)).toEqual({ retry: false, statedWaitMs: Infinity });
    expect(retryDecision('retryable', 1, -Infinity, holds)).toEqual({ retry: true, delayMs: 1000 });
  });

  it('ends the retries when maxAttempts is NaN', () => {
    const broken: RetrySettings = { retryable: { ...settings.retryable!, maxAttempts: Number.NaN } };
    expect(retryDecision('retryable', 1, undefined, broken)).toEqual({ retry: false });
  });

  it('never retries a class with no schedule', () => {
    expect(retryDecision('final', 1, undefined, settings)).toEqual({ retry: false });
    expect(retryDecision('deadline', 1, undefined, settings)).toEqual({ retry: false });
  });

  it('retries without a bound when maxAttempts is null', () => {
    const unbounded: RetrySettings = { overloaded: { ...settings.overloaded!, maxAttempts: null } };
    expect(retryDecision('overloaded', 1_000, undefined, unbounded, at(0))).toEqual({ retry: true, delayMs: 150_000 });
  });

  it('decides an overloaded failure as retryable when its settings have no overloaded schedule', () => {
    const noOverloaded = membraneRetrySettings(config({ overloaded: { maxRetries: 0 } }));
    expect(retryDecision('overloaded', 1, undefined, noOverloaded, at(0))).toEqual({ retry: true, delayMs: 1000 });
    expect(retryDecision('overloaded', 3, undefined, noOverloaded)).toEqual({ retry: false });
  });

  it('lets a stated wait only lengthen the backoff', () => {
    expect(retryDecision('retryable', 1, 5000, settings)).toEqual({ retry: true, delayMs: 5000 });
    expect(retryDecision('retryable', 1, 0, settings)).toEqual({ retry: true, delayMs: 1000 });
    expect(retryDecision('retryable', 1, -1000, settings)).toEqual({ retry: true, delayMs: 1000 });
    expect(retryDecision('retryable', 1, 60_000, settings)).toEqual({ retry: true, delayMs: 60_000 });
  });

  it('never shortens the backoff for a stated wait, even where maxDelayMs is past the ceiling', () => {
    const short: RetrySettings = { retryable: { maxAttempts: null, firstDelayMs: 1000, multiplier: 2, maxDelayMs: 30_000, statedWaitCeilingMs: 10_000 } };
    expect(retryDecision('retryable', 6, undefined, short)).toEqual({ retry: true, delayMs: 30_000 });
    expect(retryDecision('retryable', 6, 5000, short)).toEqual({ retry: true, delayMs: 30_000 });
    expect(retryDecision('retryable', 6, 10_001, short)).toEqual({ retry: false, statedWaitMs: 10_001 });
  });

  it('counts a NaN stated wait as none', () => {
    expect(retryDecision('retryable', 1, Number.NaN, settings)).toEqual({ retry: true, delayMs: 1000 });
  });

  it("reads a stated wait as a number: a numeric string counts as its number, and one that isn't a number as none", () => {
    const asStated = (value: string) => value as unknown as number;
    expect(retryDecision('retryable', 1, asStated('5000'), settings)).toEqual({ retry: true, delayMs: 5000 });
    expect(retryDecision('retryable', 1, asStated('90000'), settings)).toEqual({ retry: false, statedWaitMs: 90_000 });
    expect(retryDecision('retryable', 1, asStated('soon'), settings)).toEqual({ retry: true, delayMs: 1000 });
  });

  it("gives a stated wait past its schedule's ceiling back to the caller instead of retrying", () => {
    expect(retryDecision('retryable', 1, 60_001, settings)).toEqual({ retry: false, statedWaitMs: 60_001 });
    expect(retryDecision('overloaded', 1, 300_001, settings, at(0))).toEqual({ retry: false, statedWaitMs: 300_001 });
    expect(retryDecision('overloaded', 1, 300_000, settings, at(0))).toEqual({ retry: true, delayMs: 300_000 });
  });

  it('waits out any finite stated wait when the ceiling is null', () => {
    const holds: RetrySettings = { rate_limited: { ...settings.rate_limited!, statedWaitCeilingMs: null } };
    expect(retryDecision('rate_limited', 1, 3_600_000, holds)).toEqual({ retry: true, delayMs: 3_600_000 });
  });

  it('checks the attempts before the stated wait', () => {
    expect(retryDecision('retryable', 3, 90_000, settings)).toEqual({ retry: false });
  });

  it('lets a stated wait set the wait where the backoff is zero', () => {
    const zero: RetrySettings = { rate_limited: { maxAttempts: null, firstDelayMs: 0, multiplier: 1e308, maxDelayMs: 30_000, statedWaitCeilingMs: 60_000 } };
    expect(retryDecision('rate_limited', 3, 50, zero)).toEqual({ retry: true, delayMs: 50 });
  });
});

describe('the ./retry entry', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const specifiers = (source: string): string[] => [
    ...source.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^;]*?\bfrom\s*['"]([^'"]+)['"]/gm),
    ...source.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm),
    ...source.matchAll(/\bimport\s*\(\s*['"`]([^'"`]+)['"`]/g),
    ...source.matchAll(/\brequire\s*\(\s*['"`]([^'"`]+)['"`]/g),
  ].map((match) => match[1]!);
  const loaded = (): string[] => {
    const seen = new Set<string>();
    const walk = (file: string) => {
      const name = relative(root, file);
      if (seen.has(name)) return;
      seen.add(name);
      for (const spec of specifiers(readFileSync(file, 'utf8'))) {
        if (!spec.startsWith('.')) { seen.add(`package ${spec}`); continue; }
        const target = join(dirname(file), spec).replace(/\.js$/, '.ts');
        if (!existsSync(target)) { seen.add(`missing ${spec}`); continue; }
        walk(target);
      }
    };
    walk(join(root, 'src/retry.ts'));
    return [...seen].sort();
  };

  it('finds every literal form of run-time import', () => {
    expect(specifiers([
      "import { a } from './a.js';",
      'export { b } from "./b.js";',
      "export * from './c.js';",
      "import './d.js';",
      "const e = await import('./e.js');",
      "const f = require(\"./f.js\");",
      "import type { G } from './g.js';",
      "export type { H } from './h.js';",
    ].join('\n')).sort()).toEqual(['./a.js', './b.js', './c.js', './d.js', './e.js', './f.js']);
  });

  it("is exported, and loads nothing of membrane's but the default retry config, and no package", () => {
    const exports = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).exports;
    expect(exports['./retry']).toEqual({ bun: './src/retry.ts', types: './dist/retry.d.ts', import: './dist/retry.js' });
    expect(loaded()).toEqual(['src/retry.ts', 'src/types/config.ts']);
  });
});

describe("membrane's core asks onError after the retry's wait is decided", () => {
  class FailsOnce extends MockAdapter {
    private failed = { complete: false, stream: false };
    private fail(path: 'complete' | 'stream') {
      if (this.failed[path]) return;
      this.failed[path] = true;
      throw new MembraneError({ type: 'rate_limit', message: 'zz rate limit', retryable: true, retryAfterMs: 5, httpStatus: 429, rawError: undefined });
    }
    override async complete(request: ProviderRequest, options?: ProviderRequestOptions): Promise<ProviderResponse> {
      this.fail('complete');
      return super.complete(request, options);
    }
    override async stream(request: ProviderRequest, callbacks: StreamCallbacks, options?: ProviderRequestOptions): Promise<ProviderResponse> {
      this.fail('stream');
      return super.stream(request, callbacks, options);
    }
  }
  const request: NormalizedRequest = {
    messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz-prompt' }] }],
    config: { model: 'zz-model-1', maxTokens: 64 },
  };
  const lengthening = (adapter: FailsOnce) => {
    const seen: Array<number | undefined> = [];
    const membrane = new Membrane(adapter, {
      retry: { maxRetries: 2, retryDelayMs: 1 },
      hooks: { onError: (error) => { seen.push(error.retryAfterMs); error.retryAfterMs = 40; return 'retry'; } },
    });
    return { membrane, seen };
  };

  it('complete(): a change onError makes to the stated wait leaves the wait as decided', async () => {
    const adapter = new FailsOnce();
    adapter.queueResponse('zz-recovered');
    const { membrane, seen } = lengthening(adapter);
    const response = await membrane.complete(request);
    expect(seen).toEqual([5]);
    expect(response.details.timing.retryDelaysMs).toEqual([5]);
  });

  it('stream(): a change onError makes to the stated wait leaves the wait as decided', async () => {
    const adapter = new FailsOnce();
    adapter.queueResponse('zz-recovered');
    const { membrane, seen } = lengthening(adapter);
    const response = await membrane.stream(request, { onChunk: () => {} });
    expect(seen).toEqual([5]);
    expect(response.details.timing.retryDelaysMs).toEqual([5]);
  });
});

describe("membrane's core counts a rate_limit failure that is also overloaded by the overloaded class", () => {
  class AlwaysOverloadedRateLimit extends MockAdapter {
    sends = 0;
    override async complete(): Promise<ProviderResponse> {
      this.sends++;
      throw new MembraneError({ type: 'rate_limit', message: 'zz rate limit', retryable: true, httpStatus: 529, rawError: undefined });
    }
  }
  const request: NormalizedRequest = {
    messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz-prompt' }] }],
    config: { model: 'zz-model-1', maxTokens: 64 },
  };

  it("makes the overloaded count of tries, 7 by default, where 0.7.0 made the rate limit's 5", async () => {
    const adapter = new AlwaysOverloadedRateLimit();
    await expect(new Membrane(adapter, { retry: { retryDelayMs: 1, overloaded: { retryDelayMs: 1 } } }).complete(request)).rejects.toThrow();
    expect(adapter.sends).toBe(7);
  });

  it('makes the retryable count, maxRetries, when overloaded.maxRetries is 0', async () => {
    const adapter = new AlwaysOverloadedRateLimit();
    await expect(new Membrane(adapter, { retry: { retryDelayMs: 1, overloaded: { maxRetries: 0 } } }).complete(request)).rejects.toThrow();
    expect(adapter.sends).toBe(3);
  });
});
