- `stream()` now forwards `timeoutMs` to the provider on both the XML and
  native tool paths — it was declared, documented and adapter-honoured, but
  dropped at exactly the call sites where a wedged connection hangs the turn.
  `StreamOptions.idleTimeoutMs` is added for parity with the yielding path
  and forwarded the same way.
