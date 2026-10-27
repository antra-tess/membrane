- **Code that calls an adapter's own `complete()` or `stream()`:** if the
  call's `signal` has fired by the time sending the request or reading its
  response fails, every adapter that makes requests rejects with a
  `MembraneError` of type `abort`, not retryable, "Request was aborted". Its
  `rawError` holds what the adapter caught, an `Error` as its serialized
  fields and anything else as it is: for `AnthropicAdapter`, what its SDK
  threw, or a credential failure that ended the request first. Where the
  signal ended the request with a reason that is already a `MembraneError`
  of type `abort`, every such adapter but `AnthropicAdapter`, whose SDK
  rejects with an error of its own, passes that error on, as before. Before,
  every such adapter but `AnthropicAdapter` typed the abort as it would a
  failure of the request, by the reason's code, name or words: a reason
  coded `ECONNRESET`, or wrapping one as its `cause`, was `network` and
  retryable; a `TimeoutError`, which `AbortSignal.timeout()` gives, was
  `timeout` and retryable; a reason that was itself a `MembraneError` kept
  its own type; a string, a plain object or an `Error` whose words name no
  failure was `unknown`. `AnthropicAdapter` already gave `abort`, with no
  `rawError`. **Migration:** read `abort` for your own cancellation, as
  `Membrane` already gives, and don't retry it. **Unchanged:** the `type`,
  `retryable` and `message` of a call through `Membrane`'s `complete()`, and
  the aborted response, reason `user`, that `stream()` and
  `streamYielding()` give for the caller's own signal. Apart from a reason
  that is already such an abort, the error `complete()` throws now carries
  as its `rawError` what the adapter caught, such as the caller's reason or
  what the Anthropic SDK threw, where it carried the adapter's own error or
  nothing. A deadline of the call's own (`timeoutMs`, `progressTimeoutMs`,
  progress bounds, and `AnthropicAdapter.stream()`'s idle and first-event
  watchdogs) stays a `timeout`, unless the caller's signal has also fired by
  the time the error is handled; then it's an `abort`, as through
  `Membrane`. agent-framework 0.27.0, connectome-host at `b98d9765` and
  context-manager at `f7cd5b67` cope: they reach adapters through
  `Membrane`, and connectome-host's logging adapters, which call the adapter
  beneath them themselves, are the adapters `Membrane` is given, and log
  what that adapter throws before passing it on.
