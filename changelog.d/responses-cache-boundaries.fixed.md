- Preserve opt-in Responses cache marks through copying `beforeRequest` hooks.
  Native histories whose normalization merges past or loses a marked boundary
  now reject before fetch with guidance to use `OpenAIResponsesFormatter`,
  rather than writing after volatile content. Tool/reasoning tails fall back
  to the latest eligible message item in the stable prefix; skipped marks
  without an eligible target are counted in a non-wire debug diagnostic.
