# Opt-in Anthropic keepalive refusal suppression

```ts
new AnthropicAdapter({ cacheKeepalive: { suppressOnRefusal: true } });
```

Default is **false**: legacy prefix registration and usage-based refresh behavior
are unchanged, including resolved refusals. This option is specific to the direct
Anthropic adapter/keeper, not a generic provider refusal or retry policy. Thrown
HTTP failures keep the existing error policy; they are not semantic refusals.

With the option enabled, raw SDK `stop_reason: 'refusal'` from foreground or a
current refresh suppresses its key and removes its replay snapshot, even with
positive cache-read counters. A `suppressed` event names foreground or refresh.
A stale refresh's result only receives its transport receipt, not state events.
`onCall.outcome: 'success'` still means **the sender resolved**, not semantic
success. Each actual sender invocation retains one receipt, including refused,
unknown, stale and failed sends. A refresh with missing/null/unrecognized raw
terminal reason never emits `refreshed` or advances its refresh timestamp;
usage alone isn't evidence of a known terminal outcome. It remains due for the
next ordinary timer check (no new retry/backoff policy).

Initial eligibility (including after eviction or retirement) requires a known-normal
foreground completion too; a prefix alone never qualifies a fresh opt-in identity.
Only a normal foreground request **begun after the accepted refusal** can rearm,
and only with raw terminal `end_turn`, `stop_sequence`, `tool_use`, `max_tokens`
or `pause_turn`. Missing/null/unknown terminal, parse error, transport error,
cancellation, timer replay and declared maintenance do not rearm. Terminal
parse fallbacks are not used. Begin order and refusal barriers use monotonic
identities, not timestamps: equal clock readings and older in-flight successes
cannot cross the barrier. A late foreground refusal is conservatively accepted
for its still-retained key, even if another request began more recently. An
older success cannot replace a newer prefix snapshot. Dropped, evicted or
stopped identities cannot be resurrected by their outstanding completions.

## Purpose boundary

`AnthropicAdapter.complete/stream` are normal foreground SDK entrypoints by
default. A caller using these same entrypoints for prefill or maintenance **must**
pass `ProviderRequestOptions.keepalivePurpose: 'maintenance'`. This trusted,
non-wire declaration only affects initial eligibility and rearm permission. It does not modify the
request body, headers, timeout, signal or foreground result. Token counts and
output text are not purpose classifiers: normal `max_tokens` is allowed;
maintenance with a large token budget still cannot rearm. Assistant-prefill,
continuation and caller-requested refusal reissues are normal inference unless
explicitly declared maintenance. Each adapter invocation is a new begin;
internal credential resends remain the same invocation. This contract does not
verify arbitrary caller intent. Membrane's own inference invocations use the
normal default; the override is available to direct adapter/decorator callers,
not a new high-level Membrane option. No purpose metadata goes on provider wire.

## Shared keys, retention and bounds

The existing hash is model/system/tools, **not** a unique conversation or vendor
cache-prefix identity. Messages and lane are excluded. Refusals from excluded
lanes still suppress a shared key. A later known-normal completion from any lane
can clear suppression, but only configured lanes can install replay snapshots.
Normal lane defaults remain stream-only. Maintenance can update already-qualified, unsuppressed
prefix accounting but cannot clear suppression.

State is process-local. At most `maxLineages` outcome identities (default four)
are retained, including suppressed keys, separately from at most that many full
wire snapshots. Request begin touches the outcome LRU. Suppression has no time
expiry while retained; it holds no wire snapshot. LRU eviction forgets both
identity and suppression; a *new* begin after eviction is a fresh lineage, but
old in-flight handles remain invalid. Fresh identities must qualify through a
known-normal foreground completion, so forgetting cannot let maintenance or unknown
outcomes restore eligibility. Stop clears everything permanently.
Idle expiry and ineffective retirement drop both snapshot and identity.
An ineligible prefix removes replay eligibility, without clearing a retained
refusal barrier. There is no persistence or durable tombstone format.
Low-level keeper clients must use `begin`, `prefix`, `finish` to observe outcomes;
`record` alone is the legacy prefix-accounting API and cannot rearm suppression.
Raw stream refusal is observed before progress callbacks or terminal parsing; a
callback error still fails the foreground and closes the SDK iterator normally.
Observer errors and adapter bookkeeping errors never replace foreground results.
Nonpositive `maxLineages` retains no identities or snapshots (fractional caps round
down by eviction); negative caps do not block the foreground.

## Composition / exclusions

This is based on main `9d4dc61`, not open PR #252 (`d8cb179`). It does not copy
#252's per-key failure/backoff/expiry changes. Future composition must keep its
failure accounting separate from semantic suppression: known positive reads on
refusal/unknown must not warm-stamp; retirement must invalidate outcome identity;
after every await and observer callback, check both current snapshot and state.
Transport receipts must survive those guards. #252 expectations permitting old
requests to restart after retirement or refreshed events after stop need explicit
opt-in reconciliation, not silent reuse. Persistence proposals #246/#256 must
define restoration of suppression separately; no persistence is implemented.

No provider behavior, billing, TTL extension, savings, refusal avoidance, live
compatibility, merge or release claim follows from the fake-only tests.
