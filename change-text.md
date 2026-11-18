# Opt-in refusal-aware Anthropic cache keepalive

Add `cacheKeepalive.suppressOnRefusal` (default false). Legacy scheduling remains
unchanged by default: an HTTP rejection before `message_start` is not recorded,
but a resolved semantic refusal after `message_start` can still be replayed.

With suppression enabled, a resolved refusal suppresses the shared model/system/tools
key, including when an older request or refresh observes it. Only a known-normal
foreground attempt begun after that refusal can rearm the key. Unknown or
maintenance terminals cannot initially qualify or rearm it.

Stream qualification precedes final response assembly: a local assembly failure
can reject the invocation without undoing qualification or removing its snapshot.
Complete qualification follows response parsing. Neither waits for downstream
application delivery. Failed sends and cancellation do not qualify a new key.

Unknown refresh terminals retire the replay snapshot, not the retained outcome
identity; a later qualified foreground prefix can install a new snapshot.
Stale non-refusal refresh outcomes leave replacement state untouched; stale
refusals suppress the currently retained key and bar earlier-begun attempts.

See [the detailed guide](docs/keepalive-refusal-suppression.md) for bounds,
receipts, exclusions, and operational considerations. No live enabling is included.
