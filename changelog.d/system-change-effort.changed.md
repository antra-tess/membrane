- System changes can change the effort: a `system_change` block may carry `effort`
  (`'low' | 'medium' | 'high' | 'xhigh' | 'max'`), alone in its block and its message.
  `NativeFormatter` and `AnthropicAdapter` send it as a `role: 'system'` message with empty
  content and `output_config: { effort }`, with the beta `mid-conversation-output-config-2026-07-01`,
  and the API applies it from the next user turn on, so a caller changes effort without changing the
  request's top-level `output_config.effort`, which would rewrite the cached prompt. Unlike a change
  of tools or system text, it goes exactly at its place (the API took one before a user turn and
  between a tool call and its result); its `cacheBreakpoint` goes on the last block before it. A model
  without per-turn effort refuses it with a 400 that's marked `systemChangeRefused`, as is a request
  carrying it through another formatter or adapter, Bedrock's included, before sending. A block with
  `effort` beside another change is refused as unsupported. `SYSTEM_CHANGE_EFFORT` (`true`) tells a
  caller that its membrane carries `effort`: an earlier one leaves an effort-only block out as empty.
