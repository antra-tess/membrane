import type { ModelPricing } from '../types/provider.js';

export const DEFAULT_PRICING_LAST_VERIFIED = '2026-08-25';

export const GOOGLE_PRICING_LAST_VERIFIED = '2026-10-14';

export const ANTHROPIC_PRICING_LAST_VERIFIED = '2026-11-18';

/**
 * Google states when a rate changes as a date ("through November 30, 2026",
 * then "starting December 1, 2026"), with no time zone. A day in Cloud
 * Billing's reports starts at midnight US and Canadian Pacific Time
 * (https://cloud.google.com/billing/docs/how-to/reports), so each change is
 * taken to start at Pacific midnight, an inference Google doesn't state.
 * Both dates fall in standard time, UTC-8.
 */
const GOOGLE_FROM_2026_12_01 = '2026-12-01T00:00:00-08:00';
const GOOGLE_FROM_2027_01_01 = '2027-01-01T00:00:00-08:00';

interface PricingChange {
  from: string;
  pricing: ModelPricing;
}

interface PricedRow {
  prefix: string;
  pricing: ModelPricing;
  changes?: readonly PricingChange[];
}

interface UnpricedRow {
  prefix: string;
  pricing: null;
}

type PricingRow = PricedRow | UnpricedRow;

const GEMINI_3_8_FLASH: Omit<PricedRow, 'prefix'> = {
  pricing: { inputPerMillion: 0.75, outputPerMillion: 3.75, cacheReadPerMillion: 0.075, currency: 'USD', asOf: GOOGLE_PRICING_LAST_VERIFIED },
  changes: [
    { from: GOOGLE_FROM_2027_01_01, pricing: { inputPerMillion: 1.50, outputPerMillion: 7.50, cacheReadPerMillion: 0.15, currency: 'USD', asOf: GOOGLE_PRICING_LAST_VERIFIED } },
  ],
};

const GEMINI_3_6_FLASH: Omit<PricedRow, 'prefix'> = {
  pricing: { inputPerMillion: 0.75, outputPerMillion: 3.75, cacheReadPerMillion: 0.075, currency: 'USD', asOf: GOOGLE_PRICING_LAST_VERIFIED },
  changes: [
    { from: GOOGLE_FROM_2027_01_01, pricing: { inputPerMillion: 1.50, outputPerMillion: 7.50, cacheReadPerMillion: 0.15, currency: 'USD', asOf: GOOGLE_PRICING_LAST_VERIFIED } },
  ],
};

export const PRICING_TABLE: readonly PricingRow[] = [
  // Anthropic — https://platform.claude.com/docs/en/about-claude/pricing.
  // `cacheWritePerMillion` is the 5-minute TTL bucket (1.25× input);
  // `cacheWrite1hPerMillion` the 1-hour bucket (2× input), which Anthropic
  // reports separately as `usage.cache_creation.ephemeral_1h_input_tokens`.
  {
    prefix: 'claude-fable-5-2',
    pricing: { inputPerMillion: 8, outputPerMillion: 40, cacheWritePerMillion: 10, cacheWrite1hPerMillion: 16, cacheReadPerMillion: 0.20, currency: 'USD', asOf: ANTHROPIC_PRICING_LAST_VERIFIED },
  },
  {
    prefix: 'claude-mythos-5-2',
    pricing: { inputPerMillion: 8, outputPerMillion: 40, cacheWritePerMillion: 10, cacheWrite1hPerMillion: 16, cacheReadPerMillion: 0.20, currency: 'USD', asOf: ANTHROPIC_PRICING_LAST_VERIFIED },
  },
  {
    prefix: 'claude-fable-5-1',
    pricing: { inputPerMillion: 10, outputPerMillion: 50, cacheWritePerMillion: 12.50, cacheWrite1hPerMillion: 20, cacheReadPerMillion: 0.25, currency: 'USD', asOf: ANTHROPIC_PRICING_LAST_VERIFIED },
  },
  {
    prefix: 'claude-mythos-5-1',
    pricing: { inputPerMillion: 10, outputPerMillion: 50, cacheWritePerMillion: 12.50, cacheWrite1hPerMillion: 20, cacheReadPerMillion: 0.25, currency: 'USD', asOf: ANTHROPIC_PRICING_LAST_VERIFIED },
  },
  {
    prefix: 'claude-mythos-5',
    pricing: { inputPerMillion: 10, outputPerMillion: 50, cacheWritePerMillion: 12.50, cacheWrite1hPerMillion: 20, cacheReadPerMillion: 1, currency: 'USD', asOf: ANTHROPIC_PRICING_LAST_VERIFIED },
  },
  {
    prefix: 'claude-fable-5',
    pricing: { inputPerMillion: 10, outputPerMillion: 50, cacheWritePerMillion: 12.50, cacheWrite1hPerMillion: 20, cacheReadPerMillion: 1, currency: 'USD', asOf: ANTHROPIC_PRICING_LAST_VERIFIED },
  },
  {
    prefix: 'claude-opus-5',
    pricing: { inputPerMillion: 5, outputPerMillion: 25, cacheWritePerMillion: 6.25, cacheWrite1hPerMillion: 10, cacheReadPerMillion: 0.50, currency: 'USD', asOf: ANTHROPIC_PRICING_LAST_VERIFIED },
  },
  {
    prefix: 'claude-opus-5-5',
    pricing: { inputPerMillion: 4, outputPerMillion: 20, cacheWritePerMillion: 5, cacheWrite1hPerMillion: 8, cacheReadPerMillion: 0.20, currency: 'USD', asOf: ANTHROPIC_PRICING_LAST_VERIFIED },
  },
  {
    prefix: 'claude-sonnet-5',
    pricing: { inputPerMillion: 2, outputPerMillion: 10, cacheWritePerMillion: 2.50, cacheWrite1hPerMillion: 4, cacheReadPerMillion: 0.20, currency: 'USD', asOf: ANTHROPIC_PRICING_LAST_VERIFIED },
  },
  {
    prefix: 'claude-sonnet-5-5',
    pricing: { inputPerMillion: 2, outputPerMillion: 10, cacheWritePerMillion: 2.50, cacheWrite1hPerMillion: 4, cacheReadPerMillion: 0.10, currency: 'USD', asOf: ANTHROPIC_PRICING_LAST_VERIFIED },
  },
  {
    prefix: 'claude-opus-4-8',
    pricing: { inputPerMillion: 5, outputPerMillion: 25, cacheWritePerMillion: 6.25, cacheWrite1hPerMillion: 10, cacheReadPerMillion: 0.50, currency: 'USD', asOf: ANTHROPIC_PRICING_LAST_VERIFIED },
  },
  {
    prefix: 'claude-opus-4-7',
    pricing: { inputPerMillion: 5, outputPerMillion: 25, cacheWritePerMillion: 6.25, cacheWrite1hPerMillion: 10, cacheReadPerMillion: 0.50, currency: 'USD', asOf: ANTHROPIC_PRICING_LAST_VERIFIED },
  },
  {
    prefix: 'claude-opus-4-6',
    pricing: { inputPerMillion: 5, outputPerMillion: 25, cacheWritePerMillion: 6.25, cacheWrite1hPerMillion: 10, cacheReadPerMillion: 0.50, currency: 'USD', asOf: ANTHROPIC_PRICING_LAST_VERIFIED },
  },
  {
    prefix: 'claude-opus-4-5',
    pricing: { inputPerMillion: 5, outputPerMillion: 25, cacheWritePerMillion: 6.25, cacheWrite1hPerMillion: 10, cacheReadPerMillion: 0.50, currency: 'USD', asOf: ANTHROPIC_PRICING_LAST_VERIFIED },
  },
  {
    // Retired except on Bedrock and Google Cloud; also covers Opus 4.1, which
    // is priced identically.
    prefix: 'claude-opus-4',
    pricing: { inputPerMillion: 15, outputPerMillion: 75, cacheWritePerMillion: 18.75, cacheWrite1hPerMillion: 30, cacheReadPerMillion: 1.50, currency: 'USD', asOf: ANTHROPIC_PRICING_LAST_VERIFIED },
  },
  {
    prefix: 'claude-sonnet-4-6',
    pricing: { inputPerMillion: 3, outputPerMillion: 15, cacheWritePerMillion: 3.75, cacheWrite1hPerMillion: 6, cacheReadPerMillion: 0.30, currency: 'USD', asOf: ANTHROPIC_PRICING_LAST_VERIFIED },
  },
  {
    prefix: 'claude-sonnet-4-5',
    pricing: { inputPerMillion: 3, outputPerMillion: 15, cacheWritePerMillion: 3.75, cacheWrite1hPerMillion: 6, cacheReadPerMillion: 0.30, currency: 'USD', asOf: ANTHROPIC_PRICING_LAST_VERIFIED },
  },
  {
    // Retired except on Bedrock and Google Cloud.
    prefix: 'claude-sonnet-4',
    pricing: { inputPerMillion: 3, outputPerMillion: 15, cacheWritePerMillion: 3.75, cacheWrite1hPerMillion: 6, cacheReadPerMillion: 0.30, currency: 'USD', asOf: ANTHROPIC_PRICING_LAST_VERIFIED },
  },
  {
    // Priced by prompt length: over 100,000 tokens — counting cache reads and
    // writes, each request on its own — every rate rises. Both rows are on the
    // page.
    prefix: 'claude-haiku-5-5',
    pricing: {
      inputPerMillion: 0.10, outputPerMillion: 0.50, cacheWritePerMillion: 0.125, cacheWrite1hPerMillion: 0.2, cacheReadPerMillion: 0.01, currency: 'USD', asOf: ANTHROPIC_PRICING_LAST_VERIFIED,
      longPrompt: { overTokens: 100_000, inputPerMillion: 0.50, outputPerMillion: 2.50, cacheWritePerMillion: 0.625, cacheWrite1hPerMillion: 1, cacheReadPerMillion: 0.05 },
    },
  },
  {
    prefix: 'claude-haiku-4-5',
    pricing: { inputPerMillion: 1, outputPerMillion: 5, cacheWritePerMillion: 1.25, cacheWrite1hPerMillion: 2, cacheReadPerMillion: 0.10, currency: 'USD', asOf: ANTHROPIC_PRICING_LAST_VERIFIED },
  },
  {
    // Retired except on Bedrock and Google Cloud; no longer on the page. The
    // 1-hour rate is the page's figure from the last copy that listed it.
    prefix: 'claude-3-5-haiku',
    pricing: { inputPerMillion: 0.80, outputPerMillion: 4, cacheWritePerMillion: 1, cacheWrite1hPerMillion: 1.6, cacheReadPerMillion: 0.08, currency: 'USD', asOf: '2026-10-19' },
  },
  {
    // Fully retired: the last published rate, not a current one. No 1-hour
    // rate was ever read from the page for it, so none is given here.
    prefix: 'claude-3-5-sonnet',
    pricing: { inputPerMillion: 3, outputPerMillion: 15, cacheWritePerMillion: 3.75, cacheReadPerMillion: 0.30, currency: 'USD', asOf: '2025-07-01' },
  },

  // OpenAI — https://platform.openai.com/docs/pricing (standard tier).
  // "Cached input" is OpenAI's rate for the automatically cached prompt prefix.
  {
    prefix: 'gpt-6-astra',
    pricing: { inputPerMillion: 10, outputPerMillion: 50, cacheReadPerMillion: 1.00, currency: 'USD', asOf: '2026-09-06' },
  },
  {
    prefix: 'gpt-5.6-sol',
    pricing: { inputPerMillion: 4, outputPerMillion: 20, cacheReadPerMillion: 0.40, currency: 'USD', asOf: DEFAULT_PRICING_LAST_VERIFIED },
  },
  {
    prefix: 'gpt-5.6-terra',
    pricing: { inputPerMillion: 2, outputPerMillion: 12, cacheReadPerMillion: 0.20, currency: 'USD', asOf: DEFAULT_PRICING_LAST_VERIFIED },
  },
  {
    prefix: 'gpt-5.6-luna',
    pricing: { inputPerMillion: 0.20, outputPerMillion: 1.20, cacheReadPerMillion: 0.02, currency: 'USD', asOf: DEFAULT_PRICING_LAST_VERIFIED },
  },
  {
    // The model page: "prompts with >272K input tokens are priced at 2x input
    // and 1.5x output". It states no long-context rate for cached input, so
    // that one stays at the base rate.
    prefix: 'gpt-5.5',
    pricing: {
      inputPerMillion: 5, outputPerMillion: 30, cacheReadPerMillion: 0.50, currency: 'USD', asOf: DEFAULT_PRICING_LAST_VERIFIED,
      longPrompt: { overTokens: 272_000, inputPerMillion: 10, outputPerMillion: 45 },
    },
  },
  {
    prefix: 'gpt-5.4-mini',
    pricing: { inputPerMillion: 0.75, outputPerMillion: 4.50, cacheReadPerMillion: 0.075, currency: 'USD', asOf: DEFAULT_PRICING_LAST_VERIFIED },
  },
  {
    prefix: 'gpt-5.4-nano',
    pricing: { inputPerMillion: 0.20, outputPerMillion: 1.25, cacheReadPerMillion: 0.02, currency: 'USD', asOf: DEFAULT_PRICING_LAST_VERIFIED },
  },
  {
    // The model page: "prompts with >272K input tokens are priced at 2x input
    // and 1.5x output", as for gpt-5.5; no long-context rate for cached input.
    prefix: 'gpt-5.4',
    pricing: {
      inputPerMillion: 2.50, outputPerMillion: 15, cacheReadPerMillion: 0.25, currency: 'USD', asOf: DEFAULT_PRICING_LAST_VERIFIED,
      longPrompt: { overTokens: 272_000, inputPerMillion: 5, outputPerMillion: 22.50 },
    },
  },
  {
    prefix: 'gpt-5.2',
    pricing: { inputPerMillion: 1.75, outputPerMillion: 14, cacheReadPerMillion: 0.175, currency: 'USD', asOf: DEFAULT_PRICING_LAST_VERIFIED },
  },
  {
    prefix: 'gpt-5.1',
    pricing: { inputPerMillion: 1.25, outputPerMillion: 10, cacheReadPerMillion: 0.125, currency: 'USD', asOf: DEFAULT_PRICING_LAST_VERIFIED },
  },
  {
    prefix: 'gpt-5-mini',
    pricing: { inputPerMillion: 0.25, outputPerMillion: 2, cacheReadPerMillion: 0.025, currency: 'USD', asOf: DEFAULT_PRICING_LAST_VERIFIED },
  },
  {
    prefix: 'gpt-5-nano',
    pricing: { inputPerMillion: 0.05, outputPerMillion: 0.40, cacheReadPerMillion: 0.005, currency: 'USD', asOf: DEFAULT_PRICING_LAST_VERIFIED },
  },
  {
    prefix: 'gpt-5',
    pricing: { inputPerMillion: 1.25, outputPerMillion: 10, cacheReadPerMillion: 0.125, currency: 'USD', asOf: DEFAULT_PRICING_LAST_VERIFIED },
  },
  {
    prefix: 'gpt-4o-mini',
    pricing: { inputPerMillion: 0.15, outputPerMillion: 0.60, cacheReadPerMillion: 0.075, currency: 'USD', asOf: DEFAULT_PRICING_LAST_VERIFIED },
  },
  {
    prefix: 'gpt-4o-2024-05-13',
    pricing: { inputPerMillion: 5, outputPerMillion: 15, currency: 'USD', asOf: DEFAULT_PRICING_LAST_VERIFIED },
  },
  {
    prefix: 'gpt-4o',
    pricing: { inputPerMillion: 2.50, outputPerMillion: 10, cacheReadPerMillion: 1.25, currency: 'USD', asOf: DEFAULT_PRICING_LAST_VERIFIED },
  },

  // Google — https://ai.google.dev/gemini-api/docs/pricing (paid tier,
  // Standard), and https://ai.google.dev/gemini-api/docs/deprecations. Google's
  // published output price INCLUDES thinking tokens. Cache rates are the
  // context-caching per-token price and exclude Google's separate per-hour
  // storage charge. Where a model has a >200k-token tier it is the row's
  // `longPrompt`. Where input costs more for audio, the text rate is used.
  {
    // Google: "Implicit caching only (explicit caching is not supported)", so
    // the context-caching price is what an implicitly cached span costs.
    prefix: 'gemini-4-argon',
    pricing: { inputPerMillion: 2, outputPerMillion: 10, cacheReadPerMillion: 0.10, currency: 'USD', asOf: GOOGLE_PRICING_LAST_VERIFIED },
    changes: [
      { from: GOOGLE_FROM_2026_12_01, pricing: { inputPerMillion: 4, outputPerMillion: 20, cacheReadPerMillion: 0.20, currency: 'USD', asOf: GOOGLE_PRICING_LAST_VERIFIED } },
    ],
  },
  {
    prefix: 'gemini-3.8-flash',
    ...GEMINI_3_8_FLASH,
  },
  {
    // Deprecated: Google routes every request for it to gemini-3.8-flash.
    prefix: 'gemini-3.7-flash',
    ...GEMINI_3_8_FLASH,
  },
  {
    prefix: 'gemini-3.6-flash',
    ...GEMINI_3_6_FLASH,
  },
  {
    // Deprecated: Google routes every request for it to gemini-3.6-flash.
    prefix: 'gemini-3.5-flash',
    ...GEMINI_3_6_FLASH,
  },
  {
    prefix: 'gemini-3.5-flash-lite',
    pricing: { inputPerMillion: 0.30, outputPerMillion: 2.50, cacheReadPerMillion: 0.03, currency: 'USD', asOf: GOOGLE_PRICING_LAST_VERIFIED },
  },
  {
    // Also covers gemini-3.1-pro-preview-customtools, priced the same.
    prefix: 'gemini-3.1-pro-preview',
    pricing: {
      inputPerMillion: 2, outputPerMillion: 12, cacheReadPerMillion: 0.20, currency: 'USD', asOf: GOOGLE_PRICING_LAST_VERIFIED,
      longPrompt: { overTokens: 200_000, inputPerMillion: 4, outputPerMillion: 18, cacheReadPerMillion: 0.40 },
    },
  },
  {
    prefix: 'gemini-3.1-flash-lite',
    pricing: { inputPerMillion: 0.25, outputPerMillion: 1.50, cacheReadPerMillion: 0.025, currency: 'USD', asOf: GOOGLE_PRICING_LAST_VERIFIED },
  },
  {
    prefix: 'gemini-3-flash-preview',
    pricing: { inputPerMillion: 0.50, outputPerMillion: 3, cacheReadPerMillion: 0.05, currency: 'USD', asOf: GOOGLE_PRICING_LAST_VERIFIED },
  },
  {
    prefix: 'gemini-2.5-pro',
    pricing: {
      inputPerMillion: 1.25, outputPerMillion: 10, cacheReadPerMillion: 0.125, currency: 'USD', asOf: GOOGLE_PRICING_LAST_VERIFIED,
      longPrompt: { overTokens: 200_000, inputPerMillion: 2.50, outputPerMillion: 15, cacheReadPerMillion: 0.25 },
    },
  },
  {
    prefix: 'gemini-2.5-flash-lite',
    pricing: { inputPerMillion: 0.10, outputPerMillion: 0.40, cacheReadPerMillion: 0.01, currency: 'USD', asOf: GOOGLE_PRICING_LAST_VERIFIED },
  },
  {
    prefix: 'gemini-2.5-flash',
    pricing: { inputPerMillion: 0.30, outputPerMillion: 2.50, cacheReadPerMillion: 0.03, currency: 'USD', asOf: GOOGLE_PRICING_LAST_VERIFIED },
  },
  // Ids a text model's row above would otherwise price as text. An image
  // model's output is priced by modality, images far above text, and one
  // output rate can't hold both. A speech model's output is audio, priced at
  // its own rate. The native-audio model is a Live API model, its output
  // priced by modality too.
  { prefix: 'gemini-3.8-flash-tts', pricing: null },
  { prefix: 'gemini-3.8-flash-lite-tts', pricing: null },
  { prefix: 'gemini-3.1-flash-lite-image', pricing: null },
  { prefix: 'gemini-2.5-flash-image', pricing: null },
  { prefix: 'gemini-2.5-flash-preview-tts', pricing: null },
  { prefix: 'gemini-2.5-flash-native-audio', pricing: null },
  { prefix: 'gemini-2.5-pro-preview-tts', pricing: null },
];

/**
 * Whether `prefix` names `modelId`: the id is the prefix, or goes on from it
 * with anything but a digit, unless the prefix itself ends in `-`. So
 * `claude-fable-5` names `claude-fable-5-20260301`, and `claude-fable-5-2`
 * doesn't.
 */
function prefixNames(prefix: string, modelId: string): boolean {
  if (!modelId.startsWith(prefix)) return false;
  return prefix.endsWith('-') || !/^\d/.test(modelId.slice(prefix.length));
}

export function getDefaultPricing(modelId: string, at: number = Date.now()): ModelPricing | undefined {
  let best: PricingRow | undefined;
  for (const row of PRICING_TABLE) {
    if (prefixNames(row.prefix, modelId) && row.prefix.length > (best?.prefix.length ?? 0)) {
      best = row;
    }
  }
  if (best === undefined || best.pricing === null) return undefined;

  let pricing = best.pricing;
  for (const change of best.changes ?? []) {
    if (Date.parse(change.from) <= at) pricing = change.pricing;
  }
  return pricing;
}
