- `ToolCall.unparseableReason` and `ToolUseContent.unparseableReason`: in XML
  tool mode, set beside `unparseableInput` on each call of a `function_calls`
  block refused for breaking the format, and never set otherwise. It's a
  sentence an executor can give the model: it names the invoke by position, a
  tool or parameter name only where that's a plain identifier, and tags in
  words, and quotes none of the call's values.
