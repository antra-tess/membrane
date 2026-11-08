- Restrict explicit Responses caching to the Responses adapter and caller
  message `cacheBreakpoint` flags; synthesized Anthropic `cache_control` is
  never a Responses mark. Other adapters ignore the option entirely.
- Send skipped-mark diagnostics to stderr, report empty NativeFormatter
  expansions, and clean private provenance before tool-validation errors.
