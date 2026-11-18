# Opt-in Anthropic keepalive refusal suppression

```ts
import { AnthropicAdapter } from '@animalabs/membrane';

new AnthropicAdapter({ cacheKeepalive: {
  suppressOnRefusal: true,
  onSuppressed: event => console.log(event.key, event.source),
  onDiagnostic: event => console.log(event.key, event.reason),
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
is unchanged; suppression notifications never go to
`onEvent`. Register `onSuppressed` only when enabling suppression. Its throws
and rejected promises are isolated. A stale non-refusal resolution receives no semantic state events. Readable response
metadata produces its transport receipt; throwing metadata accessors still count
as global processing failures and can disable the keeper, removing replacements.
The stale-identity guarantee applies to successfully processed non-refusals. A stale refusal removes even a
replacement installed during the await and bars all attempts begun before observation. Rejected sender invocations still count toward the global consecutive
transport-error limit and can emit `error`/`disabled`, even after snapshot replacement.
`onCall.outcome: 'success'` means **the sender resolved and initial response
metadata was readable**, not semantic success. A throwing response accessor can
instead produce an error receipt and increment the failure count after resolution.
Refusal metadata is inspected and suppression applied before copying other response
properties, so an unrelated throwing accessor cannot bypass the refusal barrier. With suppression enabled, `onCall` configured and cloneable request/response values, each
actual sender invocation delivers one receipt, including refused, unknown, stale
and failed sends. In opt-in mode the receipt request is a structured clone of
the replay after sender settlement, based on the retained caller request, not wire bytes.
A custom sender can mutate the prepared replay before the receipt copy; its
changes are reflected in that copy in either mode.
Default-off first JSON.stringify/JSON.parse round-trips the recorded request,
then prepares and clones the replay: custom toJSON results survive, callable
fields may disappear, and exact-digit JSON numbers may round.
Neither mode is a wire audit. Opt-in JSON.rawJSON
branding and custom toJSON behavior are not preserved; some runtimes reject
rawJSON cloning entirely. Function-valued fields
(such as a metadata toJSON method) can prevent cloning even for valid SDK JSON.
Receipt delivery is best-effort: clone failures drop the receipt and, in opt-in
mode, report `receipt-clone-failed` through `onDiagnostic`, not `onEvent`. Default-off clone loss drops the receipt without a clone-failure diagnostic;
ordinary refresh events (such as `refreshed`) still fire. Error receipts pass the error value through without cloning it.
Observer failures are isolated and not retried. Receipt loss does not count as a send failure or retire
the replay snapshot. Response copies contain only own enumerable properties;
inherited/non-enumerable metadata can affect suppression without appearing in receipts. Without `onCall`, no receipts are delivered.
A refresh with missing/null/unrecognized raw terminal reason never emits `refreshed` or advances its refresh timestamp;
usage alone isn't evidence of a known terminal outcome. It removes the replay
snapshot and reports `unknown-refresh-terminal` through `onDiagnostic`,
while retaining outcome identity/barrier state. A later
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
With suppression enabled, replay serialization failures for a still-current snapshot
report `replay-preparation-failed` through `onDiagnostic`, explicitly naming snapshot
retirement. This notice is NOT delivered to `onEvent`: configure `onDiagnostic`
to observe preparation retirement (as well as unknown-terminal retirement and LRU
eviction). Without it these removals are silent. It is emitted without incrementing that send-failure counter or delivering
a call receipt, since the sender was not invoked. They retire only the failed
replay snapshot (retaining outcome identity), so it is not retried every timer
check; a later qualified foreground prefix can install a new snapshot. If serialization
reenters and stops or replaces the snapshot before throwing, the obsolete preparation
is silently abandoned: there was no sender invocation to receipt. In
default-off mode, replay serialization failures instead increment the failure
counter and leave the snapshot eligible for retry until keepalive is disabled.

Initial eligibility (including after eviction or idle/ineffective retirement)
requires a known-normal
foreground completion too; a prefix alone never qualifies a fresh opt-in identity.
Only a normal foreground request **begun after the accepted refusal** can rearm,
and only with raw terminal `end_turn`, `stop_sequence`, `tool_use`, `max_tokens`
`pause_turn`, or `model_context_window_exceeded`. Missing/null/unknown terminal, transport error,
cancellation observed before the adapter's finish(), timer replay and declared
maintenance do not rearm. Complete-response parse
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

Operational notices use the separate opt-in `onDiagnostic` callback with a
`KeepaliveDiagnostic` (`type: 'diagnostic'`, `key`, `reason`), not `onEvent`'s
failure `error` variant. It carries no prompt/response payload or failure count;
throws and rejected promises are isolated. Reason prefixes identify receipt loss,
replay preparation failure, unknown refresh/foreground terminals, outcome-LRU
eviction and detached attempts. Unknown foreground terminals report
`unknown-foreground-terminal` even for a fresh key with no replay snapshot;
they cannot qualify or rearm keepalive even if response parsing falls back to
`end_turn`. At `maxIneffective`, `ineffective-retirement` reports the consecutive
ineffective count after removing the snapshot and identity. The existing
`ineffective` event still reports the usage outcome on every ineffective refresh.
Default-off emits none of these diagnostics.

The failure limit remains adapter-global and consecutive, not a per-key retry
budget: a successfully processed refresh of another key resets it. A key whose
usage repeatedly fails validation can therefore retry until idle expiry when
healthy keys interleave. Use keyed error telemetry to identify that sender/key;
disabling the whole adapter for nonconsecutive key-local errors would also stop
healthy cache refreshes. No per-key failure counter or automatic permanent
quarantine is introduced by refusal suppression.

## Purpose boundary

`AnthropicAdapter.complete/stream` are normal foreground SDK entrypoints by
default. Complete qualification follows response parsing. Stream qualification
follows the observed provider terminal, stream callbacks, and block-order repair,
but precedes final response assembly and transformation-path parsing; an error there does not undo
qualification. Callbacks invoked synchronously by the adapter include application
callbacks forwarded immediately by Membrane (such as onContentBlockUpdate). If
one throws before the adapter's keepalive finish(), including during open-block
finalization after a terminal event, normal qualification is not reached. Raw
refusal observation is earlier, before progress callbacks.

This is an **adapter provider-response boundary**, not successful completion of
all Membrane/application processing. In particular, Membrane's local stop-sequence
handler can buffer a suffix and release it after the adapter returns, during
localStops.finish(). For stop sequence `abc`, a normal response ending in `ab`
can qualify before the application's callback receives that suffix. A throw or
caller-signal abort in that buffered callback does not undo qualification: even
if the Membrane invocation fails or the caller signal is now aborted, the snapshot
remains eligible for refresh. A signal abort this late need not reject the already
completed provider operation or the Membrane invocation. Other processing or
observer failures after the adapter's finish() also do not undo qualification. Complete qualification
precedes downstream Membrane response processing, but follows adapter parsing. A caller using these same entrypoints for cache-warming prefill or other
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
normal default; `complete`, `stream`, and `streamYielding` forward their
`keepalivePurpose` option to every adapter invocation, including continuations and retries.
Cache-warming callers through Membrane must also declare maintenance. No purpose metadata goes on provider wire.

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
wire snapshots. Only a normal request in a configured lane with an eligible
replay shape can allocate a new outcome identity. Excluded, ineligible and
maintenance traffic for untracked keys receives detached handles and cannot
evict eligible lineages. Such handles can still suppress a key retained by the
time their refusal arrives, but cannot qualify it. Requests for existing keys
still touch the outcome LRU and observe cross-lane refusals and rearm.
A stopped keeper does not register; sequence-advancing reentrant serialization
also returns a detached handle.
Each opt-in outcome eviction reports to `onDiagnostic` with the evicted key and
`outcome-lru-eviction: maxLineages cap exceeded`, even without a snapshot.
This diagnostic does not increment consecutive failures or disable the keeper.
Default-off snapshot LRU eviction remains silent; `skipped` only reports
ineligible-snapshot removal. More eligible distinct in-flight keys than the cap
can still evict attempts before they finish; sustained round-robin overload can
prevent qualification. Increase the cap or reduce eligible concurrency if needed.
Suppression has no time
expiry while retained; it holds no wire snapshot. LRU eviction forgets both
identity and suppression; a *new* begin after eviction is a fresh lineage, but
old in-flight handles remain invalid for prefix/success updates. A late refusal
from an evicted handle still suppresses a newly retained identity for that key,
without recreating forgotten keys or growing the map. Fresh identities must qualify through a
known-normal foreground completion, so forgetting cannot let maintenance or unknown
outcomes restore eligibility. In opt-in mode, stop permanently clears tracked maps and timers.
Default-off retains a legacy reentrant-serialization gap: `record()` can retain a
payload after its key serializer calls stop, and replay preparation can still
invoke a sender after its serializer calls stop. Stop
does not cancel an in-flight sender or immediately release its payload;
that sender can still deliver a receipt after stop.
Idle expiry and ineffective retirement drop both snapshot and identity.
An ineligible prefix in a configured lane, unless older than the latest accepted
prefix for that key, removes its replay snapshot and emits
`skipped` when one existed, without deleting the outcome identity or a retained
refusal barrier. Excluded lanes cannot remove snapshots by prefix ineligibility.
There is no persistence or durable tombstone format.
Low-level keeper clients must use `begin`, `prefix`, `finish` to observe outcomes.
On failure or cancellation, low-level callers should call `finish(handle, undefined)`
to release the attempt's request/header references without qualifying it. A prefix
on an already-qualified key may have installed those references in its replay
snapshot; finishing does not remove that snapshot or release its references.
Retaining an unfinished handle retains attempt references despite the lineage cap.
`record` is the legacy prefix-accounting API and is ignored entirely with suppression enabled,
even for qualified keys; it cannot carry begin identity or ordering.
Terminal capture initially reads `stop_reason` by ordinary property access,
without a presence check. It freezes that value in the copied terminal when it is
non-undefined or an own property exists. To preserve missing raw properties, an
inherited getter returning undefined is not frozen: parsing and complete-path
checks can read it again and disagree with bookkeeping. If it later returns
`refusal`, an existing qualified replay can remain eligible. Changing inherited
getters are outside the single-observation guarantee. The initial getter/get trap
necessarily runs before suppression; a returned refusal is applied before prototype/descriptor traps and unrelated
terminal metadata reads. Raw stream refusal is observed before progress callbacks or terminal parsing; a
callback error still fails the foreground and closes the SDK iterator normally.
Synchronous throws and rejected promises from event/call observers are isolated
in both modes. This observer safety and adapter bookkeeping exception isolation
are shared changes; default-off equivalence refers to scheduling and cap handling,
not exception propagation.
Errors inside guarded keeper operations never replace foreground results (in either mode).
Response metadata reads outside those guards, including complete()'s stop_reason
checks, can still throw and fail the foreground; arbitrary throwing response
accessors are not covered by this isolation guarantee. For guarded failures, a
payload-free warning reports potentially partial state,
and recommends checking custom serialization or disabling keepalive if failures
persist. A failed begin or finish stops the keeper permanently for this adapter and emits
`disabled` with a payload-free reason; its warning explicitly discloses that stop and directs callers to create a new adapter to restart,
because outcome tracking may be incomplete. Prefix/legacy record failures only warn, once per failure via console.warn,
without rate limiting or host-logger routing; state may be partially updated, and suppression is not guaranteed by such a warning.
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
Begin and finish bookkeeping failures stop adapter keepalive; prefix/record failures only warn.
Opt-in replay preparation rejects callable root `toJSON` methods, which could
otherwise override `max_tokens: 0` or message trimming after preparation. The
foreground request still uses ordinary SDK serialization. Nested serializers
remain outside the immutable ordinary-JSON identity guarantee above.

## Clock behavior

Snapshot age and refresh scheduling use wall-clock timestamps, not a monotonic
clock. A backward clock adjustment can postpone refresh and idle expiry by the
size of the adjustment; keepalive does not guarantee cache retention across clock
steps or VM restores.
