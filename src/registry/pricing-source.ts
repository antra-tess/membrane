import type { ModelPricing } from '../types/provider.js';

/**
 * The built-in pricing table checked against a source (#270).
 *
 * The table is typed by hand from the providers' pricing pages, and each row
 * has to be found and re-read when a provider changes a rate, adds a column
 * (the 1-hour cache write, the long-prompt tiers) or adds a model. OpenRouter's
 * public model list carries, for every model under the three providers the
 * table prices, every field the table has — base rates, cache reads and
 * writes, the 1-hour write, and `overrides` keyed by `min_prompt_tokens` for
 * the long-prompt tiers — in one shape. A snapshot of it is checked in
 * (`tests/fixtures/openrouter-models.json`, refreshed by
 * `scripts/pricing-source.mjs`), and a test compares each row to it, so a
 * divergence is a failing test with the two figures, not a page nobody
 * happened to re-read.
 *
 * OpenRouter is not the authority — the provider's own page is. The point is
 * that a difference becomes visible and a refresh mechanical: the snapshot is
 * a diff to review, not a number to transcribe.
 */

export interface SourceOverride {
  min_prompt_tokens: number;
  prompt?: string;
  completion?: string;
  input_cache_read?: string;
  input_cache_write?: string;
  input_cache_write_1h?: string;
}

export interface SourceModel {
  id: string;
  context_length: number | null;
  pricing: {
    prompt?: string;
    completion?: string;
    input_cache_read?: string;
    input_cache_write?: string;
    input_cache_write_1h?: string;
    overrides?: SourceOverride[];
  };
}

/** The long-prompt tier as #264 adds it to `ModelPricing`; named here so this
 *  module reads a table with or without that field. */
export interface LongTier {
  overTokens: number;
  inputPerMillion?: number;
  outputPerMillion?: number;
  cacheReadPerMillion?: number;
  cacheWritePerMillion?: number;
  cacheWrite1hPerMillion?: number;
}

export type TablePricing = ModelPricing & { longPrompt?: LongTier };

export type SourcePricing = Omit<ModelPricing, 'currency' | 'asOf'> & { longPrompt?: LongTier };

export interface SourceSnapshot {
  source: string;
  readAt: string;
  models: SourceModel[];
}

/**
 * The source's id for a table prefix: the provider from the prefix's first
 * word, and Anthropic's dotted version (`claude-haiku-5-5` → `claude-haiku-5.5`,
 * `claude-3-5-haiku` → `claude-3.5-haiku`). A prefix the rule doesn't cover
 * (a dated OpenAI id, a Google preview with a provider-side name) is `null`,
 * and the test reports it as unmapped rather than wrong.
 */
export function sourceIdFor(prefix: string): string | null {
  if (prefix.startsWith('claude-')) {
    const dotted = prefix.replace(/^claude-(\d)-(\d)-(\w+)$/, 'claude-$1.$2-$3').replace(/-(\d+)-(\d+)$/, '-$1.$2');
    return `anthropic/${dotted}`;
  }
  if (prefix.startsWith('gpt-')) return `openai/${prefix}`;
  if (prefix.startsWith('gemini-')) return `google/${prefix}`;
  return null;
}

/** A per-token rate string as dollars per million, rounded past float noise. */
export function perMillion(rate: string | undefined): number | undefined {
  if (rate === undefined) return undefined;
  const n = Number(rate);
  if (!Number.isFinite(n)) return undefined;
  return Math.round(n * 1_000_000 * 1_000_000) / 1_000_000;
}

/** What the table's row would read, taken from the source model. */
export function pricingFromSource(model: SourceModel): SourcePricing {
  const p = model.pricing;
  const out: SourcePricing = {
    inputPerMillion: perMillion(p.prompt) ?? 0,
    outputPerMillion: perMillion(p.completion) ?? 0,
  };
  const read = perMillion(p.input_cache_read);
  const write = perMillion(p.input_cache_write);
  const write1h = perMillion(p.input_cache_write_1h);
  if (read !== undefined) out.cacheReadPerMillion = read;
  if (write !== undefined) out.cacheWritePerMillion = write;
  if (write1h !== undefined) out.cacheWrite1hPerMillion = write1h;
  const tier = p.overrides?.find((o) => typeof o.min_prompt_tokens === 'number');
  if (tier) {
    const long: LongTier = { overTokens: tier.min_prompt_tokens };
    const li = perMillion(tier.prompt), lo = perMillion(tier.completion), lr = perMillion(tier.input_cache_read);
    const lw = perMillion(tier.input_cache_write), lw1 = perMillion(tier.input_cache_write_1h);
    if (li !== undefined) long.inputPerMillion = li;
    if (lo !== undefined) long.outputPerMillion = lo;
    if (lr !== undefined) long.cacheReadPerMillion = lr;
    if (lw !== undefined) long.cacheWritePerMillion = lw;
    if (lw1 !== undefined) long.cacheWrite1hPerMillion = lw1;
    out.longPrompt = long;
  }
  return out;
}

export interface PricingDifference {
  /** The field, dotted for the tier: `cacheReadPerMillion`, `longPrompt.inputPerMillion`. */
  field: string;
  table: number | undefined;
  source: number | undefined;
}

const RATE_FIELDS = ['inputPerMillion', 'outputPerMillion', 'cacheReadPerMillion', 'cacheWritePerMillion', 'cacheWrite1hPerMillion'] as const;

/** Every field on which a table row and the source's reading of the same model differ. */
export function comparePricing(table: TablePricing, source: SourcePricing): PricingDifference[] {
  const out: PricingDifference[] = [];
  for (const field of RATE_FIELDS) {
    if (!same(table[field], source[field])) out.push({ field, table: table[field], source: source[field] });
  }
  const t = table.longPrompt, s = source.longPrompt;
  if (!t && !s) return out;
  if (!same(t?.overTokens, s?.overTokens)) out.push({ field: 'longPrompt.overTokens', table: t?.overTokens, source: s?.overTokens });
  for (const field of RATE_FIELDS) {
    if (!same(t?.[field], s?.[field])) out.push({ field: `longPrompt.${field}`, table: t?.[field], source: s?.[field] });
  }
  return out;
}

function same(a: number | undefined, b: number | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * 1e-9;
}

/** The table id a source model would be looked up by: the provider dropped,
 *  Anthropic's dots back to dashes (`anthropic/claude-haiku-5.5` →
 *  `claude-haiku-5-5`). `null` for a variant the table never prices (`:batch`,
 *  `:free`) or a provider it doesn't carry. */
export function tableIdFor(sourceId: string): string | null {
  if (sourceId.includes(':')) return null;
  const slash = sourceId.indexOf('/');
  const provider = sourceId.slice(0, slash), name = sourceId.slice(slash + 1);
  if (provider === 'anthropic') return name.startsWith('claude-') ? name.replace(/\./g, '-') : null;
  if (provider === 'openai') return name.startsWith('gpt-') ? name : null;
  if (provider === 'google') return name.startsWith('gemini-') ? name : null;
  return null;
}

/** The table's prefix rule, as `getDefaultPricing` applies it: the longest
 *  prefix that names the id, where a prefix names an id when the id starts
 *  with it and the rest doesn't begin with a digit (so `gpt-5.4` names
 *  `gpt-5.4-pro` and `gpt-5.4-2026-03-05` but not `gpt-5.45`). */
export function matchingPrefix(prefixes: readonly string[], id: string): string | undefined {
  let best: string | undefined;
  for (const prefix of prefixes) {
    if (!id.startsWith(prefix)) continue;
    if (!(prefix.endsWith('-') || !/^\d/.test(id.slice(prefix.length)))) continue;
    if (best === undefined || prefix.length > best.length) best = prefix;
  }
  return best;
}
