- A request cancelled by an adapter's own `timeoutMs` deadline now reports
  itself as a timeout all the way out. Every `fetch`-based adapter (OpenAI,
  OpenAI-compatible, OpenAI Completions, both OpenAI Responses adapters,
  OpenRouter, Gemini, Bedrock) caught the deadline's `AbortError` and replaced
  it with a generic abort, so `stream()` handed back `reason: 'error'` where
  `reason: 'timeout'` was documented, and `complete()` rejected with
  `type: 'abort'` and the message "Request was aborted". The deadline now
  marks the abort reason it raises, and the adapters map that marked abort to
  a non-retryable `type: 'timeout'` error (`TimeoutAbortError`, exported)
  which the streaming paths still treat as a cancellation — partial content,
  tool calls and tool results are reported exactly as before.
- A caller's own cancellation is unaffected: it still reports `reason: 'user'`
  whenever the caller's signal fired, including when it beats a deadline that
  was also armed.
