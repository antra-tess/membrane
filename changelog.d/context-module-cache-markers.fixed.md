- **Context module:** cache markers now reach the wire. `applyCacheMarkers` sets
  `cacheBreakpoint` — the field every request builder reads — in addition to the
  existing `metadata.cacheControl`, which has no reader inside membrane. Until
  now the whole placement engine computed a result that was discarded at the
  formatter boundary, `messageBreakpoints` stayed 0 so membrane fell back to
  caching system+tools only, and `ContextInfo.cachedTokens` reported a cached
  prefix that did not exist.
- **Context module:** markers placed by the module are capped at 3 regardless of
  `cache.points`, keeping one of Anthropic's four `cache_control` slots free for
  the request builders' own spends (the XML formatter's system block, the
  floating tool-loop marker), which nothing reconciles against `cache.points`.
  The cap binds the stability path too: markers carried over from prior state
  are clamped to the deepest 3, so a state written before the cap existed does
  not keep re-spending four slots on every later call.
