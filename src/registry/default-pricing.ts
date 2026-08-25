import type { ModelPricing } from '../types/provider.js';

/**
 * Built-in pricing table for known models, in USD per million tokens.
 * Used as fallback when no ModelRegistry is configured; registry pricing
 * (if available) takes precedence.
 *
 * Every row below was read off the provider's own public price page on the
 * date in {@link DEFAULT_PRICING_LAST_VERIFIED}; the per-section comments name
 * the page. Rows carry that date through `ModelPricing.asOf` and out to
 * `CostBreakdown.pricingAsOf`, so a caller can see how old the number it is
 * billing against is instead of trusting a prose header. The previous header
 * claimed "Last updated: 2025-07" while the table carried Claude 4.6 rows, and
 * three rows were simply wrong by the time they were checked.
 *
 * Matching is longest-prefix (see {@link getDefaultPricing}), so a more
 * specific row always wins over a more general one and rows may be listed in
 * any order.
 */
export const DEFAULT_PRICING_LAST_VERIFIED = '2026-08-25';

const PRICING_TABLE: Array<{ prefix: string; pricing: ModelPricing }> = [
  // --------------------------------------------------------------------------
  // Anthropic — https://docs.claude.com/en/docs/about-claude/pricing
  // Retrieved 2026-08-25. Cache-write column is the 5-minute TTL bucket; the
  // 1-hour bucket costs more and this table has no field for it.
  // --------------------------------------------------------------------------
  {
    prefix: 'claude-fable-5',
    pricing: { inputPerMillion: 10, outputPerMillion: 50, cacheWritePerMillion: 12.50, cacheReadPerMillion: 1, currency: 'USD', asOf: DEFAULT_PRICING_LAST_VERIFIED },
  },
  {
    prefix: 'claude-opus-5',
    pricing: { inputPerMillion: 5, outputPerMillion: 25, cacheWritePerMillion: 6.25, cacheReadPerMillion: 0.50, currency: 'USD', asOf: DEFAULT_PRICING_LAST_VERIFIED },
  },
  {
    prefix: 'claude-sonnet-5',
    pricing: { inputPerMillion: 2, outputPerMillion: 10, cacheWritePerMillion: 2.50, cacheReadPerMillion: 0.20, currency: 'USD', asOf: DEFAULT_PRICING_LAST_VERIFIED },
  },
  // Opus 4.5 through 4.8 all price identically to Opus 5.
  {
    prefix: 'claude-opus-4-8',
    pricing: { inputPerMillion: 5, outputPerMillion: 25, cacheWritePerMillion: 6.25, cacheReadPerMillion: 0.50, currency: 'USD', asOf: DEFAULT_PRICING_LAST_VERIFIED },
  },
  {
    prefix: 'claude-opus-4-7',
    pricing: { inputPerMillion: 5, outputPerMillion: 25, cacheWritePerMillion: 6.25, cacheReadPerMillion: 0.50, currency: 'USD', asOf: DEFAULT_PRICING_LAST_VERIFIED },
  },
  {
    // Was priced here at 15/75 — the retired Opus 4 rate, 3x the real one.
    prefix: 'claude-opus-4-6',
    pricing: { inputPerMillion: 5, outputPerMillion: 25, cacheWritePerMillion: 6.25, cacheReadPerMillion: 0.50, currency: 'USD', asOf: DEFAULT_PRICING_LAST_VERIFIED },
  },
  {
    prefix: 'claude-opus-4-5',
    pricing: { inputPerMillion: 5, outputPerMillion: 25, cacheWritePerMillion: 6.25, cacheReadPerMillion: 0.50, currency: 'USD', asOf: DEFAULT_PRICING_LAST_VERIFIED },
  },
  {
    // Retired except on Bedrock and Google Cloud; also covers Opus 4.1, which
    // is priced identically.
    prefix: 'claude-opus-4',
    pricing: { inputPerMillion: 15, outputPerMillion: 75, cacheWritePerMillion: 18.75, cacheReadPerMillion: 1.50, currency: 'USD', asOf: DEFAULT_PRICING_LAST_VERIFIED },
  },
  {
    prefix: 'claude-sonnet-4-6',
    pricing: { inputPerMillion: 3, outputPerMillion: 15, cacheWritePerMillion: 3.75, cacheReadPerMillion: 0.30, currency: 'USD', asOf: DEFAULT_PRICING_LAST_VERIFIED },
  },
  {
    prefix: 'claude-sonnet-4-5',
    pricing: { inputPerMillion: 3, outputPerMillion: 15, cacheWritePerMillion: 3.75, cacheReadPerMillion: 0.30, currency: 'USD', asOf: DEFAULT_PRICING_LAST_VERIFIED },
  },
  {
    // Retired except on Bedrock and Google Cloud.
    prefix: 'claude-sonnet-4',
    pricing: { inputPerMillion: 3, outputPerMillion: 15, cacheWritePerMillion: 3.75, cacheReadPerMillion: 0.30, currency: 'USD', asOf: DEFAULT_PRICING_LAST_VERIFIED },
  },
  {
    // Was priced here at 0.80/4 — the retired Haiku 3.5 rate.
    prefix: 'claude-haiku-4-5',
    pricing: { inputPerMillion: 1, outputPerMillion: 5, cacheWritePerMillion: 1.25, cacheReadPerMillion: 0.10, currency: 'USD', asOf: DEFAULT_PRICING_LAST_VERIFIED },
  },
  {
    // Retired except on Bedrock and Google Cloud.
    prefix: 'claude-3-5-haiku',
    pricing: { inputPerMillion: 0.80, outputPerMillion: 4, cacheWritePerMillion: 1, cacheReadPerMillion: 0.08, currency: 'USD', asOf: DEFAULT_PRICING_LAST_VERIFIED },
  },
  {
    // Fully retired: no longer listed on the price page as of 2026-08-25, so
    // this is the last published rate rather than a current one.
    prefix: 'claude-3-5-sonnet',
    pricing: { inputPerMillion: 3, outputPerMillion: 15, cacheWritePerMillion: 3.75, cacheReadPerMillion: 0.30, currency: 'USD', asOf: '2025-07-01' },
  },

  // --------------------------------------------------------------------------
  // OpenAI — https://platform.openai.com/docs/pricing (standard tier)
  // Retrieved 2026-08-25. "Cached input" is OpenAI's discounted rate for the
  // automatically-cached prompt prefix; note that OpenAI's prompt_tokens
  // INCLUDES that span (see UsageCacheConvention), which membrane normalizes
  // away before pricing, so cacheReadPerMillion is applied to a disjoint count.
  // --------------------------------------------------------------------------
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

  // --------------------------------------------------------------------------
  // Google — https://ai.google.dev/gemini-api/docs/pricing (paid tier)
  // Retrieved 2026-08-25. Google's published output price INCLUDES thinking
  // tokens, which is why the gemini adapter folds thoughtsTokenCount into
  // outputTokens. Cache rates are the context-caching per-token price and
  // exclude Google's separate per-hour storage charge, which membrane does not
  // model. Where a model has a >200k-token tier the smaller-prompt rate is used.
  // --------------------------------------------------------------------------
  {
    prefix: 'gemini-3.5-flash-lite',
    pricing: { inputPerMillion: 0.30, outputPerMillion: 2.50, cacheReadPerMillion: 0.03, currency: 'USD', asOf: DEFAULT_PRICING_LAST_VERIFIED },
  },
  {
    prefix: 'gemini-3.5-flash',
    pricing: { inputPerMillion: 1.50, outputPerMillion: 9, cacheReadPerMillion: 0.15, currency: 'USD', asOf: DEFAULT_PRICING_LAST_VERIFIED },
  },
  {
    prefix: 'gemini-2.5-pro',
    pricing: { inputPerMillion: 1.25, outputPerMillion: 10, cacheReadPerMillion: 0.125, currency: 'USD', asOf: DEFAULT_PRICING_LAST_VERIFIED },
  },
  {
    // Was absent, so the gemini-2.5-flash row priced it at 3x input / 6x output.
    prefix: 'gemini-2.5-flash-lite',
    pricing: { inputPerMillion: 0.10, outputPerMillion: 0.40, cacheReadPerMillion: 0.01, currency: 'USD', asOf: DEFAULT_PRICING_LAST_VERIFIED },
  },
  {
    // Was priced here at 0.15/0.60 — text rate; audio input costs more.
    prefix: 'gemini-2.5-flash',
    pricing: { inputPerMillion: 0.30, outputPerMillion: 2.50, cacheReadPerMillion: 0.03, currency: 'USD', asOf: DEFAULT_PRICING_LAST_VERIFIED },
  },
];

export function getDefaultPricing(modelId: string): ModelPricing | undefined {
  let best: ModelPricing | undefined;
  let bestLen = 0;
  for (const entry of PRICING_TABLE) {
    if (modelId.startsWith(entry.prefix) && entry.prefix.length > bestLen) {
      best = entry.pricing;
      bestLen = entry.prefix.length;
    }
  }
  return best;
}
