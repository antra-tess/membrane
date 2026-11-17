- Add opt-in `cacheKeepalive.suppressOnRefusal` for direct Anthropic keepalive:
  suspend shared keys on observed semantic refusals and rearm only after a new,
  known-normal foreground completion. Legacy behavior remains the default.
