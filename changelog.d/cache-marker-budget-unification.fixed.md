- Cache-marker accounting is now ONE recount of the built wire request
  (`countWireCacheMarkers`), taken at each moment that spends the budget,
  instead of per-site running tallies that could not see each other:
  - the tools/system fallback is gated on that recount, so caller-marked
    `system` blocks (an explicitly supported input) suppress the fallback
    instead of stacking on top of it. Three caller markers plus both
    fallbacks previously put five `cache_control` blocks on the wire — a
    non-retryable 400 on every inference of that configuration.
  - a final clamp runs at the last exit before every adapter call (both the
    `complete()` and the streaming funnel), where every contribution is
    visible at once — builder, formatter, stale block-level passthrough from
    imported histories, the floating tool-loop marker, and any `beforeRequest`
    hook. Over-budget requests keep the 4 DEEPEST markers (each subsumes the
    shallower prefixes) and drop the rest with a warning naming the overspend,
    rather than being rejected outright.
  - the same clamp is the runtime assertion that no `cache_control` ever rides
    a `thinking` / `redacted_thinking` block, which the API rejects. The rule
    previously lived only in each builder's `lastCacheableBlockIndex` call.
  - that recount now finds markers NESTED inside a block's own content array,
    not only top-level blocks. `tool_result.content` is typed
    `string | ContentBlock[]` and reaches the wire verbatim, so four top-level
    markers plus one inside a tool_result counted as four and shipped as five
    — rejected outright with the belt's blessing. Discovery recurses into any
    array-valued `content`, capped at 4 levels (the cap is also what makes the
    walk total on a caller-built structure that points back at itself), and
    the strip walks the same traversal, so a marker the count can see is
    always one the clamp can drop. Document order still governs which markers
    survive, wherever they sit.
- The floating cache marker now stands down for EVERY normalizer repair that
  rewrites prefix bytes, not only the synthetic `[pending]` tool_result: a
  textified orphan `tool_result` is rewritten the same way when its pairing
  arrives. The kinds live in one exported set
  (`PREFIX_REWRITING_NORMALIZE_EVENT_KINDS`) so a new repair cannot silently
  escape the guard.
- The float's budget warning is rate-limited (first occurrence, then at most
  once a minute, carrying the suppressed count) instead of latching once per
  Membrane instance forever — the only observable of an over-budget wire used
  to go quiet for the life of the process.
- Live receipts (claude-haiku-4-5-20251001, 2026-08-25): 5 markers → 400 "A
  maximum of 4 blocks with cache_control may be provided. Found 5."; the same
  request post-clamp with 4 markers → 200. A marker on a thinking block → 400
  "thinking.cache_control: Extra inputs are not permitted"; post-clamp that
  rejection is gone.
