- `streamYielding()`'s iterator no longer swallows an error thrown into it.
  `iterator.throw(e)` cancelled the producer (correctly) and then reported
  `done: true`, so `e` vanished: a generator delegating with `yield*` resumed
  after the delegation as if nothing had been thrown in, and a direct
  `.throw(e)` resolved instead of rejecting. It now departs the consumer and
  rethrows `e`, like an async generator with no handler of its own.
