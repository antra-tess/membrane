- Add opt-in `cacheKeepalive.suppressOnRefusal` for direct Anthropic keepalive:
  suspend shared keys on observed semantic refusals and rearm only after a new,
  known-normal foreground completion. Legacy behavior remains the default.
- Low-level keeper callers enabling suppression must migrate from `record` alone
  to `begin`/`prefix`/`finish`, and senders must return raw `stop_reason` alongside
  usage. Missing or unknown refresh terminals retire the snapshot with a
  `skipped` event with reason `unknown-refresh-terminal` rather than repeatedly resending it. `KeepaliveAttempt` is an
  opaque issuer-specific handle exposing only a read-only key.
- Direct adapter callers enabling suppression must declare cache-warming prefill
  or other maintenance with `ProviderRequestOptions.keepalivePurpose: 'maintenance'`.
  Ordinary assistant-prefill continuations remain normal foreground inference by
  default; the declaration is non-wire metadata, not inferred from token counts.
- `CacheKeepalive.stop(reason)` accepts an optional reason and emits one
  `disabled` event on the first stop when a nonempty reason is supplied. Calling
  `stop()` without a reason remains silent.
