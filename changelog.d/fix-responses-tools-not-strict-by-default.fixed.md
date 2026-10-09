- `openai-responses` (and adapters built on it, such as a Codex subscription
  adapter) now sends membrane-format and Chat Completions-format function tools
  with `strict: false` unless the tool sets `strict` itself. The Responses API
  treats an omitted `strict` as `true`, which made every property required:
  models filled optional arguments with zero values (`""`, `0`) that tool
  handlers then read as real input. Native Responses function tools are still
  passed through unchanged.
