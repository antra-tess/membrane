- Tool-pair normalizer: producer defects now refuse at entry with a typed
  `MembraneNormalizerError` instead of failing late or silently mis-repairing.
  It is a `MembraneError` (`invalid_request`, not retryable), and Membrane's
  `complete()` and streaming paths pass it to the caller as it is, so a
  refusal is never retried as a transport error or rewrapped.
  - `pendingToolCallIds` is validated on every call: it must be set-like and
    hold strings. It was consulted only for an unmatched `tool_use`, so an
    array (the shape a JSON config round-trip produces) passed every
    well-formed transcript and threw an untyped `TypeError` mid-pipeline
    exactly when the net was load-bearing, and a set of numbers silently
    gave an in-flight call a `[pending]` result. The public type stays
    `ReadonlySet<string>`; the value is not coerced. `null`, like an absent
    set, means nothing is pending.
  - Two `tool_use` blocks sharing an id in one turn are refused: their
    results can't be told apart, and the API refuses such a request. An id
    reused across turns is accepted, as the API accepts it, and pairs by
    position: a result answers the nearest call with its id before it, so
    hoisting no longer hands a later call's result to an earlier one.
  - A `tool_use` without a string id is refused: no result can answer it.
  - A message that isn't an object with role `user` or `assistant`, and a
    content block that isn't an object with a string `type`, are refused
    instead of throwing an untyped `TypeError` mid-pipeline.
  - Message content that is neither a block array nor a string is refused
    instead of being coerced with `String()`, which shipped the literal text
    `[object Object]` to the model. `null` or `undefined` content is an
    empty block list, as before.
