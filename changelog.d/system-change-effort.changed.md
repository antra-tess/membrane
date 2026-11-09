- System changes can change the effort: a `system_change` block may carry `effort`
  (`'low' | 'medium' | 'high' | 'xhigh' | 'max'`), alone in its block and its message.
  `NativeFormatter` and `AnthropicAdapter` send it as a `role: 'system'` message with empty
  content and `output_config: { effort }`, with the beta `mid-conversation-output-config-2026-07-01`,
  so a caller changes effort without changing the request's top-level `output_config.effort`, which
  would rewrite the cached prompt. Placed directly after a user turn with new input, it sets the effort
  for the reply to that turn; anywhere else, from the next user turn with new input (Anthropic's effort
  documentation, "Change effort mid-conversation"). Unlike a change of tools or system text, it goes
  at its place, right after the turn holding the last block of a message before it: exactly there
  unless messages of one role that membrane merges into one turn lie on both sides of it, when it goes
  after that turn, which governs the same reply. One that would end
  the request after an assistant turn is refused before sending, flagged `systemChangeRefused`. Its
  `cacheBreakpoint`, or a boundary at its place, goes on the last block before it that can hold one. The
  API's refusals of it, on a model without per-turn effort and on a thinking setting that fixes the
  effort, are marked `systemChangeRefused`, as is a request carrying it through a formatter that doesn't
  render system changes or an adapter that doesn't send them, Bedrock's included, before sending, unless
  the formatter can't carry the request's tools at all, which is refused first, unflagged. `BedrockAdapter`
  refuses one given to it directly the same way, before its own cleanup. A block with `effort` beside another change, or with an
  `effort` that isn't one of the five levels, is refused as unsupported. The cache wire receipt hashes
  such a message's `output_config` into the prefixes after it. `SYSTEM_CHANGE_EFFORT` (`true`) tells a
  caller that its membrane carries `effort`: an earlier one leaves an effort-only block out as empty.
