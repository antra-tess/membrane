- Tool-pair normalizer: the module header no longer claims "every formatter
  funnels through `normalizeToolPairs`". It names the real coverage instead —
  `NativeFormatter.buildMessages` and `Membrane.buildNativeToolRequest` are
  covered; `anthropic-xml` and `completions` emit flattened text and need no
  net; `openai-responses` carries provider-native `function_call` /
  `function_call_output` items, genuinely needs pairing discipline, and is
  deliberately routed around the Anthropic-specific builder to preserve item
  ids, encrypted reasoning and compaction items — so its `ready: true` is a
  hardcoded literal rather than a checked claim. An items-level pairing pass
  for that shape is recorded as future work.
