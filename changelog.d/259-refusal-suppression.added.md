- Add opt-in `cacheKeepalive.suppressOnRefusal` for direct Anthropic keepalive:
  suspend shared keys within each adapter, not across adapter instances, on observed semantic refusals and rearm only after a new,
  known-normal foreground completion. Legacy behavior remains the default.
- Low-level keeper callers enabling suppression must migrate from `record` alone
  to `begin`/`prefix`/`finish`, and senders must return raw `stop_reason` alongside
  usage. Missing or unknown refresh terminals retire the snapshot with an
  `onDiagnostic` notice prefixed `unknown-refresh-terminal` (no failure-count increment) rather than repeatedly resending it. `KeepaliveAttempt` is an
  opaque issuer-specific handle exposing only a read-only key, exported from the
  package root. `KeepaliveSend` accepts an optional `stop_reason: unknown` field;
  pre-existing custom senders remain assignable without opting in.
- Low-level `requestForAttempt(handle)` exposes the retained mutable request
  reference until the attempt finishes or the keeper stops; callers must not
  mutate it while tracked.
- Adapter and Membrane callers enabling suppression must declare cache-warming prefill
  or other maintenance with `keepalivePurpose: 'maintenance'` on their call options.
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
  and do not qualify streams cancelled in callbacks forwarded before adapter finish.
  Local stop-sequence suffixes may be released after qualification; callbacks that
  throw or abort there do not undo qualification or remove the snapshot. Install refresh refusal
  barriers before receipt observers, ignore identity-free `record()` calls, and
  observe each foreground refusal handle only once.
- With opt-in refusal suppression, nonfinite lineage caps use the bounded default.
  With suppression unset or false, cap handling matches main without normalization
  (NaN and positive Infinity are unbounded; negative Infinity retains nothing).
- Opt-in refusal suppression requires known-normal foreground completion for
  fresh identities, including after eviction. Excluded-lane and fresh pending
  prefixes cannot starve successful stream qualification; finishing an already
  registered request preserves its snapshot and refresh baseline.
- Opt-in outcome state is bounded; eviction emits an `onDiagnostic` notice
  (`outcome-lru-eviction`), unlike silent legacy snapshot eviction.
  Only normal, eligible requests in configured lanes allocate new identities;
  unrelated excluded/ineligible traffic cannot evict eligible lineages.
  Excess eligible concurrency can still invalidate in-flight handles.
  Existing keys retain cross-lane refusal/rearm observation. See
  `docs/keepalive-refusal-suppression.md` for retention tradeoffs.
- In opt-in mode, stale failed sender invocations and reentrant error observers
  cannot bypass the existing global consecutive transport-error limit. This is
  not per-key backoff, retry, or expiry policy.
- In opt-in mode, empty resolved refresh responses are transport successes,
  replay preparation failures retire only the failed snapshot without counting
  toward the send-failure limit (a later qualified prefix can install a new one), and
  a foreground refusal from an evicted handle still suppresses a currently
  retained identity for its key. Default-off scheduling is unchanged; shared
  bookkeeping/observer exception isolation is described in the fixed fragment.
- In opt-in mode, a failed begin or finish permanently stops keepalive for that adapter,
  emits `disabled` with a reason, and warns of the permanent stop.
- With opt-in keepalive refusal suppression, reserve request order before lineage
  serialization, honor stop during serialization, and accept only the first
  foreground terminal observation per attempt. Background receipts use the same
  captured terminal value as suppression classification. Default-off scheduling
  remains unchanged.
- Opt-in receipts copy the caller request object, not SDK wire bytes; raw JSON
  brands and custom serializers are not preserved. Uncloneable request/response
  values drop the receipt and emit an `onDiagnostic` notice prefixed `receipt-clone-failed`, without
  changing refresh accounting. Response copies include own enumerable fields only.
- Opt-in replays reject callable root `toJSON` methods to protect the prefill-only
  token budget and message trimming. Foreground serialization is unchanged.
- Opt-in unprintable error messages cannot bypass failure disabling. Legacy
  default-off error formatting is unchanged.
- Opt-in success receipt latency stops at sender resolution, excluding response
  copying and synchronous observers. Nonfinite usage errors name the field and
  coerced value. Preparation errors explicitly report snapshot retirement.
- Opt-in ineffective retirement completes before notifying observers, so a new
  same-key request begun by the observer retains a valid outcome identity.
- With refusal suppression enabled, retain SDK-native request values without a lossy JSON parse round trip
  (caller mutation and custom serialization are outside the identity guarantee), reject non-finite refresh usage as a processing failure, and release
  live attempt data on stop. Default-off scheduling remains unchanged.
- With refusal suppression enabled, honor newer ineligible prefix ordering after
  refusal and release finished attempt data even when opaque handles are retained.
- Add opt-in outcome-LRU eviction diagnostics, including pending identities,
  without classifying eviction as an ineligible-snapshot skip. Default-off eviction stays silent.
- With refusal suppression enabled, recheck stop after admission accessors and
  measure error receipts at sender settlement, excluding later suppression observers.
- Capture Anthropic foreground terminal stop reasons once when refusal-aware cache keepalive is enabled, so changing SDK accessors cannot make suppression disagree with complete or stream responses. Default-off behavior is unchanged. Refusal suppression precedes unrelated response/event getters, including streamed usage.
- Opt-in idle expiry is rechecked for each lineage after earlier refreshes settle.
- Foreground terminal capture preserves missing raw `stop_reason` properties.
- Reasoned operator stops emit no duplicate failure-threshold `disabled` event.
- Opt-in eligible attempts detached by serialization reentry emit a
  `detached-attempt` notice via `onDiagnostic` without incrementing the failure count.
- Add a separate opt-in `onDiagnostic` callback and `KeepaliveDiagnostic` type
  for non-failure operational notices, keeping `onEvent` error events reserved
  for counted failures. Report unknown foreground terminals (including fresh
  unqualified keys) and ineffective retirement with its consecutive count.
- Apply observed foreground refusals before terminal capture runs prototype or
  property-descriptor proxy traps; throwing traps cannot leave the old key replayable.
- Read foreground `stop_reason` once by ordinary property access, without a
  presence check, before other terminal capture traps. The read itself can run
  a caller getter/get trap; suppression follows the returned refusal, not that trap.
- Preparation-retirement diagnostics omit exception text to avoid leaking payloads;
  these notices require `onDiagnostic` and are not delivered to `onEvent`.
