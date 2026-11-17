- Opt-in refusal suppression requires known-normal foreground completion for
  fresh identities, including after eviction. Excluded-lane and fresh pending
  prefixes cannot starve successful stream qualification; finishing an already
  registered request preserves its snapshot and refresh baseline.
- Opt-in outcome state uses a bounded all-request LRU; every eviction reports
  `skipped: outcome-lru-eviction`, even without a snapshot. Unrelated or excessive
  concurrent traffic can invalidate in-flight handles; increase `maxLineages`
  if needed. Ineligible prefixes preserve shared outcome identity. See
  `docs/keepalive-refusal-suppression.md` for retention tradeoffs.
- In opt-in mode, stale failed sender invocations and reentrant error observers
  cannot bypass the existing global consecutive transport-error limit. This is
  not per-key backoff, retry, or expiry policy.
