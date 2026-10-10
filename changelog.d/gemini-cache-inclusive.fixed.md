- Gemini's usage is read as cache-inclusive: `promptTokenCount` counts the
  cached span `cachedContentTokenCount` reports, so `inputTokens` is now the
  fresh input and a cache hit is counted once by cost, the cache-hit ratio
  and any consumer summing input, cache reads and cache writes. Google's
  UsageMetadata reference states the inclusion for explicit cached content;
  for the implicit hits membrane meets it is inferred from the field's
  definition, and has not been measured.
