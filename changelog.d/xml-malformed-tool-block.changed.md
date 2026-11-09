- XML tool mode: a `function_calls` block whose tags break the format is
  refused whole, never dispatched with the arguments a lenient read made of
  it. That's a block with an invoke that has no closing tag (one the next
  invoke swallowed included), a value holding a parameter's or an invoke's
  opening tag or an invoke's closing tag, a parameter given twice, text inside
  an invoke outside its parameter elements, or a stray tag outside every
  invoke, which is any `<` in the block's text outside its invokes. Each
  named invoke opener in it becomes a call marked `unparseableInput` (the
  block's raw text) with `input` `{}` and a new `unparseableReason`: a
  sentence an executor can give the model, which says what broke and quotes
  none of the call's values. A block with no named invoke gives one such
  call, named `""`. A well-formed block parses as before, and a stored turn
  replays as before.
  - **Executors:** one that ignores `unparseableInput` runs each such call
    with `{}`, as it runs a native marked call.
  - **No re-anchoring:** the parser no longer re-anchors a swallowed invoke,
    so a block whose innermost call used to run now runs nothing. The
    turn-end warning about unclosed invoke heads is replaced by one naming
    each malformed block's defect.
