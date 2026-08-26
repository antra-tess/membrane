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
- Disclosure: the underlying API premise is model-dependent now. Measured live
  2026-08-25 against the Anthropic Messages API: `claude-haiku-4-5-20251001`
  accepts an assistant prefill AND accepts it together with
  `thinking: {type: 'enabled'}` (HTTP 200), while `claude-sonnet-4-6` refuses
  assistant prefill outright ("This model does not support assistant message
  prefill"). So the strip is no longer a bare 400-avoidance rule on
  haiku-class models: it is the prefill path's design — the XML formatter uses
  the thinking config to emit a literal `<thinking>` text prefix rather than
  the API feature, and sending both would pay for API thinking that the
  prefill format does not consume. On models that reject the combination it
  remains the 400 guard it always was; either way the two channels must agree.
