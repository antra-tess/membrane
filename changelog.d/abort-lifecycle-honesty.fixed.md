- An abort landing during the overloaded (529) backoff sleep is now handled
  like every other cancellation: `stream()` returns an `AbortedResponse` (as
  its docstring promises) and `complete()` rejects with a `MembraneError`,
  instead of a raw `AbortError` escaping the retry loop. Whether a
  cancellation was a return value or a throw used to depend on which
  millisecond it landed in.
- Aborted results now report why they aborted instead of always claiming
  `reason: 'user'`. A caller signal that fired is still `'user'`; an
  adapter-side request timeout reports `'timeout'`, and anything else that
  reached the abort path reports `'error'`.
