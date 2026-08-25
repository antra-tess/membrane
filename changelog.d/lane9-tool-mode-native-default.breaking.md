- **Everyone using `stream()` / `streamYielding()` with tools and no explicit
  `toolMode`:** the default tool mode is now `native`, not `xml`. XML tools
  ride in an assistant prefill, and current Anthropic models refuse assistant
  prefill outright — measured live 2026-08-25, `claude-sonnet-4-6`,
  `claude-opus-4-6/4-7/4-8`, `claude-sonnet-5` and `claude-fable-5` all answer
  a prefill-terminated conversation with HTTP 400 `"This model does not
  support assistant message prefill."` — so the out-of-the-box default aimed
  the library at a guaranteed 400 on the models most callers reach for.
  Migration: pass `toolMode: 'xml'` on the request to keep the old path; it
  still works on prefill-capable models (Claude 4.5 and earlier, including
  `claude-haiku-4-5`). A formatter that cannot carry native tools at all
  (`CompletionsFormatter`) still defaults to XML.
- **Formatter authors:** `PrefillFormatter` gained a required
  `supportsNativeTools: boolean`. It is what the new default reads, so a
  custom formatter must declare it — the in-tree formatters set it to `true`
  except `CompletionsFormatter`, whose text-completion wire shape has no tool
  channel.
- An assistant-message prefill aimed at a model that refuses one now
  fails fast with a typed `MembraneError` (`type: 'unsupported'`) naming the
  model, the formatter and the remedy, instead of surfacing the raw provider
  400. The measured model table lives in `src/registry/model-capabilities.ts`,
  in the same prefix-list shape as the existing `NO_TEMPERATURE_MODELS`.
