#!/usr/bin/env node
// Refresh tests/fixtures/openrouter-models.json, the snapshot of OpenRouter's
// public model list that tests/unit/default-pricing-source.test.ts checks the
// built-in pricing table against (#270).
//
//   node scripts/pricing-source.mjs                          # fetch and write the snapshot, dated today
//   node scripts/pricing-source.mjs --stdin --read-at DATE   # a saved response from stdin, dated when it was read
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
const fromStdin = args.includes('--stdin');
const readAtArg = args[args.indexOf('--read-at') + 1];
if (fromStdin && !/^\d{4}-\d{2}-\d{2}$/.test(readAtArg ?? '')) {
  console.error('--stdin needs --read-at YYYY-MM-DD: the date the saved response was read, not today');
  process.exit(2);
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
      if (typeof o.min_prompt_tokens !== 'number') {
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

const list = await readList();
if (!Array.isArray(list?.data) || list.data.length === 0) {
  console.error(`the response has no model list (${JSON.stringify(list).slice(0, 200)}); the snapshot is left as it was`);
  process.exit(1);
}
const models = list.data
  .filter((m) => PROVIDERS.some((p) => m.id.startsWith(p)))
  .map((m) => ({ id: m.id, context_length: m.context_length ?? null, pricing: trimPricing(m.id, m.pricing) }))
  .sort((a, b) => a.id.localeCompare(b.id));

const snapshot = { source: SOURCE, readAt: fromStdin ? readAtArg : new Date().toISOString().slice(0, 10), models };
writeFileSync(OUT, `${JSON.stringify(snapshot, null, 2)}\n`);
console.log(`${models.length} models written to ${OUT} (read ${snapshot.readAt})`);
