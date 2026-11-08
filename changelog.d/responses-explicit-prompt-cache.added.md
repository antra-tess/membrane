- Add opt-in `responsesPromptCache: { enabled: true, ttl?: string }` per request
  for OpenAI Responses API-backend-only explicit prompt-cache writes.
  Caller-marked messages write at their last eligible message item at or before the marked boundary,
  keeping the latest three writes and reserving the implicit tail's slot.
  TTLs are validated independently of Anthropic's `cacheTtl`; defaults and
  cache routing are unchanged. Wire extensions are operator-reported, not
  validated against the live API. The option is ignored on the ChatGPT
  subscription backend because it rejects these fields: no fields/carriers,
  identical on/off request bytes, and one count-only stderr warning per adapter.
  Backend mode, not baseURL, controls support through custom proxies; raw
  rejected fields are stripped in subscription mode even with the option off.
