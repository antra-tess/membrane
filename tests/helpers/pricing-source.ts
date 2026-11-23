import type { ModelPricing } from '../../src/types/provider.js';

/**
 * The built-in pricing table checked against a source (#270). A test helper,
 * not part of the package.
 *
 * The table is typed by hand from the providers' pricing pages, and each row
 * has to be found and re-read when a provider changes a rate, adds a column
 * (the 1-hour cache write, the long-prompt tiers) or adds a model. OpenRouter's
 * public model list carries, for every model under the three providers the
 * table prices, the fields the table has — base rates, cache reads and
 * writes, the 1-hour write, and `overrides` keyed by `min_prompt_tokens` for
 * the long-prompt tiers — in one shape, for the models it carries them for. A snapshot of it is checked in
 * (`tests/fixtures/openrouter-models.json`, refreshed by hand with
 * `scripts/pricing-source.mjs`), and a test compares each row's rates in
 * effect at the snapshot's instant to it, so a divergence is a failing test
 * with the two figures rather than a page nobody happened to re-read. The
 * check is as current as the snapshot: a provider's change after it is caught
 * at the next refresh, not before. The test also looks the other way, from the
 * source to the table, for the models the table has no row for.
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
  /** The instant the list was read, ISO 8601 with a time: the table's dated changes are evaluated at it. */
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
 *  (an unset tier rate keeps the row's base rate); a rate that is present and
 *  can't be read is `undefined` and named in `unreadable`, at the base and at
 *  the tier alike, and never falls back. One provider rule: OpenAI
 *  lists no `input_cache_write` for the models whose page shows no write
 *  price, and bills their writes as input (#266), so for `openai/` an *absent*
 *  write rate reads as the prompt rate — at the base, and at a tier whose base
 *  write was absent too; a tier that omits its write under an explicit base
 *  write inherits that, as the table's tier rule has it. A write rate that is
 *  present but unreadable stays `undefined`, so it shows as a difference. */
export interface SourcePricing {
  inputPerMillion?: number;
  outputPerMillion?: number;
  cacheReadPerMillion?: number;
  cacheWritePerMillion?: number;
  cacheWrite1hPerMillion?: number;
  longPrompt?: LongTier;
  /** Overrides past the first: the table has one tier, so a second is reported, not read. */
  furtherTiers: number;
  /** Fields the source carries but this reading couldn't take as a rate (`"invalid"`, a negative, a number
   *  where a string belongs), base and tier (`longPrompt.…`): a row with any is not compared, it fails. */
  unreadable: string[];
}

/**
 * The source's id for a *table prefix*: the provider from the prefix's first
 * word, and Anthropic's dotted version (`claude-haiku-5-5` →
 * `anthropic/claude-haiku-5.5`, `claude-3-5-haiku` → `anthropic/claude-3.5-haiku`).
 * Every prefix of the three providers gets an id; whether the source carries a
 * model under it is the snapshot's to say. `null` for a prefix of no provider
 * the source covers. It is not the inverse of `tableIdFor` on every id: a
 * dated Anthropic id (`claude-sonnet-4-5-20250929`) or an OpenAI id outside
 * `gpt-` has no table prefix, and this takes table prefixes alone.
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

/** A per-token rate string as dollars per million. `undefined` — never 0 —
 *  for anything that isn't a string holding a finite, non-negative number:
 *  an absent field, `null`, a blank, a word, a negative. */
export function perMillion(rate: unknown): number | undefined {
  if (typeof rate !== 'string' || rate.trim() === '') return undefined;
  const n = Number(rate);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n * 1_000_000;
}

export const RATE_FIELDS = ['inputPerMillion', 'outputPerMillion', 'cacheReadPerMillion', 'cacheWritePerMillion', 'cacheWrite1hPerMillion'] as const;
export type RateField = (typeof RATE_FIELDS)[number];
// Every `…PerMillion` field of ModelPricing has to be in RATE_FIELDS; the test
// file checks that at run time against src/types/provider.ts, since tsconfig
// type-checks src/ alone and nothing compiles this file.

/** What the table's row would read, taken from the source model. */
export function pricingFromSource(model: SourceModel): SourcePricing {
  const p = model.pricing;
  const openai = model.id.startsWith('openai/');
  const out: SourcePricing = { furtherTiers: 0, unreadable: [] };
  const SOURCE_KEY: Record<RateField, keyof SourceOverride & keyof SourceModel['pricing']> = {
    inputPerMillion: 'prompt', outputPerMillion: 'completion', cacheReadPerMillion: 'input_cache_read',
    cacheWritePerMillion: 'input_cache_write', cacheWrite1hPerMillion: 'input_cache_write_1h',
  };
  const read = (holder: Record<string, unknown>, field: RateField, at: string): number | undefined => {
    const raw = holder[SOURCE_KEY[field]];
    if (raw === undefined) return undefined;
    const n = perMillion(raw);
    if (n === undefined) out.unreadable.push(at);
    return n;
  };
  const base: Partial<Record<RateField, number>> = {};
  for (const field of RATE_FIELDS) base[field] = read(p as Record<string, unknown>, field, field);
  const writeAbsent = p.input_cache_write === undefined;
  if (openai && writeAbsent) base.cacheWritePerMillion = base.inputPerMillion;
  for (const field of RATE_FIELDS) {
    const v = base[field];
    if (v !== undefined) out[field] = v;
  }
  const tiers = (p.overrides ?? []).filter((o) => typeof o.min_prompt_tokens === 'number');
  const tier = tiers[0];
  if (tier !== undefined) {
    const long: LongTier = { overTokens: tier.min_prompt_tokens };
    const t = tier as unknown as Record<string, unknown>;
    // A tier rate the override leaves out is the base rate; one it carries is read, and stays undefined if unreadable.
    const rate = (field: RateField, fallback: number | undefined) => (t[SOURCE_KEY[field]] === undefined ? fallback : read(t, field, `longPrompt.${field}`));
    const li = rate('inputPerMillion', base.inputPerMillion), lo = rate('outputPerMillion', base.outputPerMillion);
    const lr = rate('cacheReadPerMillion', base.cacheReadPerMillion);
    const lw = t.input_cache_write !== undefined
      ? read(t, 'cacheWritePerMillion', 'longPrompt.cacheWritePerMillion')
      : openai && writeAbsent ? li : base.cacheWritePerMillion;
    const lw1 = rate('cacheWrite1hPerMillion', base.cacheWrite1hPerMillion);
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
export function effectiveTier(table: TablePricing): LongTier | undefined {
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
    if (!sameRate(table[field], source[field])) out.push({ field, table: table[field], source: source[field] });
  }
  const t = effectiveTier(table), s = source.longPrompt;
  if (!t && !s) return out;
  // A token threshold is an integer: equal or not.
  if (t?.overTokens !== s?.overTokens) out.push({ field: 'longPrompt.overTokens', table: t?.overTokens, source: s?.overTokens });
  for (const field of RATE_FIELDS) {
    if (!sameRate(t?.[field], s?.[field])) out.push({ field: `longPrompt.${field}`, table: t?.[field], source: s?.[field] });
  }
  return out;
}

/** Two figures of one field are the same: a token threshold exactly, a rate to a millionth (see sameRate). */
export function sameFigure(field: string, a: number | undefined, b: number | undefined): boolean {
  return field.endsWith('overTokens') ? a === b : sameRate(a, b);
}

/** Two rates are the same to within a millionth of the larger: enough for the
 *  float noise of a per-token string × 1e6 (`"0.0000004"` → 0.39999999999999997),
 *  not enough to pass a rounded figure for an exact one ($0.0833 is not 1/12). */
export function sameRate(a: number | undefined, b: number | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * 1e-6;
}

/** The table id a source model would be looked up by: the provider dropped,
 *  Anthropic's dots back to dashes (`anthropic/claude-haiku-5.5` →
 *  `claude-haiku-5-5`). Every model of the three providers gets one, whatever
 *  its name (`openai/o3` → `o3`), since a caller can ask for any of them and
 *  the table answers or doesn't. `null` for an OpenRouter variant (`:batch`,
 *  `:free`, `:nitro`), which is OpenRouter's own id syntax and not a
 *  provider's model id, and for a provider the table doesn't carry. */
export function tableIdFor(sourceId: string): string | null {
  if (sourceId.includes(':')) return null;
  const slash = sourceId.indexOf('/');
  const provider = sourceId.slice(0, slash), name = sourceId.slice(slash + 1);
  if (provider === 'anthropic') return name.replace(/\./g, '-');
  if (provider === 'openai' || provider === 'google') return name;
  return null;
}

/** The table's prefix rule, as `getDefaultPricing` applies it (default-pricing.ts
 *  `prefixNames`): the prefix names the id when the id is the prefix, or starts
 *  with it and what follows isn't a digit (so `gpt-5.4` names `gpt-5.4-2026-03-05`
 *  and not `gpt-5.40`), or the prefix ends in a dash. Kept beside the table's
 *  own so a change there fails a test here. */
export function prefixNames(prefix: string, id: string): boolean {
  if (!id.startsWith(prefix)) return false;
  return prefix.endsWith('-') || !/^\d/.test(id.slice(prefix.length));
}
