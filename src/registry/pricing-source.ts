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
 * (`tests/fixtures/openrouter-models.json`, refreshed by hand with
 * `scripts/pricing-source.mjs`), and a test compares each row's rates in
 * effect on the snapshot's date to it, so a divergence is a failing test with
 * the two figures rather than a page nobody happened to re-read. The check is
 * as current as the snapshot: a provider's change after it is caught at the
 * next refresh, not before.
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

export interface SourceSnapshot {
  source: string;
  readAt: string;
  models: SourceModel[];
}

/** The long-prompt tier as #264 adds it to `ModelPricing` under this name;
 *  named here so this module reads a table with or without that field. */
export interface LongTier {
  overTokens: number;
  inputPerMillion?: number;
  outputPerMillion?: number;
  cacheReadPerMillion?: number;
  cacheWritePerMillion?: number;
  cacheWrite1hPerMillion?: number;
}

export type TablePricing = ModelPricing & { longPrompt?: LongTier };

/** The source's reading of a model in the table's terms. A base rate the
 *  source leaves out or can't be read as a number is `undefined` here — never
 *  0 — so a missing or malformed rate shows as a difference. A tier rate the
 *  override leaves out is the base rate, as the table's own tier rule has it
 *  (an unset tier rate keeps the row's base rate). */
export interface SourcePricing {
  inputPerMillion?: number;
  outputPerMillion?: number;
  cacheReadPerMillion?: number;
  cacheWritePerMillion?: number;
  cacheWrite1hPerMillion?: number;
  longPrompt?: LongTier;
  /** Overrides past the first: the table has one tier, so a second is reported, not read. */
  furtherTiers: number;
}

/**
 * The source's id for a table prefix: the provider from the prefix's first
 * word, and Anthropic's dotted version (`claude-haiku-5-5` →
 * `anthropic/claude-haiku-5.5`, `claude-3-5-haiku` → `anthropic/claude-3.5-haiku`).
 * Every prefix of the three providers gets an id; whether the source carries a
 * model under it is the snapshot's to say. `null` for a prefix of no provider
 * the source covers.
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

/** A per-token rate string as dollars per million, or undefined when it isn't a finite number. */
export function perMillion(rate: string | undefined): number | undefined {
  if (rate === undefined) return undefined;
  const n = Number(rate);
  if (!Number.isFinite(n)) return undefined;
  return n * 1_000_000;
}

const RATE_FIELDS = ['inputPerMillion', 'outputPerMillion', 'cacheReadPerMillion', 'cacheWritePerMillion', 'cacheWrite1hPerMillion'] as const;

/** What the table's row would read, taken from the source model. */
export function pricingFromSource(model: SourceModel): SourcePricing {
  const p = model.pricing;
  const out: SourcePricing = { furtherTiers: 0 };
  const base = {
    inputPerMillion: perMillion(p.prompt),
    outputPerMillion: perMillion(p.completion),
    cacheReadPerMillion: perMillion(p.input_cache_read),
    cacheWritePerMillion: perMillion(p.input_cache_write),
    cacheWrite1hPerMillion: perMillion(p.input_cache_write_1h),
  };
  for (const field of RATE_FIELDS) {
    const v = base[field];
    if (v !== undefined) out[field] = v;
  }
  const tiers = (p.overrides ?? []).filter((o) => typeof o.min_prompt_tokens === 'number');
  const tier = tiers[0];
  if (tier !== undefined) {
    const long: LongTier = { overTokens: tier.min_prompt_tokens };
    const rate = (over: string | undefined, fallback: number | undefined) => perMillion(over) ?? fallback;
    const li = rate(tier.prompt, base.inputPerMillion), lo = rate(tier.completion, base.outputPerMillion);
    const lr = rate(tier.input_cache_read, base.cacheReadPerMillion);
    const lw = rate(tier.input_cache_write, base.cacheWritePerMillion), lw1 = rate(tier.input_cache_write_1h, base.cacheWrite1hPerMillion);
    if (li !== undefined) long.inputPerMillion = li;
    if (lo !== undefined) long.outputPerMillion = lo;
    if (lr !== undefined) long.cacheReadPerMillion = lr;
    if (lw !== undefined) long.cacheWritePerMillion = lw;
    if (lw1 !== undefined) long.cacheWrite1hPerMillion = lw1;
    out.longPrompt = long;
    out.furtherTiers = tiers.length - 1;
  }
  return out;
}

export interface PricingDifference {
  /** The field, dotted for the tier: `cacheReadPerMillion`, `longPrompt.inputPerMillion`. */
  field: string;
  table: number | undefined;
  source: number | undefined;
}

/** The table's tier as the rates it charges: an unset tier rate is the base rate. */
function effectiveTier(table: TablePricing): LongTier | undefined {
  const t = table.longPrompt;
  if (!t) return undefined;
  const out: LongTier = { overTokens: t.overTokens };
  for (const field of RATE_FIELDS) {
    const v = t[field] ?? table[field];
    if (v !== undefined) out[field] = v;
  }
  return out;
}

/** Every field on which a table row and the source's reading of the same model differ. */
export function comparePricing(table: TablePricing, source: SourcePricing): PricingDifference[] {
  const out: PricingDifference[] = [];
  for (const field of RATE_FIELDS) {
    if (!same(table[field], source[field])) out.push({ field, table: table[field], source: source[field] });
  }
  const t = effectiveTier(table), s = source.longPrompt;
  if (!t && !s) return out;
  if (!same(t?.overTokens, s?.overTokens)) out.push({ field: 'longPrompt.overTokens', table: t?.overTokens, source: s?.overTokens });
  for (const field of RATE_FIELDS) {
    if (!same(t?.[field], s?.[field])) out.push({ field: `longPrompt.${field}`, table: t?.[field], source: s?.[field] });
  }
  return out;
}

/** Equal to within a millionth of the larger: a page's $0.0833 and a table's 1/12 agree. */
function same(a: number | undefined, b: number | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * 1e-6;
}

/** The table id a source model would be looked up by: the provider dropped,
 *  Anthropic's dots back to dashes (`anthropic/claude-haiku-5.5` →
 *  `claude-haiku-5-5`). `null` for an OpenRouter variant (`:batch`, `:free`,
 *  `:nitro`), which is OpenRouter's own id syntax and not a provider's model
 *  id, and for a provider the table doesn't carry. */
export function tableIdFor(sourceId: string): string | null {
  if (sourceId.includes(':')) return null;
  const slash = sourceId.indexOf('/');
  const provider = sourceId.slice(0, slash), name = sourceId.slice(slash + 1);
  if (provider === 'anthropic') return name.startsWith('claude-') ? name.replace(/\./g, '-') : null;
  if (provider === 'openai') return name.startsWith('gpt-') ? name : null;
  if (provider === 'google') return name.startsWith('gemini-') ? name : null;
  return null;
}
