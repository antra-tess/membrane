- OpenAI chat completions, the OpenAI Responses API and Gemini now keep a
  provider-reported cache-read count of 0 as `cacheReadTokens: 0`. Before,
  a reported 0 was dropped to `undefined`, indistinguishable from a provider
  that reported nothing. An unreported count is still absent.
