- Always remove private Responses prompt-cache carriers from wire input and
  exclude them from routing hashes, including when a `beforeRequest` hook
  disables or deletes `responsesPromptCache` after formatting.
- Clarify that explicit Responses caching requires selecting
  `OpenAIResponsesFormatter` at construction or per call and setting
  `responsesPromptCache` on the request, not in `providerParams`/`extra`.
  The generic/default formatter's marked-boundary refusal is unchanged.
