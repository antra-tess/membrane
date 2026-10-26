import type { ModelPricing } from '../types/provider.js';

/**
 * Built-in pricing table for known models, in USD per million tokens.
 * Used as fallback when no ModelRegistry is configured; registry pricing
 * (if available) takes precedence.
 *
 * Every row carries its OWN verification date through `ModelPricing.asOf`, out
 * to `CostBreakdown.pricingAsOf`, so a caller can see how old the number it is
 * billing against is instead of trusting a prose header. Currently-published
 * rows were read off the provider's own price page on the date their section
 * names, unless the row gives a later date of its own (each section's comment
 * names the page): Anthropic's on {@link ANTHROPIC_PRICING_LAST_VERIFIED},
 * OpenAI's on {@link DEFAULT_PRICING_LAST_VERIFIED} and Google's on
 * {@link GOOGLE_PRICING_LAST_VERIFIED}. A row for a RETIRED model carries the
 * date its rate was last published instead — claude-3-5-sonnet is dated
 * 2025-07-01 because it is no longer listed anywhere to verify against, and
 * stamping it with the sweep date would claim a check that cannot be
 * performed. The previous header claimed "Last updated: 2025-07" for the whole
 * table while it carried Claude 4.6 rows, and three rows were simply wrong by
 * the time they were checked.
 *
 * A provider can publish a rate together with the date it changes, such as an
 * introductory price "through November 30, 2026" and the next "starting
 * December 1, 2026". Such a row lists each later rate in `changes`, from the
 * instant it takes effect, so while the provider keeps the dates it published,
 * the table stays right across them with no edit and no release, for a caller
 * still running this version then. `asOf` stays the date the rates were read:
 * it says how old the reading is, not which rate applies.
 *
 * A row whose `pricing` is null says the table has no rate for ids under its
 * prefix, though a shorter prefix matches them: an image model, for one, whose
 * output a text model's row would underprice. Such an id reads as unpriced, as
 * one no row matches does.
 *
 * Matching is longest-prefix (see {@link getDefaultPricing}), so a more
 * specific row always wins over a more general one and rows may be listed in
 * any order.
 */

/** The date the OpenAI section's rows were read off OpenAI's price page. */
export const DEFAULT_PRICING_LAST_VERIFIED = '2026-08-25';

/** The date the Google section's rows were read off Google's price page. */
export const GOOGLE_PRICING_LAST_VERIFIED = '2026-10-14';

/** The date the Anthropic section's rows were read off Anthropic's price page. */
export const ANTHROPIC_PRICING_LAST_VERIFIED = '2026-10-19';

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

/**
 * A published change to a row's rate: from the instant `from` (ISO 8601, with
 * its offset), `pricing` replaces the row's own rate and every earlier change.
 */
interface PricingChange {
  from: string;
  pricing: ModelPricing;
}

/** A row with a rate, and any later rates the provider has published. */
interface PricedRow {
  prefix: string;
  /** The rate until the first change, or for good when there is none. */
  pricing: ModelPricing;
  /** The later rates, in ascending order of `from`. */
  changes?: readonly PricingChange[];
}

/** A row saying the table has no rate for ids under its prefix, though a shorter prefix matches them. */
interface UnpricedRow {
  prefix: string;
  pricing: null;
}

type PricingRow = PricedRow | UnpricedRow;

/** Gemini 3.8 Flash's rate, which gemini-3.7-flash's row shares. */
const GEMINI_3_8_FLASH: Omit<PricedRow, 'prefix'> = {
  pricing: { inputPerMillion: 0.75, outputPerMillion: 3.75, cacheReadPerMillion: 0.075, currency: 'USD', asOf: GOOGLE_PRICING_LAST_VERIFIED },
  changes: [
    { from: GOOGLE_FROM_2027_01_01, pricing: { inputPerMillion: 1.50, outputPerMillion: 7.50, cacheReadPerMillion: 0.15, currency: 'USD', asOf: GOOGLE_PRICING_LAST_VERIFIED } },
  ],
};

/** Gemini 3.6 Flash's rate, which gemini-3.5-flash's row shares. */
const GEMINI_3_6_FLASH: Omit<PricedRow, 'prefix'> = {
  pricing: { inputPerMillion: 0.75, outputPerMillion: 3.75, cacheReadPerMillion: 0.075, currency: 'USD', asOf: GOOGLE_PRICING_LAST_VERIFIED },
  changes: [
    { from: GOOGLE_FROM_2027_01_01, pricing: { inputPerMillion: 1.50, outputPerMillion: 7.50, cacheReadPerMillion: 0.15, currency: 'USD', asOf: GOOGLE_PRICING_LAST_VERIFIED } },
  ],
};

export const PRICING_TABLE: readonly PricingRow[] = [
  // Anthropic — https://platform.claude.com/docs/en/about-claude/pricing.
  // The cache-write column is the 5-minute TTL bucket; the 1-hour bucket costs
  // more and this table has no field for it.
  {
    // Fable 5.1 and Mythos 5.1 read their cache at 0.025x, a quarter of the
    // 5 pair's rate.
    prefix: 'claude-fable-5-1',
    pricing: { inputPerMillion: 10, outputPerMillion: 50, cacheWritePerMillion: 12.50, cacheReadPerMillion: 0.25, currency: 'USD', asOf: ANTHROPIC_PRICING_LAST_VERIFIED },
  },
  {
    prefix: 'claude-mythos-5-1',
    pricing: { inputPerMillion: 10, outputPerMillion: 50, cacheWritePerMillion: 12.50, cacheReadPerMillion: 0.25, currency: 'USD', asOf: ANTHROPIC_PRICING_LAST_VERIFIED },
  },
  {
    // Mythos 5 prices as Fable 5 does.
    prefix: 'claude-mythos-5',
    pricing: { inputPerMillion: 10, outputPerMillion: 50, cacheWritePerMillion: 12.50, cacheReadPerMillion: 1, currency: 'USD', asOf: ANTHROPIC_PRICING_LAST_VERIFIED },
  },
  {
    prefix: 'claude-fable-5',
    pricing: { inputPerMillion: 10, outputPerMillion: 50, cacheWritePerMillion: 12.50, cacheReadPerMillion: 1, currency: 'USD', asOf: ANTHROPIC_PRICING_LAST_VERIFIED },
  },
  {
    prefix: 'claude-opus-5',
    pricing: { inputPerMillion: 5, outputPerMillion: 25, cacheWritePerMillion: 6.25, cacheReadPerMillion: 0.50, currency: 'USD', asOf: ANTHROPIC_PRICING_LAST_VERIFIED },
  },
  {
    // Opus 5.5 reads its cache at 0.05x.
    prefix: 'claude-opus-5-5',
    pricing: { inputPerMillion: 4, outputPerMillion: 20, cacheWritePerMillion: 5, cacheReadPerMillion: 0.20, currency: 'USD', asOf: ANTHROPIC_PRICING_LAST_VERIFIED },
  },
  {
    prefix: 'claude-sonnet-5',
    pricing: { inputPerMillion: 2, outputPerMillion: 10, cacheWritePerMillion: 2.50, cacheReadPerMillion: 0.20, currency: 'USD', asOf: ANTHROPIC_PRICING_LAST_VERIFIED },
  },
  {
    // Sonnet 5.5 reads its cache at 0.05x.
    prefix: 'claude-sonnet-5-5',
    pricing: { inputPerMillion: 2, outputPerMillion: 10, cacheWritePerMillion: 2.50, cacheReadPerMillion: 0.10, currency: 'USD', asOf: ANTHROPIC_PRICING_LAST_VERIFIED },
  },
  // Opus 4.5 through 4.8 all price identically to Opus 5.
  {
    prefix: 'claude-opus-4-8',
    pricing: { inputPerMillion: 5, outputPerMillion: 25, cacheWritePerMillion: 6.25, cacheReadPerMillion: 0.50, currency: 'USD', asOf: ANTHROPIC_PRICING_LAST_VERIFIED },
  },
  {
    prefix: 'claude-opus-4-7',
    pricing: { inputPerMillion: 5, outputPerMillion: 25, cacheWritePerMillion: 6.25, cacheReadPerMillion: 0.50, currency: 'USD', asOf: ANTHROPIC_PRICING_LAST_VERIFIED },
  },
  {
    // Was priced here at 15/75 — the retired Opus 4 rate, 3x the real one.
    prefix: 'claude-opus-4-6',
    pricing: { inputPerMillion: 5, outputPerMillion: 25, cacheWritePerMillion: 6.25, cacheReadPerMillion: 0.50, currency: 'USD', asOf: ANTHROPIC_PRICING_LAST_VERIFIED },
  },
  {
    prefix: 'claude-opus-4-5',
    pricing: { inputPerMillion: 5, outputPerMillion: 25, cacheWritePerMillion: 6.25, cacheReadPerMillion: 0.50, currency: 'USD', asOf: ANTHROPIC_PRICING_LAST_VERIFIED },
  },
  {
    // Retired except on Bedrock and Google Cloud; also covers Opus 4.1, which
    // is priced identically.
    prefix: 'claude-opus-4',
    pricing: { inputPerMillion: 15, outputPerMillion: 75, cacheWritePerMillion: 18.75, cacheReadPerMillion: 1.50, currency: 'USD', asOf: ANTHROPIC_PRICING_LAST_VERIFIED },
  },
  {
    prefix: 'claude-sonnet-4-6',
    pricing: { inputPerMillion: 3, outputPerMillion: 15, cacheWritePerMillion: 3.75, cacheReadPerMillion: 0.30, currency: 'USD', asOf: ANTHROPIC_PRICING_LAST_VERIFIED },
  },
  {
    prefix: 'claude-sonnet-4-5',
    pricing: { inputPerMillion: 3, outputPerMillion: 15, cacheWritePerMillion: 3.75, cacheReadPerMillion: 0.30, currency: 'USD', asOf: ANTHROPIC_PRICING_LAST_VERIFIED },
  },
  {
    // Retired except on Bedrock and Google Cloud.
    prefix: 'claude-sonnet-4',
    pricing: { inputPerMillion: 3, outputPerMillion: 15, cacheWritePerMillion: 3.75, cacheReadPerMillion: 0.30, currency: 'USD', asOf: ANTHROPIC_PRICING_LAST_VERIFIED },
  },
  {
    // Prompts up to 100,000 tokens. Over that, Haiku 5.5 costs $0.50 input,
    // $2.50 output, $0.625 for a 5-minute write and $0.05 for a hit, and this
    // table has no field for a prompt-length tier, so a longer prompt is priced
    // low.
    prefix: 'claude-haiku-5-5',
    pricing: { inputPerMillion: 0.10, outputPerMillion: 0.50, cacheWritePerMillion: 0.125, cacheReadPerMillion: 0.01, currency: 'USD', asOf: ANTHROPIC_PRICING_LAST_VERIFIED },
  },
  {
    // Was priced here at 0.80/4 — the retired Haiku 3.5 rate.
    prefix: 'claude-haiku-4-5',
    pricing: { inputPerMillion: 1, outputPerMillion: 5, cacheWritePerMillion: 1.25, cacheReadPerMillion: 0.10, currency: 'USD', asOf: ANTHROPIC_PRICING_LAST_VERIFIED },
  },
  {
    // Retired except on Bedrock and Google Cloud.
    prefix: 'claude-3-5-haiku',
    pricing: { inputPerMillion: 0.80, outputPerMillion: 4, cacheWritePerMillion: 1, cacheReadPerMillion: 0.08, currency: 'USD', asOf: ANTHROPIC_PRICING_LAST_VERIFIED },
  },
  {
    // Fully retired: the last published rate, not a current one.
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
    // Under 272K context; the long-context tier costs more and this table has
    // no field for context-dependent rates.
    prefix: 'gpt-5.5',
    pricing: { inputPerMillion: 5, outputPerMillion: 30, cacheReadPerMillion: 0.50, currency: 'USD', asOf: DEFAULT_PRICING_LAST_VERIFIED },
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
    // Under 272K context.
    prefix: 'gpt-5.4',
    pricing: { inputPerMillion: 2.50, outputPerMillion: 15, cacheReadPerMillion: 0.25, currency: 'USD', asOf: DEFAULT_PRICING_LAST_VERIFIED },
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
    // The one gpt-4o snapshot priced differently from plain gpt-4o. Replaces a
    // `gpt-4o-2024` row that was byte-identical to gpt-4o and so could never
    // change any answer — while masking this genuine difference.
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
  // storage charge. Where a model has a >200k-token tier the smaller-prompt
  // rate is used, so a longer prompt is underpriced. Where input costs more
  // for audio, the text rate is used.
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
    // Introductory through December 31, 2026, then double.
    prefix: 'gemini-3.8-flash',
    ...GEMINI_3_8_FLASH,
  },
  {
    // Deprecated: Google routes every request for it to gemini-3.8-flash.
    prefix: 'gemini-3.7-flash',
    ...GEMINI_3_8_FLASH,
  },
  {
    // Introductory through December 31, 2026, then double.
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
    // Prompts of 200k tokens or fewer; above that, 4/18 and 0.40 for cache
    // reads. Also covers gemini-3.1-pro-preview-customtools, priced the same.
    prefix: 'gemini-3.1-pro-preview',
    pricing: { inputPerMillion: 2, outputPerMillion: 12, cacheReadPerMillion: 0.20, currency: 'USD', asOf: GOOGLE_PRICING_LAST_VERIFIED },
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
    // Prompts of 200k tokens or fewer; above that, 2.50/15 and 0.25 for
    // cache reads.
    prefix: 'gemini-2.5-pro',
    pricing: { inputPerMillion: 1.25, outputPerMillion: 10, cacheReadPerMillion: 0.125, currency: 'USD', asOf: GOOGLE_PRICING_LAST_VERIFIED },
  },
  {
    // Was absent, so the gemini-2.5-flash row priced it at 3x input / 6x output.
    prefix: 'gemini-2.5-flash-lite',
    pricing: { inputPerMillion: 0.10, outputPerMillion: 0.40, cacheReadPerMillion: 0.01, currency: 'USD', asOf: GOOGLE_PRICING_LAST_VERIFIED },
  },
  {
    // Was priced here at 0.15/0.60 — text rate; audio input costs more.
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
 * The table's rate for `modelId` at the instant `at`, in epoch milliseconds:
 * the row with the longest prefix of the id, then the last of its changes in
 * effect by `at`, or else the row's own rate. Undefined when no row matches,
 * or when the row that matches has no rate.
 *
 * `at` defaults to `Date.now()`, membrane's clock, read when membrane prices:
 * once a call's response is in, or once a round of a turn ends. So each round
 * of a turn that crosses a change is priced at the rate of its own end, a call
 * in flight across a change takes the later rate, and a call's or turn's
 * discarded attempts (refusals and retries), priced together when it ends,
 * take the rate of that moment.
 */
export function getDefaultPricing(modelId: string, at: number = Date.now()): ModelPricing | undefined {
  let best: PricingRow | undefined;
  for (const row of PRICING_TABLE) {
    if (modelId.startsWith(row.prefix) && row.prefix.length > (best?.prefix.length ?? 0)) {
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
