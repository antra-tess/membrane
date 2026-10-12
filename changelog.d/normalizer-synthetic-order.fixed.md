- Tool-pair normalizer: a synthetic `[pending]` result is now inserted at its
  own `tool_use`'s position instead of at the front of the cycle's user
  envelope. With two calls in one turn where only the first landed, the
  `[pending]` for call #2 was placed ahead of call #1's real result — still
  wire-valid, but the model read its results in an order that did not match
  the order it made the calls.
