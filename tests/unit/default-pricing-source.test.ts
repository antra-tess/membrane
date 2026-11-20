import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRICING_TABLE } from '../../src/registry/default-pricing.js';
import { comparePricing, matchingPrefix, pricingFromSource, sourceIdFor, tableIdFor, type SourceSnapshot, type TablePricing } from '../../src/registry/pricing-source.js';

/**
 * The built-in table against the source snapshot (#270). A row that differs
 * from the source on a field fails here with both figures, unless the
 * difference is a known gap below — one with an open PR or issue — in which
 * case it is reported and expected, and the entry goes when the PR lands.
 *
 * To refresh the snapshot: `node scripts/pricing-source.mjs`, then run this
 * file. A new failure is either a provider's change (update the row, citing
 * the provider's page) or a source error (say so on the row, add it below).
 */

const snapshot: SourceSnapshot = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'openrouter-models.json'), 'utf8'),
);

/**
 * Differences the table is known to have, each with what closes it: an open
 * PR, a choice the table makes on purpose, or a source error checked against
 * the provider's page. An entry whose difference is gone fails the last test,
 * so the list shrinks as PRs land.
 */
const KNOWN_GAPS: Array<{ prefix: string | RegExp; field: string | RegExp; why: string }> = [
  // Open PRs.
  { prefix: /^(claude-haiku-5-5|gpt-6-astra|gpt-5\.6-(sol|terra|luna)|gpt-5\.5|gpt-5\.4|gemini-3\.1-pro-preview|gemini-2\.5-pro)$/, field: /^longPrompt\./, why: '#264 adds the long-prompt tier' },
  { prefix: /^(gpt-6-astra|gpt-5\.6-(sol|terra|luna))$/, field: 'cacheWritePerMillion', why: '#266 adds the OpenAI cache-write rate' },
  // The table's own choices.
  { prefix: /^gemini-/, field: 'cacheWritePerMillion', why: "the source's figure is Google's per-hour cache-storage charge for five minutes ($0.50/MTok/h ÷ 12 on 3.8 Flash); the table excludes storage by its header's choice" },
  // Source errors, each checked against the provider's page on 2026-11-20.
  { prefix: 'gemini-3.8-flash', field: /^(input|output|cacheRead)PerMillion$/, why: "source error: Google's pricing page gives $0.75 / $3.75 / $0.075 through 2026-12-31, as the table has; the source is 10% above" },
  { prefix: 'gemini-3.5-flash', field: /^(input|output|cacheRead)PerMillion$/, why: "retired model: Google's page no longer lists it and routes it to 3.6 Flash, which the table prices; the source keeps its last listed rate" },
  { prefix: 'claude-sonnet-4-5', field: /^longPrompt\./, why: "source error: Anthropic's pricing page lists one rate for Sonnet 4.5 and a long-prompt tier for Haiku 5.5 alone; the source keeps a >200K tier from the 1M beta" },
];

function knownGap(prefix: string, field: string): string | undefined {
  const match = (p: string | RegExp, v: string) => (typeof p === 'string' ? p === v : p.test(v));
  return KNOWN_GAPS.find((g) => match(g.prefix, prefix) && match(g.field, field))?.why;
}

/**
 * Source models the table prices by another model's row: the prefix rule
 * finds the longest prefix that names the id, which is right for a dated id
 * (`gpt-5.4-2026-03-05`) and silently wrong for a sibling that shares the
 * prefix at another price. Each is #269's case; the entries below are the
 * ones it covers.
 */
const KNOWN_SIBLINGS: Array<{ sourceId: string; why: string }> = [
  { sourceId: 'openai/gpt-5-pro', why: '#269: no -pro row' },
  { sourceId: 'openai/gpt-5.2-pro', why: '#269: no -pro row' },
  { sourceId: 'openai/gpt-5.4-pro', why: '#269: no -pro row' },
  { sourceId: 'openai/gpt-5.5-pro', why: '#269: no -pro row' },
  { sourceId: 'openai/gpt-5-image', why: '#269: no -image row' },
  { sourceId: 'openai/gpt-5-image-mini', why: '#269: no -image row' },
  { sourceId: 'openai/gpt-5.4-image-2', why: '#269: no -image row' },
  { sourceId: 'openai/gpt-5.1-codex-mini', why: '#269: no codex-mini row' },
  { sourceId: 'openai/gpt-5.3-codex', why: "#269: the rule lets `gpt-5` name `gpt-5.3-codex` — a dot after the prefix isn't a digit — so any gpt-5.x without a row is priced as gpt-5" },
];

describe('the built-in pricing table against the source snapshot', () => {
  const bySourceId = new Map(snapshot.models.map((m) => [m.id, m]));
  const priced = PRICING_TABLE.filter((row): row is typeof row & { pricing: TablePricing } => row.pricing !== null);

  it('has a snapshot with a date and the three providers', () => {
    expect(snapshot.readAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(snapshot.source).toBe('https://openrouter.ai/api/v1/models');
    for (const provider of ['anthropic/', 'openai/', 'google/']) {
      expect(snapshot.models.some((m) => m.id.startsWith(provider)), provider).toBe(true);
    }
  });

  for (const row of priced) {
    const sourceId = sourceIdFor(row.prefix);
    const model = sourceId ? bySourceId.get(sourceId) : undefined;
    if (!model) {
      it.skip(`${row.prefix}: not in the source${sourceId ? ` as ${sourceId}` : ' (no id rule for this prefix)'}`, () => {});
      continue;
    }
    it(`${row.prefix} matches ${sourceId}`, () => {
      const differences = comparePricing(row.pricing, pricingFromSource(model));
      const unexplained = differences.filter((d) => !knownGap(row.prefix, d.field));
      const lines = differences.map((d) => {
        const why = knownGap(row.prefix, d.field);
        return `  ${d.field}: table ${d.table ?? '—'}, source ${d.source ?? '—'}${why ? ` (known: ${why})` : ''}`;
      });
      expect(unexplained, `${row.prefix} vs ${sourceId} (snapshot ${snapshot.readAt}):\n${lines.join('\n')}`).toEqual([]);
    });
  }

  it('prices no source model by a sibling row at other base rates, beyond the known ones', () => {
    const prefixes = PRICING_TABLE.map((r) => r.prefix);
    const found: string[] = [];
    for (const model of snapshot.models) {
      const id = tableIdFor(model.id);
      if (!id) continue;
      const prefix = matchingPrefix(prefixes, id);
      if (!prefix || prefix === id) continue;
      const row = priced.find((r) => r.prefix === prefix);
      if (!row) continue;
      const base = comparePricing(row.pricing, pricingFromSource(model)).filter((d) => d.field === 'inputPerMillion' || d.field === 'outputPerMillion');
      if (base.length === 0) continue;
      const known = KNOWN_SIBLINGS.find((k) => k.sourceId === model.id)?.why;
      const line = `${model.id} → row ${prefix}: ${base.map((d) => `${d.field} table ${d.table} source ${d.source}`).join(', ')}`;
      if (!known) found.push(line);
    }
    expect(found).toEqual([]);
  });

  it('lists no known sibling the source no longer has, or that now has its own row', () => {
    const prefixes = PRICING_TABLE.map((r) => r.prefix);
    const stale = KNOWN_SIBLINGS.filter((k) => {
      const model = bySourceId.get(k.sourceId);
      const id = model && tableIdFor(model.id);
      if (!model || !id) return true;
      const prefix = matchingPrefix(prefixes, id);
      return !prefix || prefix === id;
    });
    expect(stale.map((k) => k.sourceId)).toEqual([]);
  });

  it('lists no known gap that the table no longer has', () => {
    const stale = KNOWN_GAPS.filter((gap) => {
      const rows = priced.filter((r) => (typeof gap.prefix === 'string' ? r.prefix === gap.prefix : gap.prefix.test(r.prefix)));
      return !rows.some((row) => {
        const sourceId = sourceIdFor(row.prefix);
        const model = sourceId ? bySourceId.get(sourceId) : undefined;
        return model && comparePricing(row.pricing, pricingFromSource(model)).some((d) =>
          typeof gap.field === 'string' ? d.field === gap.field : gap.field.test(d.field));
      });
    });
    expect(stale.map((g) => `${String(g.prefix)} ${String(g.field)} (${g.why})`)).toEqual([]);
  });
});
