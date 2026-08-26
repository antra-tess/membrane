- One formatter is now selected per request and used by every part of it. The
  Responses transport keeps a configured `OpenAIResponsesFormatter`
  authoritative over a per-request `options.formatter` override, but that rule
  lived inside request building alone: tool-mode resolution and the stream
  parser read the override instead, so an override against the Responses
  adapter built a Responses-item request and then ran the XML tool loop over it
  — one provider call, no `onToolCalls`, `stopReason: 'tool_use'` dropped on the
  floor. `Membrane.resolveActiveFormatter` now makes that selection once per
  call and threads the instance to mode resolution, request building, the tool
  loop and the stream parser.
- The native tool loop builds with the per-request formatter override.
  `buildNativeToolRequest` read the instance formatter while resolution had
  already honored the override, so `stream()` with an
  `options.formatter` of `OpenAIResponsesFormatter` selected the native loop and
  then built Anthropic-style envelopes through the legacy path instead of
  Responses input items.
- `streamYielding()` resolves its tool mode through the same selection rather
  than calling the resolver with no formatter at all.
