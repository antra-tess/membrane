- Yielding streams report each provider round that stands. The `usage`
  event carries `round` (`RoundReport`) with the round's index, mapped stop
  reason and own usage, and `altered`: the consumer messages that round's
  request did not carry verbatim. Messages are addressed by
  `NormalizedRequest.messages` index, and injected messages as
  `[batch, index]` into the array as supplied, for every batch still
  retained; tool blocks stripped from an injected message make it altered.
  `fidelity` is `unknown` whenever an empty list would prove nothing: an
  uninstrumented formatter or adapter, opt-in image shedding, a
  `beforeRequest` hook that changed either of its arguments (the provider
  request by replacement or in place, or the normalized request in place;
  an in-place change keeps every later round `unknown` too), or an adapter
  alteration that could not be attributed. Otherwise it is `established`.
  `injectedBatch` gives the newest batch and how many of its supplied
  positions the round accounts for: all of them on the native path, none on
  the XML prefill path. With established fidelity, each was carried
  verbatim unless `altered` names it, as it names a message whose tool
  blocks were stripped even when nothing else of it was sent.
  `ToolContext.supportsInjectedMessages` says which path applies.
- **Formatters and provider adapters:** `PrefillFormatter.reportsAlterations`
  and `ProviderAdapter.reportsContentAlterations` declare that a path reports
  what it does not carry verbatim. Formatters record alterations in
  `BuildOptions.fidelity`. Adapters call the new
  `ProviderRequestOptions.onContentAltered`, which decorators must forward,
  along with the capability. All built-in formatters, and the Anthropic,
  Bedrock, Responses API and mock adapters, declare it; an undeclared path
  makes rounds `unknown`.
- **Raw forms:** where a path sends a provider-native raw form in place of
  the fields it stands in for (on the OpenAI Responses formatter, a block's
  `rawItem` and a message's `openaiResponsesItems`; in the Responses API
  adapter, a `redacted_thinking` block's reasoning `rawItem`; on the XML
  prefill path, `rawXml`), that raw form is what the round carries. The
  block or message counts as carried verbatim when its raw form is, and the
  fields it stands in for are not compared with it, so a consumer that edits
  content under a raw form must drop or replace the raw form, or the edit
  doesn't reach the provider. A zero-width carrier (`''` text holding an
  object `rawItem`) that a path leaves out, as every built-in path but the
  Responses formatter does, alters its message.
- **Provider adapters:** `ProviderRequestOptions.onContentAltered(block?)`
  takes the request's own block when one block was altered, and membrane
  attributes it to the message that block came from. Declaring adapters
  report through the final body, passthrough parameters and cleanup
  included. Anthropic and Bedrock now report whitespace-only text removed by
  their empty-text cleanup (an exactly empty `''` block is still no loss), a
  passthrough `messages` that replaces the built messages, and nested
  tool-result blocks with no wire form.
- `normalizeToolPairs` tells a caller that follows blocks by identity which
  ones it replaced with new objects: `NormalizeOptions.onBlockRewritten` for
  an orphan `tool_result` rewritten as text, and `onBlockCopied` for a block
  copied to drop `cache_control`. Membrane's builders use them to attribute
  those occurrences.
- `ProviderResponse.unreportedUsage` names the required counts
  (`inputTokens`, `outputTokens`) a provider did not report. Their 0 in
  `usage` stays for accounting, and round reports leave them out. Every
  built-in adapter sets it. A round report's `usage` (`RoundUsage`) carries
  token counts only, never accounting's `estimatedCost`.
