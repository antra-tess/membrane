- The Anthropic adapter honours `timeoutMs` as a whole-call deadline on
  `stream()` and `complete()`, through `createCombinedSignal` as every other
  adapter does (#97). It used to be inert there: the SDK's own timeout clears
  once response headers arrive, so a stream that kept sending deltas had no
  whole-call bound. The deadline classifies as the same `TimeoutAbortError`
  the other adapters' `timeoutMs` gives (type `timeout`, not retryable),
  distinct from the idle watchdog's retryable stall timeout.
