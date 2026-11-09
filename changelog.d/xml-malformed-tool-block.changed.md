- XML tool mode: a `function_calls` block whose tags break the format is
  refused whole, never dispatched with the arguments a lenient read made of
  it. That's a block with an invoke that has no closing tag (one the next
  invoke swallowed included), a value holding a parameter's or an invoke's
  opening tag as the block's own are written (`<parameter name="…">`,
  `<invoke name="…">`) or an invoke's closing tag, an invoke or parameter
  name holding `<` or `>`, an invoke name holding a line terminator, a
  parameter given twice, text inside an invoke outside its parameter
  elements, or a stray tag outside every invoke, which is any `<` in the
  block's text outside its invokes. Any other text in a value passes as
  before, tags named parameter or invoke written another way included, and a
  closing parameter tag ends the value wherever it stands, as before. A block
  whose opening tag comes while an earlier `function_calls` opening tag is
  still unclosed is refused too, from that tag on, which costs one refused
  round: the resend runs. That's an earlier block max_tokens cut, even right
  after its opening tag, one whose value held the later tag, or text before
  the block that named the tag. In `stream()` and the event stream the
  earlier tag may be in an earlier turn, a user's message included, but only
  in the text the stream parses: the request's assistant prefill, which holds
  the conversation after the last cache breakpoint, with prompt caching on,
  the default, and after the last image the request sends. A user's message
  there whose tag is still unclosed when the model's block opens costs that
  block one refused round, and the sentence the model gets can't say the tag
  is the user's. A later request is refused the same way only if that
  refused exchange isn't kept. `complete()` reads only the new output, so it
  refuses such a block only when the earlier tag is in that output. A model
  that names the tag in text before every block is refused each time, and
  the sentence it gets says why.
  Each named invoke opener in a refused block becomes a call marked
  `unparseableInput` (the block's raw text) with `input` `{}` and a new
  `unparseableReason`: a sentence an executor can give the model, which says
  what broke and quotes none of the call's values. A block with no named
  invoke gives one such call, named `""`. A well-formed block parses
  as before, and a stored turn replays as before, except calls stored side
  by side from byte-identical blocks that each held a swallowed invoke or an
  invoke opener whose name can't be read, which now replay as one block.
  - **Executors:** one that ignores `unparseableInput` runs each such call
    with `{}`, as it runs a native marked call.
  - **`complete()`:** its tool parse reads the output only through the
    first closing `function_calls` tag, so when a provider doesn't apply
    that stop, a block after it gives no tool calls. `content` and
    `rawAssistantText` keep the whole output, as before.
  - **No re-anchoring:** the parser no longer re-anchors a swallowed invoke,
    so a block whose innermost call used to run with its arguments now gives
    only marked calls, with `{}` for input. The turn-end warning about
    unclosed invoke heads is replaced by one naming each refused block's
    defect.
  - **Siblings:** agent-framework gives the model a marked call's
    `unparseableReason` from the release that carries
    anima-research/agent-framework#1005. An earlier release refuses such a
    call with its own sentence, which asks for the arguments as one JSON
    object and quotes the start of the block's raw text.
