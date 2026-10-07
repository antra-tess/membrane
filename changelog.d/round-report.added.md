- Yielding streams report each provider round that stands. The `usage`
  event carries `round` (`RoundReport`) with the round's index, mapped stop
  reason and own usage, and `altered`: the consumer messages that round's
  request did not carry verbatim. Messages are addressed by
  `NormalizedRequest.messages` index, and injected messages as
  `[batch, index]` for every batch still retained. `fidelity` is `unknown`
  whenever an empty list would prove nothing: an uninstrumented formatter or
  adapter, opt-in image shedding, a `beforeRequest` hook that changed the
  request, or an adapter that altered content. Otherwise it is
  `established`. `injectedBatch` gives the newest batch and how much of it
  the round carried: all of it on the native path, none on the XML prefill
  path. `ToolContext.supportsInjectedMessages` says which applies.
- **Formatters and provider adapters:** `PrefillFormatter.reportsAlterations`
  and `ProviderAdapter.reportsContentAlterations` declare that a path reports
  what it does not carry verbatim. Formatters record alterations in
  `BuildOptions.fidelity`. Adapters call the new
  `ProviderRequestOptions.onContentAltered`, which decorators must forward,
  along with the capability. All built-in formatters, and the Anthropic,
  Bedrock, Responses API and mock adapters, declare it; an undeclared path
  makes rounds `unknown`.
