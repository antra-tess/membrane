- **Formatter authors:** `PrefillFormatter` gained a second required flag,
  `buildsAssistantMessagePrefill: boolean` — does this formatter's built
  request END on a genuine assistant-role turn of a Messages-style chat
  transport? Declare `true` only for that shape. It is deliberately narrower
  than `usesPrefill`: the in-tree formatters set it `true` for
  `AnthropicXmlFormatter` alone.
- The assistant-prefill fast-fail now scopes to that flag instead of the
  generic `usesPrefill` / `BuildResult.assistantPrefill` pair, so a
  text-completions surface is no longer refused for a model id it never sends
  to a Messages API. `CompletionsFormatter` declares `supportsNativeTools:
  false` and returns its entire single-string prompt as `assistantPrefill`, so
  the previous check refused e.g. `claude-sonnet-4-6` through it before the
  adapter was ever called — even though no assistant-role Messages request is
  built and the conversation never "ends in an assistant turn" in the sense
  the provider means. Membrane + `CompletionsFormatter` now passes any model id
  through; the refusal for real Messages prefill builds is unchanged.
