- Add opt-in `responsesPromptCache: { enabled: true, ttl?: string }` per request
  for OpenAI Responses API and Codex subscription explicit prompt-cache writes.
  Caller-marked messages write at their last eligible message item at or before the marked boundary,
  keeping the latest three writes and reserving the implicit tail's slot.
  TTLs are validated independently of Anthropic's `cacheTtl`; defaults and
  cache routing are unchanged. Wire extensions are operator-reported, not
  live-provider verified.
