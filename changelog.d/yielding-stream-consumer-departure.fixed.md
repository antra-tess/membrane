- The yielding stream's iterator now implements `return()`/`throw()`, so
  breaking out of `for await` cancels the producer instead of leaving it
  streaming, auto-resuming and re-sending full context to a consumer that
  left (measured: 25 provider calls after the break, now 1).
- A departed consumer's queued events are dropped rather than accumulated
  without bound, and the stream removes its abort listener from the caller's
  signal at terminal — a long-lived shared signal no longer collects one
  closure per stream.
