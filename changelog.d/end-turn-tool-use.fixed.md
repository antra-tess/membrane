- **Backport of 0.7.1's fix (#168) to 0.6.x.** A round the provider ends with
  a literal `stop_reason: end_turn` while its content holds complete client
  tool calls now runs as a `tool_use` round on both native tool loops
  (`stream()` with `onToolCalls`, and `streamYielding()`), and `complete()`
  returns it as a `tool_use` stop. Before, every native loop gated execution
  on `tool_use` alone, so the calls never ran and the turn ended as if
  finished, with nothing logged; production Anthropic responses had this
  shape on 2026-10-19. A call is complete when its block stopped and its
  input parsed to an object (no `unparseableInput`); a round holding an
  incomplete call runs nothing, as before. A length, refusal, stop-sequence
  or pause stop never qualifies, nor does a provider token membrane doesn't
  map, nor a round with no provider stop token at all. Each occurrence warns
  once, through the configured `logger` when one is set, with the model, the
  tool names and the message and request ids, and is recorded in
  `details.anomalies` (`ToolUseWithEndTurnAnomaly`: `kind:
  'tool_use_with_end_turn'`, `round`, `providerStopReason`, `toolNames`,
  `toolUseIds`, `treatedAsToolUse`, `model`, `messageId`, `requestId`). The
  Anthropic stream adapter now holds block events to the API's order (a
  start while no block is open, at the next index, then that block's deltas,
  a tool call's being only its arguments, and its stop); the first event out
  of that order stops block events being applied and marks every `tool_use`
  block in the response `unparseableInput`, so none of them runs on an
  `end_turn` round.
  - **Not in this backport:** the Bedrock adapter's block-order checks and its
    stop at `message_delta`, which need stream helpers from 0.7; 0.7.1 has them.
