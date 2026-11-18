- Add opt-in `cacheKeepalive.suppressOnRefusal` for direct Anthropic keepalive:
  suspend shared keys within each adapter, not across adapter instances, on observed semantic refusals and rearm only after a new,
  known-normal foreground completion. Legacy behavior remains the default.
- Low-level keeper callers enabling suppression must migrate from `record` alone
  to `begin`/`prefix`/`finish`, and senders must return raw `stop_reason` alongside
  usage. Missing or unknown refresh terminals retire the snapshot with a
  `skipped` event with reason `unknown-refresh-terminal` rather than repeatedly resending it. `KeepaliveAttempt` is an
  opaque issuer-specific handle exposing only a read-only key, exported from the
  package root. `KeepaliveSend` accepts an optional `stop_reason: unknown` field;
  pre-existing custom senders remain assignable without opting in.
- Direct adapter callers enabling suppression must declare cache-warming prefill
  or other maintenance with `ProviderRequestOptions.keepalivePurpose: 'maintenance'`.
  Ordinary assistant-prefill continuations remain normal foreground inference by
  default; the declaration is non-wire metadata, not inferred from token counts.
- `CacheKeepalive.stop(reason)` accepts an optional reason and emits one
  `disabled` event on the first stop when a nonempty reason is supplied. Calling
  `stop()` without a reason remains silent.
- Add a separate opt-in `onSuppressed` callback and exported
  `KeepaliveSuppression` notification type for consumers enabling suppression.
  `KeepaliveEvent` and `onEvent` remain unchanged; existing exhaustive consumers
  need no new case or compatible sibling-package release.
- With opt-in suppression only, observe complete refusals before prefix bookkeeping
  and do not qualify streams cancelled in final callbacks. Install refresh refusal
  barriers before receipt observers, ignore identity-free `record()` calls, and
  observe each foreground refusal handle only once.
- With opt-in refusal suppression, nonfinite lineage caps use the bounded default.
  With suppression unset or false, cap handling matches main without normalization
  (NaN and positive Infinity are unbounded; negative Infinity retains nothing).
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
- In opt-in mode, empty resolved refresh responses are transport successes,
  replay preparation failures retire only the failed snapshot without counting
  toward the send-failure limit (a later qualified prefix can install a new one), and
  a foreground refusal from an evicted handle still suppresses a currently
  retained identity for its key. Default-off behavior is unchanged.
- In opt-in mode, a failed begin or finish permanently stops keepalive for that adapter,
  emits `disabled` with a reason, and warns of the permanent stop.
- With opt-in keepalive refusal suppression, reserve request order before lineage
  serialization, honor stop during serialization, and accept only the first
  foreground terminal observation per attempt. Background receipts use the same
  captured terminal value as suppression classification. Default-off scheduling
  remains unchanged.
- Opt-in receipts copy the caller request object, not SDK wire bytes; raw JSON
  brands and custom serializers are not preserved. Uncloneable request/response
  values drop the receipt and emit `skipped: receipt-clone-failed`, without
  changing refresh accounting. Response copies include own enumerable fields only.
- Opt-in replays reject callable root `toJSON` methods to protect the prefill-only
  token budget and message trimming. Foreground serialization is unchanged.
- Opt-in unprintable error messages cannot bypass failure disabling. Legacy
  default-off error formatting is unchanged.
