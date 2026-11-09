- System changes can change the effort: a `system_change` block may carry `effort`
  (`'low' | 'medium' | 'high' | 'xhigh' | 'max'`), alone in its block and its message.
  `NativeFormatter` and `AnthropicAdapter` send it as a `role: 'system'` message with empty
  content and `output_config: { effort }`, with the beta `mid-conversation-output-config-2026-07-01`,
  so a caller changes effort without changing the request's top-level `output_config.effort`, which
  would rewrite the cached prompt. Placed directly after a user turn with new input, it sets the effort
  for the reply to that turn; anywhere else, from the next user turn with new input (Anthropic's effort
  documentation, "Change effort mid-conversation"). Unlike a change of tools or system text, it goes
  exactly at its place, or at the end after a user turn; one that would end the request after an
  assistant turn is refused before sending, flagged `systemChangeRefused`. Its `cacheBreakpoint` goes
  on the last block before it. The API's refusals of it, on a model without per-turn effort and on a
  thinking setting that fixes the effort, are marked `systemChangeRefused`, as is a request carrying it
  through another formatter or adapter, Bedrock's included, before sending. A block with `effort`
  beside another change is refused as unsupported. `SYSTEM_CHANGE_EFFORT` (`true`) tells a caller that
  its membrane carries `effort`: an earlier one leaves an effort-only block out as empty.
