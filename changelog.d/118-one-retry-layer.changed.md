- Membrane is now the one layer that retries. `AnthropicAdapter`'s SDK client
  sends each request membrane makes once. Its own retries are off: two by
  default, inside each of membrane's attempts, on a 408, 409, 429 or 5xx
  response and on a connection failure. So a 429 left to the caller arrives
  after one send, and `attempts`, `backoff` and `retryDelaysMs` count every
  send. The keepalive's replays keep the SDK's default.
- What the SDK retried before delivery, membrane now retries on every adapter
  and entry point. A 5xx, a provider's 408 and a connection failure get
  `retry.maxRetries` attempts on the base schedule. **`retry.maxRetries` now
  defaults to 5 (it was 0)**, with waits of 1, 2, 4 and 8 seconds. If a retry
  layer of your own should be the only one, set it to 1, set
  `overloaded.maxRetries` to 0, and pass `retryRateLimits: false`, since a 529
  and a 429 have floors of their own. A 409, which the SDK also retried, stays
  non-retryable unless the API's `x-should-retry` says otherwise: Anthropic's
  Messages API doesn't document it. With `overloaded.maxRetries: 0`, a 529
  follows this base policy on every path; before, it wasn't retried on the
  streaming paths.
- A deadline that runs out on a request already sent isn't retried. The call
  still ends with a retryable `timeout`, which the caller may retry, but
  membrane doesn't spend another full deadline on it. That covers
  `AnthropicAdapter`'s idle and first-event watchdogs, the runtime's own
  fetch deadlines on the other adapters (undici's headers and body timeouts,
  300 s each by default; Bun's fetch timeout), and every timeout
  `AnthropicAdapter`'s SDK client reports. The SDK reports a connect
  timeout the same way, without its cause, so on `AnthropicAdapter` a connect
  timeout now reaches the caller after one send, where the SDK sent it three
  times. On the other adapters, on Node, a connect timeout
  (`UND_ERR_CONNECT_TIMEOUT`, `ETIMEDOUT`) is retried like any connection
  failure. Bun's fetch timeout doesn't say which stage ran out, so on Bun a
  stalled connect is left to the caller too.
- `AnthropicAdapter` reads the API's `x-should-retry` (it decides whether the
  error is retryable) and `retry-after-ms` (before `retry-after`), as the SDK
  did.
