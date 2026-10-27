- A request that can't reach its host says so in its error's `message`: the
  host it tried (the adapter's base URL's host and port, never its path,
  query or userinfo), what happened in plain words, and the transport code,
  with each address it was met at that isn't the host's. For example, "The
  request to api.anthropic.com failed: the connection was refused
  (ECONNREFUSED at 0.0.0.0:443)." It read "Connection error." through the
  Anthropic adapter, "fetch failed" through the others on Node, and the
  runtime's own text on Bun. It holds for every adapter's `network` and
  `timeout` errors whose causes carry a code, on Node and Bun, and each
  attempt Node makes at a name with several addresses is read. A code without
  plain words follows the error's own text, as in "fetch failed (EPROTO)".
  Unchanged: the text of a failure whose causes carry no code, of a credential
  resolver's own failure, and of a certificate failure typed `unknown`
  (through the fetch-based adapters on Bun); and `type`, `retryable` and
  `rawError`. `networkError()` takes the host's URL as an optional fourth
  argument.
- A `network` or `timeout` failure is never read as an overload by its
  message (`classifyFailure`, `isOverloadedError`), so a host or port that
  reads 529 doesn't move a connection failure onto the overloaded retry
  schedule. A status-less `network` or `timeout` failure whose own text held
  `529` or `overloaded_error` was read as an overload before, and now takes
  the retryable schedule.
