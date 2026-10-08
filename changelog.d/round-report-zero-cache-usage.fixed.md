- OpenAI chat completions, the OpenAI Responses API and Gemini now keep a
  provider-reported cache-read count of 0 as `cacheReadTokens: 0`. Before,
  a reported 0 was dropped to `undefined`, indistinguishable from a provider
  that reported nothing. An unreported count is still absent. Gemini's
  `usageMetadata` follows proto3 JSON, which omits zero counts, so when it is
  present a missing `cachedContentTokenCount` is a reported 0, as a missing
  `candidatesTokenCount` is; only a response without `usageMetadata` leaves
  the count unreported.
