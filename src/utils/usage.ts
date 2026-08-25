import type { ProviderResponse, UsageCacheConvention } from '../types/provider.js';

/** Adapters whose convention is undeclared warn once each, not once per call. */
const warnedUndeclaredAdapters = new Set<string>();

/**
 * Restate a provider's usage in membrane's single convention: `inputTokens`,
 * `cacheReadTokens` and `cacheCreationTokens` DISJOINT, each priced at its own
 * rate. Adapters reporting `cache-inclusive` counts have the cached span
 * subtracted out of `inputTokens`; the total prompt size stays recoverable as
 * `inputTokens + cacheReadTokens`.
 *
 * Without this, one field name carried two incomparable meanings — the cache
 * hit ratio was unbounded on cache-excluded adapters and cost double-charged
 * the cached span on cache-inclusive ones.
 */
export function normalizeUsageToCacheExcluded(
  usage: ProviderResponse['usage'],
  adapterName: string,
  adapterConvention: UsageCacheConvention,
): ProviderResponse['usage'] {
  // An adapter that declares nothing is in exactly the state `unknown` names.
  // The interface requires the field, but tsc only covers `src/`, so a
  // hand-rolled adapter can still arrive without one — treat it the same way
  // rather than letting an undeclared convention slip through quietly.
  const convention = usage.cacheConvention ?? adapterConvention ?? 'unknown';
  const cacheReadTokens = usage.cacheReadTokens ?? 0;

  if (convention === 'unknown' && cacheReadTokens > 0 && !warnedUndeclaredAdapters.has(adapterName)) {
    warnedUndeclaredAdapters.add(adapterName);
    console.warn(
      `[membrane:usage] adapter "${adapterName}" reported ${cacheReadTokens} cache-read tokens but`
      + ' declares usageCacheConvention "unknown", so membrane cannot tell whether inputTokens'
      + ` (${usage.inputTokens}) already includes them. Counts are passed through unchanged;`
      + ' cost and cache hit ratio may be off by the cached span until the adapter declares'
      + ' "cache-excluded" or "cache-inclusive".'
    );
  }

  if (convention !== 'cache-inclusive' || cacheReadTokens === 0) return usage;

  return { ...usage, inputTokens: Math.max(0, usage.inputTokens - cacheReadTokens) };
}

/**
 * Share of the prompt that was served from cache. Both terms are in the
 * cache-excluded convention, so this is a true ratio in [0, 1] regardless of
 * which provider produced the counts.
 */
export function calculateCacheHitRatio(
  usage: { inputTokens: number; cacheReadTokens?: number },
): number {
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const promptTokens = (usage.inputTokens ?? 0) + cacheReadTokens;
  if (promptTokens === 0) return 0;
  return cacheReadTokens / promptTokens;
}

/** Test seam: the once-per-adapter warn latch is process-wide otherwise. */
export function resetUndeclaredConventionWarnings(): void {
  warnedUndeclaredAdapters.clear();
}
