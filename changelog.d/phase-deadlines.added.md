- `AbortedResponse` and the yielding stream's `aborted` event carry
  `message` when the caller didn't end the call: the error's message, which
  for a deadline names the bound that ran out and what it was sized from.
  A cancel by the caller has none.
