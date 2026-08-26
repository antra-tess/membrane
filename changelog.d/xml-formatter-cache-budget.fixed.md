- `AnthropicXmlFormatter` (the prefill path) now has a breakpoint budget. It
  attaches `cache_control` at five sites — system, contextPrefix, hasCacheMarker
  flush, cacheBreakpoint flush and the CLI-simulation system block — and
  compared the total to nothing, so a prefill turn with three marked messages
  put five markers on the wire and the API rejected the whole request. The
  finished artifacts are clamped once, keeping the 4 deepest markers, and the
  reported `cacheMarkersApplied` is that same recount rather than a running
  tally that could drift from the wire.
- A caller-supplied system ARRAY keeps its blocks and their per-block
  `cache_control` through the XML formatter instead of being flattened into one
  text block with every caller marker discarded. When the caller marked nothing,
  the formatter marks the last block (once) as before; when the caller marked
  anything, its allocation is authoritative and the formatter adds nothing.
  System-mode tool injection appends to the last block, so the earlier blocks'
  markers survive it.
