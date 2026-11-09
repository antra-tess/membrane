- XML tool mode: a `function_calls` block whose tags break the format is
  refused whole, never dispatched with the arguments a lenient read made of
  it. That's a block with an invoke that has no closing tag (one the next
  invoke swallowed included), a value holding a parameter's or an invoke's
  opening tag or an invoke's closing tag, an invoke or parameter name holding
  `<` or `>`, an invoke name holding a line terminator, a parameter given
  twice, text inside an invoke outside its parameter elements, or a stray tag
  outside every invoke, which is any `<` in the block's text outside its
  invokes. A block whose opening tag comes while an earlier `function_calls`
  opening tag is still unclosed is refused too, from that tag on, which costs
  one refused round: the resend runs. That's an earlier block max_tokens
  cut, even right after its opening tag, one whose value held the later tag,
  or text before the block that named the tag. In `stream()` and the event
  stream the earlier tag may be in an earlier turn. `complete()` reads only
  the new output, so it refuses such a block only when the earlier tag is in
  that output.
  Each named invoke opener in a refused block becomes a call marked
  `unparseableInput` (the block's raw text) with `input` `{}` and a new
  `unparseableReason`: a sentence an executor can give the model, which says
  what broke and quotes none of the call's values. A block with no named
  invoke gives one such call, named `""`. A well-formed block parses
  as before, and a stored turn replays as before, except two calls stored
  side by side from byte-identical blocks that each held a swallowed invoke,
  which now replay as one block.
  - **Executors:** one that ignores `unparseableInput` runs each such call
    with `{}`, as it runs a native marked call.
  - **No re-anchoring:** the parser no longer re-anchors a swallowed invoke,
    so a block whose innermost call used to run with its arguments now gives
    only marked calls, with `{}` for input. The turn-end warning about
    unclosed invoke heads is replaced by one naming each malformed block's
    defect.
