#!/usr/bin/env node
// Refresh tests/fixtures/openrouter-models.json, the snapshot of OpenRouter's
// public model list that tests/unit/default-pricing-source.test.ts checks the
// built-in pricing table against (#270).
//
//   node scripts/pricing-source.mjs                             # fetch and write the snapshot, read now
//   node scripts/pricing-source.mjs --stdin --read-at INSTANT   # a saved response from stdin, read at INSTANT (ISO 8601 with a time)
//
// The snapshot keeps, for each model under the three providers the table
// prices, only what the table has a field for: the per-token rates, the
// long-prompt overrides and the context length. OpenRouter is not the
// authority — each provider's own pricing page is — but it carries every
// field the table has in one shape, so a divergence between the two is
// visible in a test rather than found by reading pages. Refreshing the
// snapshot is the one hand step, and it is a diff to review.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = 'https://openrouter.ai/api/v1/models';
const PROVIDERS = ['anthropic/', 'openai/', 'google/'];
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'openrouter-models.json');

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const known = new Set(['--stdin', '--read-at']);
for (const f of flags) if (!known.has(f)) fail(2, `unknown option ${f}; the options are --stdin and --read-at INSTANT`);
const fromStdin = flags.has('--stdin');
if (args.filter((a) => a === '--read-at').length > 1) fail(2, '--read-at given twice; give the one instant the saved response was read at');
const readAtIndex = args.indexOf('--read-at');
const readAtArg = readAtIndex === -1 ? undefined : args[readAtIndex + 1];
if (readAtIndex !== -1 && !fromStdin) fail(2, '--read-at goes with --stdin: a fetched list is read now');
if (fromStdin && (readAtArg === undefined || readAtArg.startsWith('--'))) fail(2, '--stdin needs --read-at INSTANT: when the saved response was read, as an ISO 8601 instant in UTC (2026-11-20T14:05:00Z)');
if (fromStdin && !isInstant(readAtArg)) fail(2, `--read-at ${readAtArg} isn't an ISO 8601 instant in UTC (2026-11-20T14:05:00Z); the date alone can't place the read on either side of a provider's scheduled change`);
if (args.some((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1] === '--read-at'))) fail(2, 'a positional argument: the options are --stdin and --read-at INSTANT');

function fail(code, message) { console.error(message); process.exit(code); }
/** An ISO 8601 instant in UTC (2026-11-20T14:05:00Z) that comes back as itself: no 2026-02-30. */
function isInstant(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/.test(s)) return false;
  const ms = Date.parse(s);
  return Number.isFinite(ms) && new Date(ms).toISOString().startsWith(s.slice(0, 16));
}

async function readList() {
  if (fromStdin) {
    process.stdin.setEncoding('utf8');
    let text = '';
    for await (const chunk of process.stdin) text += chunk;
    return JSON.parse(text);
  }
  const response = await fetch(SOURCE);
  if (!response.ok) throw new Error(`${SOURCE}: HTTP ${response.status}`);
  return response.json();
}

const RATE_KEYS = ['prompt', 'completion', 'input_cache_read', 'input_cache_write', 'input_cache_write_1h'];

function trimPricing(id, pricing) {
  const out = {};
  for (const key of RATE_KEYS) if (pricing?.[key] !== undefined) out[key] = pricing[key];
  if (Array.isArray(pricing?.overrides)) {
    const tiers = [];
    for (const o of pricing.overrides) {
      if (o === null || typeof o !== 'object' || typeof o.min_prompt_tokens !== 'number') {
        // An override the table has no field for (not a prompt-length tier): said, not kept.
        console.error(`${id}: an override without min_prompt_tokens is left out: ${JSON.stringify(o)}`);
        continue;
      }
      const t = { min_prompt_tokens: o.min_prompt_tokens };
      for (const key of RATE_KEYS) if (o[key] !== undefined) t[key] = o[key];
      tiers.push(t);
    }
    if (tiers.length > 0) out.overrides = tiers;
  }
  return out;
}

const readAt = fromStdin ? new Date(Date.parse(readAtArg)).toISOString() : new Date().toISOString();
const list = await readList();
if (!Array.isArray(list?.data)) fail(1, `the response has no model list (${JSON.stringify(list).slice(0, 200)}); the snapshot is left as it was`);
const models = list.data
  .filter((m) => typeof m?.id === 'string' && PROVIDERS.some((p) => m.id.startsWith(p)))
  .map((m) => ({ id: m.id, context_length: m.context_length ?? null, pricing: trimPricing(m.id, m.pricing) }))
  .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)); // JavaScript's string order (UTF-16 code units), the same on every host
for (const provider of PROVIDERS) {
  if (!models.some((m) => m.id.startsWith(provider))) fail(1, `the response has no ${provider} model among its ${list.data.length}; the snapshot is left as it was`);
}

const snapshot = { source: SOURCE, readAt, models };
writeFileSync(OUT, `${JSON.stringify(snapshot, null, 2)}\n`);
console.log(`${models.length} models written to ${OUT} (read ${snapshot.readAt})`);
