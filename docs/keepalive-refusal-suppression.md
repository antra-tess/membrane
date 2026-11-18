# Opt-in Anthropic keepalive refusal suppression

```ts
import { AnthropicAdapter } from '@animalabs/membrane';

new AnthropicAdapter({ cacheKeepalive: {
  suppressOnRefusal: true,
  onSuppressed: event => console.log(event.key, event.source),
} });
```

Default is **false**: legacy prefix registration and usage-based refresh behavior
are unchanged, including resolved refusals. This option is specific to the direct
Anthropic adapter/keeper, not a generic provider refusal or retry policy. Thrown
HTTP failures keep the existing error policy; they are not semantic refusals.

With the option enabled, raw SDK `stop_reason: 'refusal'` from foreground or a
refresh (including a stale one) suppresses its currently retained key and removes its replay snapshot, even with
positive cache-read counters. The separate opt-in `onSuppressed` callback receives a `KeepaliveSuppression`
notification naming foreground or refresh. The existing `KeepaliveEvent` union
and `onEvent` channel are unchanged; suppression notifications never go to
`onEvent`. Register `onSuppressed` only when enabling suppression. Its throws
and rejected promises are isolated. A stale non-refusal resolution only receives
its transport receipt, not semantic state events. The guarantee that stale outcomes
do not mutate a replacement applies only to non-refusals. A stale refusal removes even a
replacement installed during the await and bars all attempts begun before observation. Rejected sender invocations still count toward the global consecutive
transport-error limit and can emit `error`/`disabled`, even after snapshot replacement.
`onCall.outcome: 'success'` means **the sender resolved and initial response
metadata was readable**, not semantic success. A throwing response accessor can
instead produce an error receipt and increment the failure count after resolution.
Refusal metadata is inspected and suppression applied before copying other response
properties, so an unrelated throwing accessor cannot bypass the refusal barrier. With `onCall` configured and cloneable request/response values, each
actual sender invocation delivers one receipt, including refused, unknown, stale
and failed sends. Receipt delivery is best-effort: clone failures or observer
failures are isolated, not retried. Without `onCall`, no receipts are delivered.
A refresh with missing/null/unrecognized raw terminal reason never emits `refreshed` or advances its refresh timestamp;
usage alone isn't evidence of a known terminal outcome. It removes the replay
snapshot and emits `skipped` with reason
`unknown-refresh-terminal`, while retaining outcome identity/barrier state. A later
foreground prefix may register a new snapshot if the identity is still qualified.
This is retirement, not a new retry/backoff policy; an unknown refresh is never
resent on every timer check. Successfully processed resolutions reset consecutive send/response-processing
errors, including refusals, empty responses and unknown terminals in suppression
mode. For a current known-normal refresh, usage fields must also be readable
and numerically coercible before resetting that counter. Default-off preserves
legacy accounting: a resolved send resets the counter after response metadata
is copied for its receipt and before usage processing,
so repeated null/undefined response or usage-processing errors report 1 on each
refresh rather than accumulating toward the default threshold. Preparation and
rejected-send failures still accumulate in default-off mode, as do failures
while copying response metadata (for example, throwing enumerable getters).
With suppression enabled, replay serialization failures emit `error` without incrementing that send-failure counter or delivering
a call receipt, since the sender was not invoked. They retire only the failed
replay snapshot (retaining outcome identity), so it is not retried every timer
check; a later qualified foreground prefix can install a new snapshot. In
default-off mode, replay serialization failures instead increment the failure
counter and leave the snapshot eligible for retry until keepalive is disabled.

Initial eligibility (including after eviction or idle/ineffective retirement)
requires a known-normal
foreground completion too; a prefix alone never qualifies a fresh opt-in identity.
Only a normal foreground request **begun after the accepted refusal** can rearm,
and only with raw terminal `end_turn`, `stop_sequence`, `tool_use`, `max_tokens`
`pause_turn`, or `model_context_window_exceeded`. Missing/null/unknown terminal, transport error, cancellation,
timer replay and declared maintenance do not rearm. Complete-response parse
errors do not rearm; stream qualification precedes final response assembly
(see the boundary below). Terminal
parse fallbacks are not used. Begin order and refusal barriers use monotonic
identities, not timestamps: equal clock readings and older in-flight successes
cannot cross the barrier. A late foreground refusal is conservatively accepted
for its still-retained key, even if another request began more recently. An
older success cannot replace a newer installed snapshot or undo a newer ineligible
prefix. Excluded-lane prefixes and pending eligible prefixes on fresh identities
do not block an older successful stream from installing the first snapshot. Dropped, evicted or
stopped identities cannot be resurrected by their outstanding completions.

## Purpose boundary

`AnthropicAdapter.complete/stream` are normal foreground SDK entrypoints by
default. Complete qualification follows response parsing. Stream qualification
follows the observed provider terminal and stream callbacks, but precedes final
response assembly and transformation-path parsing; an error there does not undo
qualification. Neither lane waits for downstream Membrane processing or application observers. A downstream
callback failure does not undo a successful provider outcome. A caller using these same entrypoints for cache-warming prefill or other
maintenance **must**
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

State is local to each keeper (one per adapter), not shared across adapters in
the same process. A refusal on one adapter does not suppress another adapter. At most `maxLineages` outcome identities (default four)
are retained, including suppressed keys, separately from at most that many full
wire snapshots. Every request begin touches the outcome LRU, including excluded
lanes and
ineligible/unknown requests. Unrelated traffic can therefore evict an active
snapshot even though legacy scheduling would retain it; increase `maxLineages`
if needed. Every outcome eviction emits `skipped` with reason `outcome-lru-eviction`,
even when no snapshot existed. More distinct in-flight keys than the cap can
evict attempts before they finish; sustained round-robin overload can prevent
qualification. Increase the cap or reduce concurrency if these events recur. We retain this shared bound so that refused and
in-flight keys from all lanes remain observable without unbounded state.
Suppression has no time
expiry while retained; it holds no wire snapshot. LRU eviction forgets both
identity and suppression; a *new* begin after eviction is a fresh lineage, but
old in-flight handles remain invalid for prefix/success updates. A late refusal
from an evicted handle still suppresses a newly retained identity for that key,
without recreating forgotten keys or growing the map. Fresh identities must qualify through a
known-normal foreground completion, so forgetting cannot let maintenance or unknown
outcomes restore eligibility. Stop permanently clears tracked maps and timers,
but does not cancel an in-flight sender or immediately release its payload;
that sender can still deliver a receipt after stop.
Idle expiry and ineffective retirement drop both snapshot and identity.
An ineligible prefix in a configured lane removes its replay snapshot and emits
`skipped` when one existed, without deleting the outcome identity or a retained
refusal barrier. Excluded lanes cannot remove snapshots by prefix ineligibility.
There is no persistence or durable tombstone format.
Low-level keeper clients must use `begin`, `prefix`, `finish` to observe outcomes;
`record` is the legacy prefix-accounting API and is ignored entirely with suppression enabled,
even for qualified keys; it cannot carry begin identity or ordering.
Raw stream refusal is observed before progress callbacks or terminal parsing; a
callback error still fails the foreground and closes the SDK iterator normally.
Synchronous throws and rejected promises from event/call observers are isolated
in both modes. This observer safety and adapter bookkeeping exception isolation
are shared changes; default-off equivalence refers to scheduling and cap handling,
not exception propagation.
Adapter bookkeeping errors never replace foreground results (in either mode); a
payload-free warning reports potentially partial state,
and recommends checking custom serialization or disabling keepalive if failures
persist. A failed begin stops the keeper permanently for this adapter and emits
`disabled` with a payload-free reason; its warning explicitly discloses that stop and directs callers to create a new adapter to restart,
since its attempt identity cannot safely observe a subsequent refusal. Other failed bookkeeping is not a
guarantee that suppression was applied.
Finite nonpositive `maxLineages` retains no identities or snapshots (fractional caps round
down by eviction); negative caps do not block the foreground. Only with `suppressOnRefusal: true`, NaN and either infinity
are normalized to the default cap. With suppression unset or false, cap handling
matches main: NaN and positive Infinity are unbounded; negative Infinity retains
nothing. Normalization is not applied in default-off mode.
`KeepaliveAttempt` is an opaque, issuer-specific handle with a read-only key;
pass it back to the issuing keeper without accessing internal outcome state.
Default-off preserves legacy malformed-sender behavior: null/undefined responses
can emit success then error receipts, and preparation failures count toward
`maxConsecutiveErrors`. Do not count such malformed-response receipts as unique
invocations.
Custom senders opting in must return raw `stop_reason`, not only usage counters.

## Composition / exclusions

This is based on main `9d4dc61`, not open PR #252 (`d8cb179`). It does not copy
#252's per-key failure/backoff/expiry changes. Future composition must keep its
failure accounting separate from semantic suppression: known positive reads on
refusal/unknown must not warm-stamp; idle/ineffective retirement must invalidate
outcome identity (unknown-terminal retirement removes only the replay snapshot);
after every await and observer callback, check both current snapshot and state.
Transport receipts must survive those guards. #252 expectations permitting old
requests to restart after retirement or refreshed events after stop need explicit
opt-in reconciliation, not silent reuse. Persistence proposals #246/#256 must
define restoration of suppression separately; no persistence is implemented.

No provider behavior, billing, TTL extension, savings, refusal avoidance, live
compatibility, merge or release claim follows from the fake-only tests.

If caller-owned key serialization advances the keepalive sequence (by beginning
an attempt or suppressing a key), the outer attempt cannot
qualify or update a snapshot: intervening work may have refused and evicted its
identity. Its handle still reports a later refusal against a currently retained
key. This conservatively excludes even unrelated sequence-advancing reentry from
successful qualification. Read-only calls such as `getStatus()` and normal
completion of another attempt do not advance the sequence and are not excluded;
ordinary subsequent requests can qualify normally.

With suppression enabled, the adapter sends the caller's request object through
normal SDK serialization, without a JSON parse round trip. Exact-digit numbers
(such as `JSON.rawJSON` values) remain intact in foreground requests and replays.
The keeper retains request references and copies headers and numeric send time.
For immutable, ordinary JSON objects, hashed system/tools values are the values
sent by the SDK. Caller mutation while tracked, getters, and custom/stateful
`toJSON` serialization (including root serializers that replace identity fields)
are outside this guarantee. Serialization can run more than once; keepalive does
not promise single serialization or an owned transport snapshot.
Bookkeeping failure stops adapter keepalive rather than weakening refusal tracking.
