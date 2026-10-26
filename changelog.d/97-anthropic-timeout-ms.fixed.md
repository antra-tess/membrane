- The Anthropic adapter honours `timeoutMs` as a deadline on each request it
  sends, streamed or not, through `createCombinedSignal` as every other adapter
  does (#97). It used to be inert there: the SDK's own timeout clears once
  response headers arrive, so a stream that kept sending deltas, or a response
  whose body never finished, had no bound. The deadline classifies as the same
  `TimeoutAbortError` the other adapters' `timeoutMs` gives (type `timeout`,
  not retryable), distinct from the idle watchdog's retryable stall timeout.
