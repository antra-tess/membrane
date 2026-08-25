- Mid-stream SSE `error` frames inside an HTTP 200 now throw on every SSE
  adapter (`openai`, `openai-compatible`, `openai-completions`, `gemini`)
  instead of being dropped. Previously such a frame matched no
  `choices`/`candidates` branch, was swallowed by the loop's parse-error
  catch, and the adapter built a well-formed success from the content that had
  arrived so far — `end_turn`, `wasTruncated: false`, zero usage — which a
  caller cannot distinguish from the model choosing to stop, and which
  persists as a silently truncated turn. The check is the one `openrouter`
  already carried (see `tests/unit/openrouter-stream-error.test.ts`, whose
  header names the fake-successful-empty-completion failure) and which
  `openai-responses-api` states in its own comment; both now share a single
  `throwOnStreamErrorFrame` helper with the four adapters the fix never
  reached.
- A mid-stream `error` frame now keeps the classification the provider gave
  it. `throwOnStreamErrorFrame` threw a bare `Error`, leaving the frame's
  `code`/`type`/`status` as prose that each adapter's `handleError` then
  re-derived a category from by substring match — so a 429 arriving as
  `status: 429`, with no literal "429" in the message, normalized to
  `unknown, retryable: false` and suppressed the retry the provider had
  explicitly asked for. The helper now classifies from the structured fields
  before throwing: 429 or a rate-limit-shaped token becomes a retryable rate
  limit carrying the frame's retry hint (`retry_after`, `retryAfterMs`,
  `retryDelay`), 5xx or an overloaded-shaped token becomes a retryable server
  error (overloaded-without-a-status takes 529, so it lands on the capacity
  backoff schedule), and 401/403 or an auth-shaped token becomes a
  non-retryable auth error. Unrecognized frames still throw the previous bare
  `Error`, now with `code` and `type` preserved in the message. The provider's
  own message text is never dropped, and the raw frame and request ride along
  on the classified error.
- The Responses API adapter's own two error-frame throw sites (`response.failed`
  and the `error` event) route through that same classification. They dispatch
  on `event.type` rather than running the shared SSE line loop, so they had
  their own structureless throws: a frame whose code did not happen to contain
  a substring the adapter's `handleError` matches — `overloaded_error`,
  `too_many_requests`, `permission_denied` — normalized to unknown and
  non-retryable. The token lists now have a single source of truth.
- A Responses API terminal response carrying a structured `error` object on an
  HTTP 200 is classified the same way, from both paths that reach it: the
  stream's terminal frame (`response.completed`/`response.incomplete`) and a
  non-streaming response body. A 200 carrying an error object never reaches an
  HTTP-status classifier, so these had no other route to a category. The
  non-streaming failure is no longer described as a stream error.
