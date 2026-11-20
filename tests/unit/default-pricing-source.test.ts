import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRICING_TABLE, getDefaultPricing } from '../../src/registry/default-pricing.js';
import { comparePricing, pricingFromSource, sourceIdFor, tableIdFor, type SourceSnapshot, type TablePricing } from '../../src/registry/pricing-source.js';

/**
 * The built-in table against the source snapshot (#270). Each priced row's
 * rates in effect on the snapshot's date are compared to the source's reading
 * of the same model; a difference fails with both figures unless it is a
 * known gap below, listed per row and field with what closes it. A listed gap
 * that is gone fails too, so the lists shrink as PRs land. The known
 * differences are printed once per run.
 *
 * The check is as current as the snapshot: `node scripts/pricing-source.mjs`
 * refreshes it, by hand, and a provider's change after the last refresh is
 * caught at the next one. A new failure after a refresh is either a
 * provider's change (update the row, citing the provider's page) or a source
 * error (say so on the row's entry below, with the page that decided it).
 */

const snapshot: SourceSnapshot = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'openrouter-models.json'), 'utf8'),
);
const AT = Date.parse(`${snapshot.readAt}T12:00:00Z`);

/** Rows the source has no model for, by name: a new one fails, as does one that turns up. */
const KNOWN_MISSING = ['claude-mythos-5-2', 'claude-mythos-5-1', 'claude-mythos-5', 'claude-opus-4', 'claude-sonnet-4', 'claude-3-5-haiku', 'claude-3-5-sonnet'];

const TIER = ['longPrompt.overTokens', 'longPrompt.inputPerMillion', 'longPrompt.outputPerMillion', 'longPrompt.cacheReadPerMillion'];
const TIER_WITH_WRITES = [...TIER, 'longPrompt.cacheWritePerMillion', 'longPrompt.cacheWrite1hPerMillion'];
const BASE = ['inputPerMillion', 'outputPerMillion', 'cacheReadPerMillion'];

/** Differences the table is known to have: one entry per row, naming its fields and what closes them. */
const KNOWN_GAPS: Array<{ prefix: string; fields: string[]; why: string }> = [
  // #264 adds the long-prompt tier.
  { prefix: 'claude-haiku-5-5', fields: TIER_WITH_WRITES, why: '#264 adds the long-prompt tier' },
  { prefix: 'gpt-6-astra', fields: [...TIER, 'longPrompt.cacheWritePerMillion'], why: '#264 adds the long-prompt tier (its write rate with #266)' },
  { prefix: 'gpt-5.6-sol', fields: [...TIER, 'longPrompt.cacheWritePerMillion'], why: '#264 adds the long-prompt tier (its write rate with #266)' },
  { prefix: 'gpt-5.6-terra', fields: [...TIER, 'longPrompt.cacheWritePerMillion'], why: '#264 adds the long-prompt tier (its write rate with #266)' },
  { prefix: 'gpt-5.6-luna', fields: [...TIER, 'longPrompt.cacheWritePerMillion'], why: '#264 adds the long-prompt tier (its write rate with #266)' },
  { prefix: 'gpt-5.5', fields: TIER, why: '#264 adds the long-prompt tier' },
  { prefix: 'gpt-5.4', fields: TIER, why: '#264 adds the long-prompt tier' },
  { prefix: 'gemini-3.1-pro-preview', fields: [...TIER, 'longPrompt.cacheWritePerMillion'], why: "#264 adds the long-prompt tier; its write is Google's cache storage, which the table excludes" },
  { prefix: 'gemini-2.5-pro', fields: [...TIER, 'longPrompt.cacheWritePerMillion'], why: "#264 adds the long-prompt tier; its write is Google's cache storage, which the table excludes" },
  // #266 adds the OpenAI cache-write rate.
  { prefix: 'gpt-6-astra', fields: ['cacheWritePerMillion'], why: '#266 adds the OpenAI cache-write rate' },
  { prefix: 'gpt-5.6-sol', fields: ['cacheWritePerMillion'], why: '#266 adds the OpenAI cache-write rate' },
  { prefix: 'gpt-5.6-terra', fields: ['cacheWritePerMillion'], why: '#266 adds the OpenAI cache-write rate' },
  { prefix: 'gpt-5.6-luna', fields: ['cacheWritePerMillion'], why: '#266 adds the OpenAI cache-write rate' },
  // The table's own choice: the source's Gemini `input_cache_write` is Google's per-hour
  // cache-storage charge for five minutes ($0.50/MTok/h ÷ 12 on 3.8 Flash); the table's
  // header excludes storage.
  ...['gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite',
    'gemini-3.1-pro-preview', 'gemini-3.1-flash-lite', 'gemini-3-flash-preview', 'gemini-2.5-pro', 'gemini-2.5-flash-lite', 'gemini-2.5-flash']
    .map((prefix) => ({ prefix, fields: ['cacheWritePerMillion'], why: "Google cache storage for five minutes, which the table excludes by its header's choice" })),
  // Source errors, each checked against the provider's page on 2026-11-20.
  { prefix: 'gemini-3.8-flash', fields: BASE, why: "source error: Google's pricing page gives $0.75 / $3.75 / $0.075 through 2026-12-31, as the table has; the source is 10% above" },
  { prefix: 'gemini-3.5-flash', fields: BASE, why: "retired model: Google's page no longer lists it and routes it to 3.6 Flash, which the table prices; the source keeps its last listed rate" },
  { prefix: 'claude-sonnet-4-5', fields: TIER_WITH_WRITES, why: "source error: Anthropic's pricing page lists one rate for Sonnet 4.5 and a long-prompt tier for Haiku 5.5 alone; the source keeps a >200K tier from the 1M beta" },
];

function knownGap(prefix: string, field: string): string | undefined {
  return KNOWN_GAPS.find((g) => g.prefix === prefix && g.fields.includes(field))?.why;
}

/**
 * Source models the table prices by another model's row at other base rates:
 * the prefix rule finds the longest prefix that names the id, which is right
 * for a dated id (`gpt-5.4-2026-03-05`) and silently wrong for a sibling that
 * shares the prefix at another price. #269's case; these are the ones it covers.
 */
const KNOWN_SIBLINGS: Array<{ sourceId: string; row: string; why: string }> = [
  { sourceId: 'openai/gpt-5-pro', row: 'gpt-5', why: '#269: no -pro row' },
  { sourceId: 'openai/gpt-5.2-pro', row: 'gpt-5.2', why: '#269: no -pro row' },
  { sourceId: 'openai/gpt-5.4-pro', row: 'gpt-5.4', why: '#269: no -pro row' },
  { sourceId: 'openai/gpt-5.5-pro', row: 'gpt-5.5', why: '#269: no -pro row' },
  { sourceId: 'openai/gpt-5-image', row: 'gpt-5', why: '#269: no -image row' },
  { sourceId: 'openai/gpt-5-image-mini', row: 'gpt-5', why: '#269: no -image row' },
  { sourceId: 'openai/gpt-5.4-image-2', row: 'gpt-5.4', why: '#269: no -image row' },
  { sourceId: 'openai/gpt-5.1-codex-mini', row: 'gpt-5.1', why: '#269: no codex-mini row' },
  { sourceId: 'openai/gpt-5.3-codex', row: 'gpt-5', why: "#269: the rule lets `gpt-5` name `gpt-5.3-codex` — a dot after the prefix isn't a digit — so any gpt-5.x without a row is priced as gpt-5" },
];

/** A rate for a message: the float noise of a per-token string × 1e6 trimmed. */
const show = (n: number | undefined) => (n === undefined ? '—' : String(Number(n.toPrecision(12))));

describe('the built-in pricing table against the source snapshot', () => {
  const bySourceId = new Map(snapshot.models.map((m) => [m.id, m]));
  const priced = PRICING_TABLE.filter((row) => row.pricing !== null);
  /** The row whose rates `getDefaultPricing(id)` returned, found by identity — the
   *  production selector, not a copy of it. Two rows can share one rates object
   *  (a retired model priced as the one it routes to), so among those the one
   *  whose prefix the id starts with, longest first. */
  const rowOf = (pricing: object | undefined, id: string) =>
    PRICING_TABLE
      .filter((r) => r.pricing !== null && (r.pricing === pricing || (r.changes ?? []).some((c) => c.pricing === pricing)))
      .filter((r) => id.startsWith(r.prefix))
      .sort((a, b) => b.prefix.length - a.prefix.length)[0];
  /** A row's rates in effect on the snapshot's date, through the table's own lookup. */
  const effective = (prefix: string): TablePricing => getDefaultPricing(prefix, AT)!;
  const known: string[] = [];

  it('has a snapshot with a date and the three providers', () => {
    expect(snapshot.readAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isFinite(AT)).toBe(true);
    expect(snapshot.source).toBe('https://openrouter.ai/api/v1/models');
    for (const provider of ['anthropic/', 'openai/', 'google/']) {
      expect(snapshot.models.some((m) => m.id.startsWith(provider)), provider).toBe(true);
    }
  });

  it('has a source model for every priced row but the known missing ones', () => {
    const missing = priced.map((r) => r.prefix).filter((p) => !bySourceId.has(sourceIdFor(p) ?? ''));
    expect(missing.sort()).toEqual([...KNOWN_MISSING].sort());
  });

  for (const row of priced) {
    const sourceId = sourceIdFor(row.prefix);
    const model = sourceId ? bySourceId.get(sourceId) : undefined;
    if (!model) continue;
    it(`${row.prefix} matches ${sourceId}`, () => {
      expect(rowOf(effective(row.prefix), row.prefix), `${row.prefix} resolves to its own row`).toBe(row);
      const source = pricingFromSource(model);
      expect(source.furtherTiers, `${sourceId} has more tiers than the table's one longPrompt`).toBe(0);
      const differences = comparePricing(effective(row.prefix), source);
      const lines = differences.map((d) => `${d.field}: table ${show(d.table)}, source ${show(d.source)}`);
      const unexplained = differences.filter((d) => !knownGap(row.prefix, d.field));
      for (const d of differences) if (knownGap(row.prefix, d.field)) known.push(`${row.prefix} ${d.field} (${knownGap(row.prefix, d.field)})`);
      expect(unexplained.map((d) => d.field), `${row.prefix} vs ${sourceId} (snapshot ${snapshot.readAt}):\n  ${lines.join('\n  ')}`).toEqual([]);
    });
  }

  it('prices no source model by a sibling row at other base rates, beyond the known ones', () => {
    const found: string[] = [];
    for (const model of snapshot.models) {
      const id = tableIdFor(model.id);
      if (!id) continue;
      const row = rowOf(getDefaultPricing(id, AT), id);
      if (!row || row.prefix === id || row.pricing === null) continue;
      const base = comparePricing(effective(row.prefix), pricingFromSource(model)).filter((d) => d.field === 'inputPerMillion' || d.field === 'outputPerMillion');
      if (base.length === 0) continue;
      const entry = KNOWN_SIBLINGS.find((k) => k.sourceId === model.id);
      const line = `${model.id} → row ${row.prefix}: ${base.map((d) => `${d.field} table ${show(d.table)} source ${show(d.source)}`).join(', ')}`;
      if (!entry) found.push(line);
      else if (entry.row !== row.prefix) found.push(`${line} (known under row ${entry.row})`);
    }
    expect(found).toEqual([]);
  });

  it('lists no known sibling that is gone, has its own row, or is priced at its rates', () => {
    const stale = KNOWN_SIBLINGS.filter((k) => {
      const model = bySourceId.get(k.sourceId);
      const id = model && tableIdFor(model.id);
      if (!model || !id) return true;
      const row = rowOf(getDefaultPricing(id, AT), id);
      if (!row || row.prefix === id || row.pricing === null || row.prefix !== k.row) return true;
      return !comparePricing(effective(row.prefix), pricingFromSource(model)).some((d) => d.field === 'inputPerMillion' || d.field === 'outputPerMillion');
    });
    expect(stale.map((k) => k.sourceId)).toEqual([]);
  });

  it('lists no known gap the table no longer has', () => {
    const stale: string[] = [];
    for (const gap of KNOWN_GAPS) {
      const row = priced.find((r) => r.prefix === gap.prefix);
      const model = row && bySourceId.get(sourceIdFor(row.prefix) ?? '');
      if (!row || !model) { stale.push(`${gap.prefix}: no such row or source model`); continue; }
      const fields = new Set(comparePricing(effective(row.prefix), pricingFromSource(model)).map((d) => d.field));
      for (const field of gap.fields) if (!fields.has(field)) stale.push(`${gap.prefix} ${field} (${gap.why})`);
    }
    expect(stale).toEqual([]);
  });

  it('reports the known differences', () => {
    console.log(`known differences from the snapshot of ${snapshot.readAt}:\n  ${known.join('\n  ')}`);
  });
});
