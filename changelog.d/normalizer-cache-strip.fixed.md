- Tool-pair normalizer: stranded-call synthesis no longer strips `cache_control`
  from the rest of the conversation. The suppression existed in case synthetic
  bytes were rewritten when the real result landed, but a synthetic is only ever
  produced for an id the caller did NOT declare in-flight — a stranded call,
  whose `[pending]` payload is a fixed literal reproduced byte-identically on
  every later compile. The strip therefore defended against a rewrite that
  cannot happen, at the cost of the entire remaining prompt cache for as long as
  the stranded `tool_use` stayed in the window.
- Membrane now refuses to send a build that reported `ready: false`, throwing the
  new `MembraneNotReadyError` (a non-retryable `invalid_request`) at the request
  boundary. `BuildResult.ready` is the normalizer's answer to
  `BuildOptions.pendingToolCallIds`; it was written by two formatters and read
  nowhere, so a consumer following Membrane's own example of ignoring it shipped
  an unmatched `tool_use` — the exact 400 the normalizer exists to prevent,
  produced by using its documented option.
