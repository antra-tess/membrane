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
