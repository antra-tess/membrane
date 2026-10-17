- `streamYielding()` yields a `backoff` event before each wait to send a
  failed call again, with the schedule (`overloaded` or `base`), the
  retry about to be issued, the most retries for the call, the delay and the
  error. Nothing from the failed call was emitted, so unlike `retrying` there
  is nothing to discard. `cancel()` or the caller's signal ends the wait. A
  consumer that rejects event types it doesn't know should accept this one.
  The final response's `details.timing.retryDelaysMs` lists the waits, as on
  `stream()`.
- `MembraneError.attempts` says how many times membrane sent the request for
  the failure: 1 when membrane didn't retry it, as for a call that failed
  after delivering anything, and more when it sent the request again after
  earlier sends failed before anything arrived. It's set by `complete()`, and
  by each provider call of `stream()` and `streamYielding()`: in a tool loop
  it counts the round that failed, and a refusal re-issue (`refusalRetries`)
  starts the count again. A caller with its own retry policy can tell from it
  whether membrane has already retried a failure.
- A per-call `retryRateLimits` option on `complete()`, `stream()` and
  `streamYielding()`. With `false`, a 429 is the caller's: membrane doesn't
  retry it and gives it to the caller at once, with the provider's stated wait
  on `retryAfterMs`. For a caller that paces rate limits itself, such as an
  agent framework sharing one organization's limit across its agents. A 529
  is still retried. The default keeps today's behaviour.
