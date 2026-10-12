- **Code that switches over or builds `NormalizeEvent`:** the
  `cache_suppressed_for_synthetic` variant is removed, since the suppression
  it described no longer happens; there is no replacement event. A case
  label naming it no longer typechecks, so delete that arm with the
  upgrade. The union also gains `stray_tool_result_textified`, and
  `orphan_tool_result_textified` now requires `recoveredChars`: an
  exhaustive switch needs a case for the new kind, and code that constructs
  these events needs the new field.
- **Code that reads `toolUseId` from `normalizeToolPairs`' output:** a
  `tool_result` given as `toolUseId`, Membrane's content spelling, now
  leaves the normalizer as `tool_use_id` only, the field the wire pairs by,
  so code reading the output's results must read `tool_use_id`. Membrane's
  own request builders already send that field.
- **Callers whose histories hold synthetic `[pending]` results:** the
  normalizer keeps caller `cache_control` markers on and after those
  results instead of stripping them. Such requests change bytes once on
  upgrade, so their first request misses the cache, and the kept markers
  count toward the four-marker limit: under `cacheMarkers: 'cm-owned'`, a
  layout that fit only because the strip removed one is now refused, while
  the default mode clamps as before.
