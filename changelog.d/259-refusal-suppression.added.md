- Add opt-in `cacheKeepalive.suppressOnRefusal` for direct Anthropic keepalive:
  suspend shared keys on observed semantic refusals and rearm only after a new,
  known-normal foreground completion. Legacy behavior remains the default.
- Low-level keeper callers enabling suppression must migrate from `record` alone
  to `begin`/`prefix`/`finish`, and senders must return raw `stop_reason` alongside
  usage. Missing or unknown refresh terminals retire the snapshot with a
  `skipped` event rather than repeatedly resending it. `KeepaliveAttempt` is an
  opaque issuer-specific handle exposing only a read-only key.
