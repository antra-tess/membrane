- **Anthropic context-length heuristic is now gated on HTTP 400** (#17, #48).
  `AnthropicAdapter.handleError` classified any error whose message contained
  "context" or "too long" as non-retryable `context_length` regardless of
  status, so transient 5xx bodies like "Internal error: context processing
  failed" suppressed retries and failed permanently. Genuine prompt-too-long
  errors — including mid-stream SSE ones, whose status is recovered from the
  body's `invalid_request_error` type — still classify as `context_length`.
