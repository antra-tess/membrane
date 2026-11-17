- Require known-normal foreground completion for fresh opt-in keepalive identities,
  including after eviction; observe raw stream refusals before progress callbacks,
  and prevent negative lineage caps from hanging foreground requests.
- Isolate Anthropic keepalive bookkeeping failures from foreground results in
  both modes, with a payload-free warning; this changes exception propagation,
  not the default legacy scheduling policy. Observe complete refusals before
  prefix bookkeeping and do not qualify streams cancelled in final callbacks.
- In opt-in refusal suppression, reset transport-error streaks on all resolved
  sends, report ineligible-prefix and outcome-LRU snapshot removals, preserve
  shared refusal identities through ineligible requests, and prevent excluded
  lanes from cancelling replay snapshots by prefix ineligibility. All request
  begins consume the bounded outcome LRU, so unrelated traffic can evict active
  snapshots; see `docs/keepalive-refusal-suppression.md` for retention tradeoffs.
- With opt-in refusal suppression, nonfinite lineage caps use the bounded
  default; asynchronous event observer failures are isolated like synchronous
  throws.
