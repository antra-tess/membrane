- The prefill/thinking guard now strips the extended-thinking config from BOTH
  channels the adapter's resolver reads — the top-level `thinking` param and
  `extra.thinking` (spread from `providerParams`). Only the top-level field was
  deleted before, so a caller passing thinking through `providerParams` had it
  re-inserted by the adapter's `Object.assign(params, rest)` — sending thinking
  plus an assistant prefill (the 400 the guard exists to prevent) and turning on
  the interleaved-thinking beta header with it. Both continuation builders (plain
  and split-turn image) are covered, and the split-turn builder now copies
  `providerParams` instead of aliasing it, so the strip cannot leak back into the
  caller's own request object.
- Disclosure: the underlying API premise is model-dependent as of 2026-08-25 —
  claude-haiku-4-5 accepts an assistant prefill (even with thinking enabled),
  while claude-sonnet-4-6 / claude-opus-4-8 / claude-sonnet-5 refuse assistant
  prefill outright. The guard stays correct on every model that accepts a prefill
  at all.
