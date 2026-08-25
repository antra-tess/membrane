- Tool-pair normalizer: hoisting results back from a downstream envelope no
  longer reverses them. Phase 3 unshifted each hoisted `tool_result` onto the
  front of the cycle's user envelope, so a turn whose two calls were answered
  in one downstream batch came back as results `[ite2, ite1]` — wire-valid,
  but the model read its results in an order that did not match the order it
  made the calls. Each hoisted result is now placed at its own call's
  position, which is still the front while no earlier call's result has
  landed, so hoisted results keep preceding any interloping content.
