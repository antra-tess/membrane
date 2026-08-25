- Tool-pair normalizer: the pairing invariant is now enforced in both
  directions. Every phase asked only "does each `tool_use` have its
  `tool_result` in the next user envelope?", so a `tool_result` whose
  `tool_use` was not in the immediately-preceding assistant envelope passed
  all eight phases and validation on its way to the 400 this module exists to
  prevent. Three reachable shapes are repaired: an out-of-order append and a
  leading result are relocated into their own cycle (payload preserved as a
  real `tool_result`, and no spurious `[pending]` is synthesized over a result
  that actually landed), and a duplicate re-append after a later turn is
  textified. `validate` now asserts the converse as well as the forward rule.
- Tool-pair normalizer: orphan textification no longer destroys array-form
  `tool_result` content. `ToolResult.content` may be a block array (image
  results ride it), and recovery read only the string branch, replacing every
  array payload with the empty string. Text parts are now joined and images
  become `[Image: <media-type>, ~<n>KB]` placeholders.
- `NormalizeEvent`: `orphan_tool_result_textified` carries `recoveredChars`
  so a payload drop can never be silent, and a new
  `stray_tool_result_textified` event reports duplicate results converted to
  text. `tool_result_hoisted` now also fires for a result pushed DOWN into its
  own later cycle (`fromEnvelope < toEnvelope`) — the mirror of phase 3's
  existing pull-back from downstream (`fromEnvelope > toEnvelope`).
