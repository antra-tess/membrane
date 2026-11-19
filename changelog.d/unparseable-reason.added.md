- `ToolCall.unparseableReason` and `ToolUseContent.unparseableReason`: in XML
  tool mode, set beside `unparseableInput` on each call of a `function_calls`
  block refused whole. It's a sentence an executor can give the model: it
  locates what broke by invoke position where it can, names a tool or
  parameter only where that name is a plain identifier, names tags in words,
  and quotes none of the call's values. A sentence an adapter gives with a
  call it marks itself is kept as given.
