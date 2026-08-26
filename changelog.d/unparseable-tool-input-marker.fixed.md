- A streamed Anthropic tool call whose arguments never assembled into valid
  JSON no longer persists as a plausible empty-argument call. Two limbs: the
  accumulator's `catch { /* partial JSON */ }` discarded an unparseable
  accumulation, and a `max_tokens` truncation of a tool call sends NO
  `content_block_stop` at all (measured live against `claude-haiku-4-5`,
  2026-08-25), so every `input_json_delta` fragment was dropped on the floor
  and the block kept the `input: {}` that `content_block_start` carried —
  indistinguishable from a genuine no-arg call once written to history and
  re-shipped on the next compile. A block left open when the turn ends is now
  finalized (its accumulated text is no longer lost either), the raw argument
  text stays on the block as the typed `ToolUseContent.unparseableInput` —
  whose presence means `input` is not the model's arguments — and membrane's
  `parseProviderContent` surfaces it to the caller.
