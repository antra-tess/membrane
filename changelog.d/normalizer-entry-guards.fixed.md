- Tool-pair normalizer: producer defects now refuse at entry with a typed
  `MembraneNormalizerError` instead of failing late or silently mis-repairing.
  - `pendingToolCallIds` is validated as set-like on every call. It was
    consulted only for an unmatched `tool_use`, so an array (the shape a
    JSON config round-trip produces) passed every well-formed transcript and
    threw an untyped `TypeError` mid-pipeline exactly when the net was
    load-bearing. The public type stays `ReadonlySet<string>`; the value is
    not coerced.
  - Duplicate `tool_use` ids are refused. Result hoisting matches the first
    id, so a reused id reattributed one cycle's real result to another cycle
    and left the second holding a synthetic `[pending]` — wire-valid and
    silently wrong.
  - Message content that is neither a block array nor a string is refused
    instead of being coerced with `String()`, which shipped the literal text
    `[object Object]` to the model.
