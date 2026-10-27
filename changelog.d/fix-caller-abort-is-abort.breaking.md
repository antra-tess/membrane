- **Code that calls an adapter's own `complete()` or `stream()`:** once the
  call's `signal` fires, every adapter rejects with a `MembraneError` of type
  `abort`, not retryable, "Request was aborted", whatever reason the caller
  gave and whatever was in flight, with what the adapter caught as its
  `rawError`. Before, every adapter but `AnthropicAdapter` typed the abort by
  its reason, as it would a failure of the request. A reason coded
  `ECONNRESET`, or wrapping one as its `cause`, was `network` and retryable;
  a `TimeoutError`, which `AbortSignal.timeout()` gives, was `timeout` and
  retryable; a string, a plain object or an `Error` without a code was
  `unknown`. `AnthropicAdapter` already gave `abort`, with no `rawError`.
  **Migration:** read `abort` for your own cancellation, as `Membrane`
  already gives, and don't retry it. **Unchanged:** the `type`, `retryable`
  and `message` of a call through `Membrane`'s `complete()`, and the aborted
  response, reason `user`, that `stream()` and `streamYielding()` give for
  the caller's own signal. The error `complete()` throws now carries the
  caller's reason, or what the Anthropic SDK threw, as its `rawError`, where
  it carried the adapter's own error or nothing. A deadline of the call's own
  (`timeoutMs`, `progressTimeoutMs`, progress bounds) stays a `timeout`. Any
  version of agent-framework, context-manager or connectome-host copes, since
  they call adapters only through `Membrane`.
