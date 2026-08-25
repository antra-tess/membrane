- `openai-compatible` and `openai-completions` now request streamed usage
  (`stream_options.include_usage`) and report the token counts the server
  sent. Both adapters previously hardcoded `inputTokens: 0, outputTokens: 0`
  on every streamed call behind a comment claiming the data was unavailable —
  it is the same endpoint and wire format their `openai` and `openrouter`
  siblings already read usage from — which zeroed cost estimates, cache-hit
  ratios and any caller-side token budget. Zeros remain only as the
  genuinely-absent fallback for an endpoint that ignores `stream_options`.
