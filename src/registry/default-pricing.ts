import type { ModelPricing } from '../types/provider.js';

/**
 * Built-in pricing table for known models.
 * Prices in USD per million tokens. Last updated: 2025-07.
 *
 * Used as fallback when no ModelRegistry is configured.
 * Registry pricing (if available) takes precedence.
 */
const PRICING_TABLE: Array<{ prefix: string; pricing: ModelPricing }> = [
  // Anthropic — Claude 4.6
  {
    prefix: 'claude-opus-4-6',
    pricing: { inputPerMillion: 15, outputPerMillion: 75, cacheWritePerMillion: 18.75, cacheReadPerMillion: 1.50, currency: 'USD' },
  },
  {
    prefix: 'claude-sonnet-4-6',
    pricing: { inputPerMillion: 3, outputPerMillion: 15, cacheWritePerMillion: 3.75, cacheReadPerMillion: 0.30, currency: 'USD' },
  },
  // Anthropic — Claude 4.5
  {
    prefix: 'claude-haiku-4-5',
    pricing: { inputPerMillion: 0.80, outputPerMillion: 4, cacheWritePerMillion: 1.00, cacheReadPerMillion: 0.08, currency: 'USD' },
  },
  // Anthropic — Claude 4
  {
    prefix: 'claude-opus-4',
    pricing: { inputPerMillion: 15, outputPerMillion: 75, cacheWritePerMillion: 18.75, cacheReadPerMillion: 1.50, currency: 'USD' },
  },
  {
    prefix: 'claude-sonnet-4',
    pricing: { inputPerMillion: 3, outputPerMillion: 15, cacheWritePerMillion: 3.75, cacheReadPerMillion: 0.30, currency: 'USD' },
  },
  // Anthropic — Claude 3.5
  {
    prefix: 'claude-3-5-sonnet',
    pricing: { inputPerMillion: 3, outputPerMillion: 15, cacheWritePerMillion: 3.75, cacheReadPerMillion: 0.30, currency: 'USD' },
  },
  {
    prefix: 'claude-3-5-haiku',
    pricing: { inputPerMillion: 0.80, outputPerMillion: 4, cacheWritePerMillion: 1.00, cacheReadPerMillion: 0.08, currency: 'USD' },
  },
  // OpenAI — GPT-4o
  {
    prefix: 'gpt-4o-2024',
    pricing: { inputPerMillion: 2.50, outputPerMillion: 10, cacheReadPerMillion: 1.25, currency: 'USD' },
  },
  {
    prefix: 'gpt-4o-mini',
    pricing: { inputPerMillion: 0.15, outputPerMillion: 0.60, cacheReadPerMillion: 0.075, currency: 'USD' },
  },
  // Google — Gemini 2.5
  {
    prefix: 'gemini-2.5-pro',
    pricing: { inputPerMillion: 1.25, outputPerMillion: 10, currency: 'USD' },
  },
  {
    prefix: 'gemini-2.5-flash',
    pricing: { inputPerMillion: 0.15, outputPerMillion: 0.60, currency: 'USD' },
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
