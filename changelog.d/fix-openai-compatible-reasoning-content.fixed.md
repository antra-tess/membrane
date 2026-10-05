- `openai-compatible` now captures a reasoning trace delivered as
  `reasoning_content` (the DeepSeek spelling, used e.g. by Xiaomi's official
  MiMo API in both non-streamed messages and stream deltas) into a thinking
  block. It was previously read only from `reasoning`, so on those endpoints the
  trace was silently dropped: never persisted, never re-sent on later turns.
  `reasoning` keeps precedence when a backend sends both, so OpenRouter-style
  responses are unchanged; the outbound round trip still re-sends the trace as
  `reasoning` on prior assistant turns.
