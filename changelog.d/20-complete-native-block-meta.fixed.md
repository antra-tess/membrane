- `Membrane.stream()` on the native-tools path (`streamWithNativeTools`) now tags every `onChunk`
  with the block type the provider is streaming (`thinking` / `text` /
  `tool_call`, with `visible` false for thinking) and emits `block_start` /
  `block_complete` through `onBlock`, mirroring the yielding-path fix from
  #19 (#20). Previously `meta.type` was hardcoded to `'text'` on every chunk
  and `onBlock` was never invoked from that path, so a caller wiring it to
  a UI saw thinking deltas as visible text. The deprecated
  `onContentBlockUpdate` pass-through is unchanged.
