- Refusal retries no longer hide the spend they discard. A re-issued attempt
  is a completed, billed provider call, and only the surviving attempt's
  usage was ever reported. `details.usage.discardedAttempts` now sums the
  abandoned attempts (count, tokens, cache tokens and estimated cost) on
  `complete()` and on the native yielding stream; the response's own `usage`
  still describes the attempt that stands.
