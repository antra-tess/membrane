import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRICING_TABLE, getDefaultPricing } from '../../src/registry/default-pricing.js';
import { RATE_FIELDS } from '../helpers/pricing-source.js';
import {
  comparePricing, perMillion, prefixNames, pricingFromSource, sameFigure, sameRate, sourceIdFor, tableIdFor,
  type SourceModel, type SourceSnapshot, type TablePricing,
} from '../helpers/pricing-source.js';

/**
 * The built-in table against the source snapshot (#270), both ways.
 *
 * Table → source: each priced row's rates in effect at the snapshot's instant
 * are compared to the source's reading of the same model; a difference fails
 * with both figures unless it is a known gap below — one entry per row and
 * field, carrying the two figures it expects and what closes it. An entry
 * fails when the difference is gone (the gap closed: delete the entry) or when
 * either figure moved (a table edit, or a refresh that changed the source:
 * read the provider's page, then update the row or the entry). So a listed
 * field is still checked, against the figures it was listed with.
 *
 * Source → table: every source model the prefix mapping covers either has a
 * row, a `pricing: null` row, or is in KNOWN_UNPRICED, asserted for equality,
 * so a model the source carries and the table doesn't fails here rather than
 * in a resident's `estimatedCost`. And the models the prefix rule prices by
 * another model's row at other base rates are listed (KNOWN_SIBLINGS, #269).
 *
 * The check is as current as the snapshot: `node scripts/pricing-source.mjs`
 * refreshes it, by hand, and a provider's change after the last refresh is
 * caught at the next one. PRICING_SOURCE_DUMP=1 prints the three lists as the
 * snapshot would have them, as entries to paste.
 */

const snapshot: SourceSnapshot = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'openrouter-models.json'), 'utf8'),
);
const AT = Date.parse(snapshot.readAt);

/** Rows the source has no model for, by name: a new one fails, as does one that turns up. */
const KNOWN_MISSING = ['claude-mythos-5-2', 'claude-mythos-5-1', 'claude-mythos-5', 'claude-opus-4', 'claude-sonnet-4', 'claude-3-5-haiku', 'claude-3-5-sonnet'];

interface Gap { prefix: string; field: string; table: number | undefined; source: number | undefined; why: string }
const gap = (prefix: string, field: string, table: number | undefined, source: number | undefined, why: string): Gap => ({ prefix, field, table, source, why });

/** Differences the table is known to have, each with the figures it expects on both sides. `undefined` on the table side: the table leaves the field out by design. */
const KNOWN_GAPS: Gap[] = [
  gap('claude-sonnet-4-5', 'longPrompt.overTokens', undefined, 200000, 'source error: Anthropic\'s page lists one rate for Sonnet 4.5 and a long-prompt tier for Haiku 5.5 alone (read 2026-11-20 and 2026-11-22); the source keeps a >200K tier from the 1M beta'),
  gap('claude-sonnet-4-5', 'longPrompt.inputPerMillion', undefined, 6, 'source error: Anthropic\'s page lists one rate for Sonnet 4.5 and a long-prompt tier for Haiku 5.5 alone (read 2026-11-20 and 2026-11-22); the source keeps a >200K tier from the 1M beta'),
  gap('claude-sonnet-4-5', 'longPrompt.outputPerMillion', undefined, 22.5, 'source error: Anthropic\'s page lists one rate for Sonnet 4.5 and a long-prompt tier for Haiku 5.5 alone (read 2026-11-20 and 2026-11-22); the source keeps a >200K tier from the 1M beta'),
  gap('claude-sonnet-4-5', 'longPrompt.cacheReadPerMillion', undefined, 0.6, 'source error: Anthropic\'s page lists one rate for Sonnet 4.5 and a long-prompt tier for Haiku 5.5 alone (read 2026-11-20 and 2026-11-22); the source keeps a >200K tier from the 1M beta'),
  gap('claude-sonnet-4-5', 'longPrompt.cacheWritePerMillion', undefined, 7.5, 'source error: Anthropic\'s page lists one rate for Sonnet 4.5 and a long-prompt tier for Haiku 5.5 alone (read 2026-11-20 and 2026-11-22); the source keeps a >200K tier from the 1M beta'),
  gap('claude-sonnet-4-5', 'longPrompt.cacheWrite1hPerMillion', undefined, 12, 'source error: Anthropic\'s page lists one rate for Sonnet 4.5 and a long-prompt tier for Haiku 5.5 alone (read 2026-11-20 and 2026-11-22); the source keeps a >200K tier from the 1M beta'),
  gap('claude-haiku-5-5', 'longPrompt.overTokens', undefined, 100000, '#264 adds the long-prompt tier'),
  gap('claude-haiku-5-5', 'longPrompt.inputPerMillion', undefined, 0.5, '#264 adds the long-prompt tier'),
  gap('claude-haiku-5-5', 'longPrompt.outputPerMillion', undefined, 2.5, '#264 adds the long-prompt tier'),
  gap('claude-haiku-5-5', 'longPrompt.cacheReadPerMillion', undefined, 0.05, '#264 adds the long-prompt tier'),
  gap('claude-haiku-5-5', 'longPrompt.cacheWritePerMillion', undefined, 0.625, '#264 adds the long-prompt tier'),
  gap('claude-haiku-5-5', 'longPrompt.cacheWrite1hPerMillion', undefined, 1, '#264 adds the long-prompt tier'),
  gap('gpt-6-astra', 'cacheWritePerMillion', undefined, 12.5, '#266 adds the OpenAI cache-write rate: 1.25x input, the page\'s 30-minute rate'),
  gap('gpt-6-astra', 'longPrompt.overTokens', undefined, 272000, '#264 adds the long-prompt tier'),
  gap('gpt-6-astra', 'longPrompt.inputPerMillion', undefined, 20, '#264 adds the long-prompt tier'),
  gap('gpt-6-astra', 'longPrompt.outputPerMillion', undefined, 75, '#264 adds the long-prompt tier'),
  gap('gpt-6-astra', 'longPrompt.cacheReadPerMillion', undefined, 2, '#264 adds the long-prompt tier'),
  gap('gpt-6-astra', 'longPrompt.cacheWritePerMillion', undefined, 25, '#264 adds the long-prompt tier; its write rate is the tier\'s input rate (OpenAI doubles writes above 272K too), which neither #264\'s tier nor #266\'s base write carries yet — after both land this entry moves to table = the base write and stays listed until a PR adds the tier\'s own'),
  gap('gpt-5.6-sol', 'cacheWritePerMillion', undefined, 5, '#266 adds the OpenAI cache-write rate: 1.25x input, the page\'s 30-minute rate'),
  gap('gpt-5.6-sol', 'longPrompt.overTokens', undefined, 272000, '#264 adds the long-prompt tier'),
  gap('gpt-5.6-sol', 'longPrompt.inputPerMillion', undefined, 8, '#264 adds the long-prompt tier'),
  gap('gpt-5.6-sol', 'longPrompt.outputPerMillion', undefined, 30, '#264 adds the long-prompt tier'),
  gap('gpt-5.6-sol', 'longPrompt.cacheReadPerMillion', undefined, 0.8, '#264 adds the long-prompt tier'),
  gap('gpt-5.6-sol', 'longPrompt.cacheWritePerMillion', undefined, 10, '#264 adds the long-prompt tier; its write rate is the tier\'s input rate (OpenAI doubles writes above 272K too), which neither #264\'s tier nor #266\'s base write carries yet — after both land this entry moves to table = the base write and stays listed until a PR adds the tier\'s own'),
  gap('gpt-5.6-terra', 'cacheWritePerMillion', undefined, 2.5, '#266 adds the OpenAI cache-write rate: 1.25x input, the page\'s 30-minute rate'),
  gap('gpt-5.6-terra', 'longPrompt.overTokens', undefined, 272000, '#264 adds the long-prompt tier'),
  gap('gpt-5.6-terra', 'longPrompt.inputPerMillion', undefined, 4, '#264 adds the long-prompt tier'),
  gap('gpt-5.6-terra', 'longPrompt.outputPerMillion', undefined, 18, '#264 adds the long-prompt tier'),
  gap('gpt-5.6-terra', 'longPrompt.cacheReadPerMillion', undefined, 0.4, '#264 adds the long-prompt tier'),
  gap('gpt-5.6-terra', 'longPrompt.cacheWritePerMillion', undefined, 5, '#264 adds the long-prompt tier; its write rate is the tier\'s input rate (OpenAI doubles writes above 272K too), which neither #264\'s tier nor #266\'s base write carries yet — after both land this entry moves to table = the base write and stays listed until a PR adds the tier\'s own'),
  gap('gpt-5.6-luna', 'cacheWritePerMillion', undefined, 0.25, '#266 adds the OpenAI cache-write rate: 1.25x input, the page\'s 30-minute rate'),
  gap('gpt-5.6-luna', 'longPrompt.overTokens', undefined, 272000, '#264 adds the long-prompt tier'),
  gap('gpt-5.6-luna', 'longPrompt.inputPerMillion', undefined, 0.4, '#264 adds the long-prompt tier'),
  gap('gpt-5.6-luna', 'longPrompt.outputPerMillion', undefined, 1.8, '#264 adds the long-prompt tier'),
  gap('gpt-5.6-luna', 'longPrompt.cacheReadPerMillion', undefined, 0.04, '#264 adds the long-prompt tier'),
  gap('gpt-5.6-luna', 'longPrompt.cacheWritePerMillion', undefined, 0.5, '#264 adds the long-prompt tier; its write rate is the tier\'s input rate (OpenAI doubles writes above 272K too), which neither #264\'s tier nor #266\'s base write carries yet — after both land this entry moves to table = the base write and stays listed until a PR adds the tier\'s own'),
  gap('gpt-5.5', 'cacheWritePerMillion', undefined, 5, '#266 adds the OpenAI cache-write rate: the input rate, since OpenAI\'s page lists no write price for this model and bills a write as input'),
  gap('gpt-5.5', 'longPrompt.overTokens', undefined, 272000, '#264 adds the long-prompt tier'),
  gap('gpt-5.5', 'longPrompt.inputPerMillion', undefined, 10, '#264 adds the long-prompt tier'),
  gap('gpt-5.5', 'longPrompt.outputPerMillion', undefined, 45, '#264 adds the long-prompt tier'),
  gap('gpt-5.5', 'longPrompt.cacheReadPerMillion', undefined, 1, '#264 adds the long-prompt tier'),
  gap('gpt-5.5', 'longPrompt.cacheWritePerMillion', undefined, 10, '#264 adds the long-prompt tier; its write rate is the tier\'s input rate (OpenAI doubles writes above 272K too), which neither #264\'s tier nor #266\'s base write carries yet — after both land this entry moves to table = the base write and stays listed until a PR adds the tier\'s own'),
  gap('gpt-5.4-mini', 'cacheWritePerMillion', undefined, 0.75, '#266 adds the OpenAI cache-write rate: the input rate, since OpenAI\'s page lists no write price for this model and bills a write as input'),
  gap('gpt-5.4-nano', 'cacheWritePerMillion', undefined, 0.2, '#266 adds the OpenAI cache-write rate: the input rate, since OpenAI\'s page lists no write price for this model and bills a write as input'),
  gap('gpt-5.4', 'cacheWritePerMillion', undefined, 2.5, '#266 adds the OpenAI cache-write rate: the input rate, since OpenAI\'s page lists no write price for this model and bills a write as input'),
  gap('gpt-5.4', 'longPrompt.overTokens', undefined, 272000, '#264 adds the long-prompt tier'),
  gap('gpt-5.4', 'longPrompt.inputPerMillion', undefined, 5, '#264 adds the long-prompt tier'),
  gap('gpt-5.4', 'longPrompt.outputPerMillion', undefined, 22.5, '#264 adds the long-prompt tier'),
  gap('gpt-5.4', 'longPrompt.cacheReadPerMillion', undefined, 0.5, '#264 adds the long-prompt tier'),
  gap('gpt-5.4', 'longPrompt.cacheWritePerMillion', undefined, 5, '#264 adds the long-prompt tier; its write rate is the tier\'s input rate (OpenAI doubles writes above 272K too), which neither #264\'s tier nor #266\'s base write carries yet — after both land this entry moves to table = the base write and stays listed until a PR adds the tier\'s own'),
  gap('gpt-5.2', 'cacheWritePerMillion', undefined, 1.75, '#266 adds the OpenAI cache-write rate: the input rate, since OpenAI\'s page lists no write price for this model and bills a write as input'),
  gap('gpt-5.1', 'cacheWritePerMillion', undefined, 1.25, '#266 adds the OpenAI cache-write rate: the input rate, since OpenAI\'s page lists no write price for this model and bills a write as input'),
  gap('gpt-5-mini', 'cacheWritePerMillion', undefined, 0.25, '#266 adds the OpenAI cache-write rate: the input rate, since OpenAI\'s page lists no write price for this model and bills a write as input'),
  gap('gpt-5-nano', 'cacheWritePerMillion', undefined, 0.05, '#266 adds the OpenAI cache-write rate: the input rate, since OpenAI\'s page lists no write price for this model and bills a write as input'),
  gap('gpt-5', 'cacheWritePerMillion', undefined, 1.25, '#266 adds the OpenAI cache-write rate: the input rate, since OpenAI\'s page lists no write price for this model and bills a write as input'),
  gap('gpt-4o-mini', 'cacheWritePerMillion', undefined, 0.15, '#266 adds the OpenAI cache-write rate: the input rate, since OpenAI\'s page lists no write price for this model and bills a write as input'),
  gap('gpt-4o-2024-05-13', 'cacheWritePerMillion', undefined, 5, '#266 adds the OpenAI cache-write rate: the input rate, since OpenAI\'s page lists no write price for this model and bills a write as input'),
  gap('gpt-4o', 'cacheWritePerMillion', undefined, 2.5, '#266 adds the OpenAI cache-write rate: the input rate, since OpenAI\'s page lists no write price for this model and bills a write as input'),
  gap('gemini-4-argon', 'cacheWritePerMillion', undefined, 0.1875, 'the source lists a write rate the page doesn\'t explain: Google says gemini-4-argon has implicit caching only and no explicit cache to store, so the table is right to carry none; the figure\'s origin is the source\'s to answer'),
  gap('gemini-3.8-flash', 'inputPerMillion', 0.75, 0.825, 'source error: Google\'s page gives $0.75 / $3.75 / $0.075 for 3.8 Flash through 2026-12-31 (read 2026-11-20 and 2026-11-22), as the table has; the source is 10% above'),
  gap('gemini-3.8-flash', 'outputPerMillion', 3.75, 4.125, 'source error: Google\'s page gives $0.75 / $3.75 / $0.075 for 3.8 Flash through 2026-12-31 (read 2026-11-20 and 2026-11-22), as the table has; the source is 10% above'),
  gap('gemini-3.8-flash', 'cacheReadPerMillion', 0.075, 0.0825, 'source error: Google\'s page gives $0.75 / $3.75 / $0.075 for 3.8 Flash through 2026-12-31 (read 2026-11-20 and 2026-11-22), as the table has; the source is 10% above'),
  gap('gemini-3.8-flash', 'cacheWritePerMillion', undefined, 0.0416666666667, 'Google\'s cache storage for five minutes: the page\'s $0.50/MTok/h / 12 (read 2026-11-20), which the table\'s header excludes by design'),
  gap('gemini-3.7-flash', 'cacheWritePerMillion', undefined, 0.0416666666667, 'Google\'s per-hour cache-storage charge for five minutes (the page\'s $/MTok/h / 12), which the table\'s header excludes by design'),
  gap('gemini-3.6-flash', 'cacheWritePerMillion', undefined, 0.0416666666667, 'Google\'s per-hour cache-storage charge for five minutes (the page\'s $/MTok/h / 12), which the table\'s header excludes by design'),
  gap('gemini-3.5-flash', 'inputPerMillion', 0.75, 1.5, 'retired model: Google\'s page no longer lists 3.5 Flash and routes it to 3.6 Flash, which the table prices it as; the source keeps its last listed rate'),
  gap('gemini-3.5-flash', 'outputPerMillion', 3.75, 9, 'retired model: Google\'s page no longer lists 3.5 Flash and routes it to 3.6 Flash, which the table prices it as; the source keeps its last listed rate'),
  gap('gemini-3.5-flash', 'cacheReadPerMillion', 0.075, 0.15, 'retired model: Google\'s page no longer lists 3.5 Flash and routes it to 3.6 Flash, which the table prices it as; the source keeps its last listed rate'),
  gap('gemini-3.5-flash', 'cacheWritePerMillion', undefined, 0.0833333333333, 'Google\'s per-hour cache-storage charge for five minutes (the page\'s $/MTok/h / 12), which the table\'s header excludes by design'),
  gap('gemini-3.5-flash-lite', 'cacheWritePerMillion', undefined, 0.0833333333333, 'Google\'s per-hour cache-storage charge for five minutes (the page\'s $/MTok/h / 12), which the table\'s header excludes by design'),
  gap('gemini-3.1-pro-preview', 'cacheWritePerMillion', undefined, 0.375, 'Google\'s per-hour cache-storage charge for five minutes (the page\'s $/MTok/h / 12), which the table\'s header excludes by design'),
  gap('gemini-3.1-pro-preview', 'longPrompt.overTokens', undefined, 200000, '#264 adds the long-prompt tier'),
  gap('gemini-3.1-pro-preview', 'longPrompt.inputPerMillion', undefined, 4, '#264 adds the long-prompt tier'),
  gap('gemini-3.1-pro-preview', 'longPrompt.outputPerMillion', undefined, 18, '#264 adds the long-prompt tier'),
  gap('gemini-3.1-pro-preview', 'longPrompt.cacheReadPerMillion', undefined, 0.4, '#264 adds the long-prompt tier'),
  gap('gemini-3.1-pro-preview', 'longPrompt.cacheWritePerMillion', undefined, 0.375, '#264 adds the long-prompt tier; the tier\'s write is Google\'s cache storage, as the base\'s (see that entry)'),
  gap('gemini-3.1-flash-lite', 'cacheWritePerMillion', undefined, 0.0833333333333, 'Google\'s per-hour cache-storage charge for five minutes (the page\'s $/MTok/h / 12), which the table\'s header excludes by design'),
  gap('gemini-3-flash-preview', 'cacheWritePerMillion', undefined, 0.0833333333333, 'Google\'s per-hour cache-storage charge for five minutes (the page\'s $/MTok/h / 12), which the table\'s header excludes by design'),
  gap('gemini-2.5-pro', 'cacheWritePerMillion', undefined, 0.375, 'Google\'s per-hour cache-storage charge for five minutes (the page\'s $/MTok/h / 12), which the table\'s header excludes by design'),
  gap('gemini-2.5-pro', 'longPrompt.overTokens', undefined, 200000, '#264 adds the long-prompt tier'),
  gap('gemini-2.5-pro', 'longPrompt.inputPerMillion', undefined, 2.5, '#264 adds the long-prompt tier'),
  gap('gemini-2.5-pro', 'longPrompt.outputPerMillion', undefined, 15, '#264 adds the long-prompt tier'),
  gap('gemini-2.5-pro', 'longPrompt.cacheReadPerMillion', undefined, 0.25, '#264 adds the long-prompt tier'),
  gap('gemini-2.5-pro', 'longPrompt.cacheWritePerMillion', undefined, 0.375, '#264 adds the long-prompt tier; the tier\'s write is Google\'s cache storage, as the base\'s (see that entry)'),
  gap('gemini-2.5-flash-lite', 'cacheWritePerMillion', undefined, 0.0833333333333, 'Google\'s per-hour cache-storage charge for five minutes (the page\'s $/MTok/h / 12), which the table\'s header excludes by design'),
  gap('gemini-2.5-flash', 'cacheWritePerMillion', undefined, 0.0833333333333, 'Google\'s per-hour cache-storage charge for five minutes (the page\'s $/MTok/h / 12), which the table\'s header excludes by design'),
];

interface Sibling { sourceId: string; row: string; table: [number | undefined, number | undefined]; source: [number | undefined, number | undefined]; why: string }
/**
 * Source models the table prices by another model's row at other base rates:
 * the prefix rule finds the longest prefix that names the id, which is right
 * for a dated id (`gpt-5.4-2026-03-05`) and silently wrong for a sibling that
 * shares the prefix at another price. #269's case. Input and output are the
 * two figures compared; a sibling at the same base rates with other cache or
 * tier rates is not what this list is for.
 */
const KNOWN_SIBLINGS: Sibling[] = [
{ sourceId: 'openai/gpt-5-image', row: 'gpt-5', table: [1.25, 10], source: [10, 10], why: '#269: no -image row; an image model priced by the image, which the table has no field for; a pricing: null row would stop the fall-through' },
  { sourceId: 'openai/gpt-5-image-mini', row: 'gpt-5', table: [1.25, 10], source: [2.5, 2], why: '#269: no -image row; as gpt-5-image' },
  { sourceId: 'openai/gpt-5-pro', row: 'gpt-5', table: [1.25, 10], source: [15, 120], why: '#269: no -pro row; the -pro sibling at 12x the row\'s rates' },
  { sourceId: 'openai/gpt-5.1-codex-mini', row: 'gpt-5.1', table: [1.25, 10], source: [0.25, 2], why: '#269: no codex-mini row; priced 5x over by its parent' },
  { sourceId: 'openai/gpt-5.2-pro', row: 'gpt-5.2', table: [1.75, 14], source: [21, 168], why: '#269: no -pro row; the -pro sibling at 12x the row\'s rates' },
  { sourceId: 'openai/gpt-5.3-codex', row: 'gpt-5', table: [1.25, 10], source: [1.75, 14], why: '#269: the rule lets gpt-5 name gpt-5.3-codex (a dot after the prefix isn\'t a digit), so any gpt-5.x without a row is priced as gpt-5' },
  { sourceId: 'openai/gpt-5.4-image-2', row: 'gpt-5.4', table: [2.5, 15], source: [8, 15], why: '#269: no -image row; as gpt-5-image' },
  { sourceId: 'openai/gpt-5.4-pro', row: 'gpt-5.4', table: [2.5, 15], source: [30, 180], why: '#269: no -pro row; the -pro sibling at 12x the row\'s rates' },
  { sourceId: 'openai/gpt-5.5-pro', row: 'gpt-5.5', table: [5, 30], source: [30, 180], why: '#269: no -pro row; the -pro sibling at 6x the row\'s rates' },
];

/** Source models of the three providers the table has no row for at all (not even `pricing: null`): unpriced, warned about per process. #249 (the GPT-6.x and Gemini 4 families), and the rest by reason. 44 at the 2026-11-23 snapshot. */
const KNOWN_UNPRICED: string[] = [
  // #249: the current GPT-6.x and Gemini 4 families, and OpenAI's -pro siblings of them.
  'gpt-6-sol', 'gpt-6-sol-pro', 'gpt-6-luna', 'gpt-6-luna-pro',
  'gpt-6.1-sol', 'gpt-6.1-sol-pro', 'gpt-6.1-terra', 'gpt-6.1-terra-pro',
  'gpt-6.2-astra', 'gpt-6.2-astra-pro', 'gpt-6.2-sol', 'gpt-6.2-sol-pro',
  'gemini-4-carbon', 'gemini-4-hydrogen', 'gemini-4-neon',
  // Image and audio models, priced by the image or the second: the table says so with a pricing: null row for
  // some (gemini-2.5-flash-image, the -tts models) and has none for these; a null row each would move them off this list.
  'gemini-3-pro-image', 'gemini-3-pro-image-preview', 'gemini-3.1-flash-image', 'gemini-3.1-flash-image-preview',
  'gemini-nano-banana-2.1', 'gemini-omni-1.1-flash', 'gemini-omni-1.2-flash', 'gpt-audio', 'gpt-audio-mini',
  // Open-weight models: OpenRouter's rate is a host's, not OpenAI's.
  'gpt-oss-120b', 'gpt-oss-20b', 'gpt-oss-safeguard-20b',
  // Older OpenAI models the table never carried (six), and an alias.
  'gpt-3.5-turbo-0613', 'gpt-3.5-turbo-16k', 'gpt-4', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-chat-latest',
  // OpenAI's o-series: the table has gpt- rows only.
  'o3', 'o3-pro',
  // Google's open-weight Gemma models (OpenRouter's rate is a host's) and the Lyria music models, priced by the second.
  'gemma-2-27b-it', 'gemma-3-12b-it', 'gemma-3-27b-it', 'gemma-3-4b-it', 'gemma-4-26b-a4b-it', 'gemma-4-31b-it',
  'lyria-3-clip-preview', 'lyria-3-pro-preview',
];

/** A rate for a message: the float noise of a per-token string × 1e6 trimmed. */
const show = (n: number | undefined) => (n === undefined ? '—' : String(Number(n.toPrecision(12))));
const lit = (n: number | undefined) => (n === undefined ? 'undefined' : String(Number(n.toPrecision(12))));

const bySourceId = new Map(snapshot.models.map((m) => [m.id, m]));
const priced = PRICING_TABLE.filter((row) => row.pricing !== null);
/** The row whose rates `getDefaultPricing(id)` returned, found by identity — the
 *  production selector, not a copy of it — among the rows whose prefix names the
 *  id under the table's own rule, longest first. */
const rowOf = (pricing: object | undefined, id: string) =>
  PRICING_TABLE
    .filter((r) => r.pricing !== null && (r.pricing === pricing || (r.changes ?? []).some((c) => c.pricing === pricing)))
    .filter((r) => prefixNames(r.prefix, id))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0];
/** A row's rates in effect at the snapshot's instant, through the table's own lookup. */
const effective = (prefix: string): TablePricing => getDefaultPricing(prefix, AT)!;
const sourceModelOf = (prefix: string): SourceModel | undefined => bySourceId.get(sourceIdFor(prefix) ?? '');
const baseOf = (d: ReturnType<typeof comparePricing>) => d.filter((x) => x.field === 'inputPerMillion' || x.field === 'outputPerMillion');
const siblingsFound = () => {
  const out: Array<{ model: SourceModel; row: string; table: [number | undefined, number | undefined]; source: [number | undefined, number | undefined] }> = [];
  for (const model of snapshot.models) {
    const id = tableIdFor(model.id);
    if (!id) continue;
    const row = rowOf(getDefaultPricing(id, AT), id);
    if (!row || row.prefix === id || row.pricing === null) continue;
    const t = effective(row.prefix), s = pricingFromSource(model);
    if (baseOf(comparePricing(t, s)).length === 0) continue;
    out.push({ model, row: row.prefix, table: [t.inputPerMillion, t.outputPerMillion], source: [s.inputPerMillion, s.outputPerMillion] });
  }
  return out;
};
const unpricedFound = () => {
  const out: string[] = [];
  for (const model of snapshot.models) {
    const id = tableIdFor(model.id);
    if (!id) continue;
    if (getDefaultPricing(id, AT)) continue;
    if (PRICING_TABLE.some((r) => r.pricing === null && prefixNames(r.prefix, id))) continue;
    out.push(id);
  }
  return out.sort();
};

describe('the source snapshot', () => {
  it('has an instant, the source and the three providers', () => {
    expect(snapshot.readAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    expect(Number.isFinite(AT)).toBe(true);
    expect(new Date(AT).toISOString()).toBe(snapshot.readAt);
    expect(snapshot.source).toBe('https://openrouter.ai/api/v1/models');
    for (const provider of ['anthropic/', 'openai/', 'google/']) {
      expect(snapshot.models.some((m) => m.id.startsWith(provider)), provider).toBe(true);
    }
  });

  it('has a source model for every priced row but the known missing ones', () => {
    const missing = priced.map((r) => r.prefix).filter((p) => !sourceModelOf(p));
    expect(missing.sort()).toEqual([...KNOWN_MISSING].sort());
  });
});

describe('the built-in pricing table against the source snapshot', () => {
  for (const row of priced) {
    const sourceId = sourceIdFor(row.prefix);
    const model = sourceModelOf(row.prefix);
    if (!model) continue;
    it(`${row.prefix} matches ${sourceId}`, () => {
      expect(rowOf(effective(row.prefix), row.prefix), `${row.prefix} resolves to its own row`).toBe(row);
      const source = pricingFromSource(model);
      expect(source.unreadable, `${sourceId} carries a rate this reading can't take`).toEqual([]);
      expect(source.furtherTiers, `${sourceId} has more tiers than the table's one longPrompt`).toBe(0);
      const differences = comparePricing(effective(row.prefix), source);
      const unexplained = differences.filter((d) => {
        const g = KNOWN_GAPS.find((k) => k.prefix === row.prefix && k.field === d.field);
        return !g || !sameFigure(d.field, g.table, d.table) || !sameFigure(d.field, g.source, d.source);
      });
      const lines = unexplained.map((d) => {
        const g = KNOWN_GAPS.find((k) => k.prefix === row.prefix && k.field === d.field);
        const was = g ? ` (listed as table ${show(g.table)}, source ${show(g.source)}: ${g.why})` : '';
        return `${d.field}: table ${show(d.table)}, source ${show(d.source)}${was}`;
      });
      expect(unexplained.map((d) => d.field), `${row.prefix} vs ${sourceId} (snapshot ${snapshot.readAt}):\n  ${lines.join('\n  ')}`).toEqual([]);
    });
  }

  it('lists each known gap once, with a reason, and none the table no longer has or whose figures moved', () => {
    const stale: string[] = [];
    const seen = new Set<string>();
    for (const g of KNOWN_GAPS) {
      const key = `${g.prefix} ${g.field}`;
      if (seen.has(key)) stale.push(`${key}: listed twice`);
      seen.add(key);
      if (g.why.trim() === '') stale.push(`${key}: no reason`);
      const row = priced.find((r) => r.prefix === g.prefix);
      const model = row && sourceModelOf(row.prefix);
      if (!row || !model) { stale.push(`${key}: no such row or source model`); continue; }
      const d = comparePricing(effective(row.prefix), pricingFromSource(model)).find((x) => x.field === g.field);
      if (!d) stale.push(`${key}: no difference now (${g.why})`);
      else if (!sameFigure(g.field, g.table, d.table) || !sameFigure(g.field, g.source, d.source)) {
        stale.push(`${key}: listed as table ${show(g.table)}, source ${show(g.source)}; now table ${show(d.table)}, source ${show(d.source)}`);
      }
    }
    for (const k of KNOWN_SIBLINGS) if (k.why.trim() === '') stale.push(`${k.sourceId}: no reason`);
    expect(stale).toEqual([]);
  });

  it('prices no source model by a sibling row at other base rates, beyond the known ones', () => {
    const found: string[] = [];
    for (const f of siblingsFound()) {
      const entry = KNOWN_SIBLINGS.find((k) => k.sourceId === f.model.id);
      const line = `${f.model.id} → row ${f.row}: input table ${show(f.table[0])} source ${show(f.source[0])}, output table ${show(f.table[1])} source ${show(f.source[1])}`;
      if (!entry) found.push(line);
      else if (entry.row !== f.row) found.push(`${line} (listed under row ${entry.row})`);
      else if (!sameRate(entry.table[0], f.table[0]) || !sameRate(entry.table[1], f.table[1]) || !sameRate(entry.source[0], f.source[0]) || !sameRate(entry.source[1], f.source[1])) {
        found.push(`${line} (listed as table ${show(entry.table[0])}/${show(entry.table[1])}, source ${show(entry.source[0])}/${show(entry.source[1])})`);
      }
    }
    expect(found).toEqual([]);
  });

  it('lists no known sibling that is gone, has its own row, or is priced at its base rates', () => {
    const now = new Set(siblingsFound().map((f) => f.model.id));
    expect(KNOWN_SIBLINGS.filter((k) => !now.has(k.sourceId)).map((k) => k.sourceId)).toEqual([]);
    const ids = KNOWN_SIBLINGS.map((k) => k.sourceId);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i), 'a sibling listed twice').toEqual([]);
  });

  it('has a row, a null row or a KNOWN_UNPRICED entry for every source model the prefix mapping covers', () => {
    expect(unpricedFound()).toEqual([...KNOWN_UNPRICED].sort());
  });

  it('reports the known differences', () => {
    const lines = KNOWN_GAPS.map((g) => `${g.prefix} ${g.field}: table ${show(g.table)}, source ${show(g.source)} — ${g.why}`);
    console.log(`known differences from the snapshot of ${snapshot.readAt} (${KNOWN_GAPS.length} fields on ${new Set(KNOWN_GAPS.map((g) => g.prefix)).size} rows; ${KNOWN_SIBLINGS.length} siblings; ${KNOWN_UNPRICED.length} unpriced):\n  ${lines.join('\n  ')}`);
  });

  if (process.env.PRICING_SOURCE_DUMP) {
    it('DUMP: the three lists as the snapshot has them (the reasons are yours to write; an empty one fails)', () => {
      const gaps: string[] = [];
      for (const row of priced) {
        const model = sourceModelOf(row.prefix);
        if (!model) continue;
        for (const d of comparePricing(effective(row.prefix), pricingFromSource(model))) {
          gaps.push(`  gap(${JSON.stringify(row.prefix)}, ${JSON.stringify(d.field)}, ${lit(d.table)}, ${lit(d.source)}, ''),`);
        }
      }
      const sibs = siblingsFound().map((f) => `  { sourceId: ${JSON.stringify(f.model.id)}, row: ${JSON.stringify(f.row)}, table: [${lit(f.table[0])}, ${lit(f.table[1])}], source: [${lit(f.source[0])}, ${lit(f.source[1])}], why: '' },`);
      const unp = unpricedFound().map((id) => `  ${JSON.stringify(id)},`);
      console.log(`__GAPS__\n${gaps.join('\n')}\n__SIBLINGS__\n${sibs.join('\n')}\n__UNPRICED__\n${unp.join('\n')}\n__END__`);
    });
  }
});

describe('reading the source', () => {
  it('perMillion reads a per-token string as dollars per million and nothing else as a rate', () => {
    expect(perMillion('0.0000004')).toBeCloseTo(0.4, 12);
    expect(perMillion('0')).toBe(0);
    for (const bad of [undefined, null, '', '  ', 'free', '-0.000001', 'NaN', 'Infinity', 4e-7]) expect(perMillion(bad), String(bad)).toBeUndefined();
  });

  it('a missing OpenAI write rate reads as the prompt rate, at the base and at the tier; another provider\'s stays absent', () => {
    const openai: SourceModel = { id: 'openai/x', context_length: 1, pricing: { prompt: '0.000001', completion: '0.00001', overrides: [{ min_prompt_tokens: 272_000, prompt: '0.000002' }] } };
    expect(pricingFromSource(openai)).toMatchObject({ cacheWritePerMillion: 1, longPrompt: { overTokens: 272_000, inputPerMillion: 2, cacheWritePerMillion: 2 } });
    const google: SourceModel = { id: 'google/x', context_length: 1, pricing: { prompt: '0.000001', completion: '0.00001' } };
    expect('cacheWritePerMillion' in pricingFromSource(google)).toBe(false);
    const explicit: SourceModel = { id: 'openai/y', context_length: 1, pricing: { prompt: '0.000001', completion: '0.00001', input_cache_write: '0.00000125', overrides: [{ min_prompt_tokens: 272_000, prompt: '0.000002' }] } };
    const e = pricingFromSource(explicit);
    expect(e.cacheWritePerMillion).toBeCloseTo(1.25, 12);
    expect(e.longPrompt?.cacheWritePerMillion, 'a tier that omits its write under an explicit base write inherits it').toBeCloseTo(1.25, 12);
    const unreadable: SourceModel = { id: 'openai/u', context_length: 1, pricing: { prompt: '0.000001', completion: '0.00001', input_cache_write: 'invalid', overrides: [{ min_prompt_tokens: 272_000, prompt: 'invalid' }] } };
    const u = pricingFromSource(unreadable);
    expect('cacheWritePerMillion' in u, 'an unreadable write rate is not read as the prompt rate').toBe(false);
    expect(u.longPrompt?.inputPerMillion, 'an unreadable tier rate does not fall back to the base').toBeUndefined();
    expect(u.unreadable).toEqual(['cacheWritePerMillion', 'longPrompt.inputPerMillion']);
  });

  it('a second override is counted, not read, and a tier rate the override leaves out is the base rate', () => {
    const two: SourceModel = { id: 'openai/z', context_length: 1, pricing: { prompt: '0.000001', completion: '0.00001', input_cache_read: '0.000002', overrides: [{ min_prompt_tokens: 200_000, prompt: '0.000002' }, { min_prompt_tokens: 400_000, prompt: '0.000003' }] } };
    const s = pricingFromSource(two);
    expect(s.furtherTiers).toBe(1);
    expect(s.longPrompt).toMatchObject({ overTokens: 200_000, inputPerMillion: 2, outputPerMillion: 10, cacheReadPerMillion: 2 });
  });

  it('comparePricing compares the threshold exactly and the rates to a millionth, and names a one-sided field', () => {
    const table: TablePricing = { inputPerMillion: 1, outputPerMillion: 10, currency: 'USD', longPrompt: { overTokens: 200_000, inputPerMillion: 2 } };
    expect(comparePricing(table, { inputPerMillion: 1.0000000001, outputPerMillion: 10, longPrompt: { overTokens: 200_000, inputPerMillion: 2, outputPerMillion: 10 }, furtherTiers: 0 })).toEqual([]);
    expect(comparePricing(table, { inputPerMillion: 1, outputPerMillion: 10, longPrompt: { overTokens: 200_001, inputPerMillion: 2, outputPerMillion: 10 }, furtherTiers: 0 })).toEqual([
      { field: 'longPrompt.overTokens', table: 200_000, source: 200_001 },
    ]);
    expect(comparePricing(table, { inputPerMillion: 1, outputPerMillion: 10, cacheReadPerMillion: 0.1, longPrompt: { overTokens: 200_000, inputPerMillion: 2, outputPerMillion: 10 }, furtherTiers: 0 })).toEqual([
      { field: 'cacheReadPerMillion', table: undefined, source: 0.1 },
    ]);
    expect(sameRate(0.0833, 1 / 12)).toBe(false);
  });

  it('prefixNames picks, for every source id and the boundary cases, the row whose rates getDefaultPricing returns', () => {
    const boundary = ['gpt-5.4-2026-03-05', 'gpt-5.40', 'gpt-5.3-codex', 'gpt-5', 'gpt-5-', 'claude-3-5-haiku-20241022', 'gemini-3.1-pro-preview-customtools'];
    for (const id of [...snapshot.models.map((m) => tableIdFor(m.id)), ...boundary]) {
      if (!id) continue;
      const byHelper = PRICING_TABLE.filter((r) => prefixNames(r.prefix, id)).sort((a, b) => b.prefix.length - a.prefix.length)[0];
      const expected = byHelper === undefined || byHelper.pricing === null ? undefined : effective(byHelper.prefix);
      expect(getDefaultPricing(id, AT), `${id}: helper picks ${byHelper?.prefix ?? 'no row'}`).toBe(expected);
    }
  });

  it('RATE_FIELDS names every …PerMillion field of ModelPricing (tsconfig type-checks src/ alone, so this is checked here)', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'types', 'provider.ts'), 'utf8');
    const block = source.slice(source.indexOf('export interface ModelPricing {'));
    const body = block.slice(0, block.indexOf('\n}'));
    const fields = [...body.matchAll(/^\s+(\w+PerMillion)\??: number/gm)].map((m) => m[1]).sort();
    expect(fields.length).toBeGreaterThan(0);
    expect(fields).toEqual([...RATE_FIELDS].sort());
  });

  it('prefixNames is the table\'s rule', () => {
    expect(prefixNames('gpt-5.4', 'gpt-5.4-2026-03-05')).toBe(true);
    expect(prefixNames('gpt-5.4', 'gpt-5.40')).toBe(false);
    expect(prefixNames('gpt-5', 'gpt-5.3-codex')).toBe(true);
    expect(prefixNames('claude-3-', 'claude-3-5')).toBe(true);
  });

  it('tableIdFor and sourceIdFor are each other\'s inverse on the table\'s prefixes (not on every id: a dated or non-gpt id has no prefix)', () => {
    for (const prefix of ['claude-haiku-5-5', 'claude-3-5-haiku', 'gpt-5.4', 'gemini-3.8-flash']) expect(tableIdFor(sourceIdFor(prefix)!)).toBe(prefix);
    expect(tableIdFor('openai/gpt-5:batch')).toBeNull();
    expect(tableIdFor('mistralai/x')).toBeNull();
    expect(tableIdFor('openai/o3')).toBe('o3');
    expect(tableIdFor('google/gemma-3-4b-it')).toBe('gemma-3-4b-it');
  });
});
