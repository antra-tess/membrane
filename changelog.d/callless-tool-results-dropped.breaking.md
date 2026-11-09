- **Callers that read `hooks.onNormalize` or call `normalizeToolPairs`:** a
  tool result without its call, and a second result for a call that already
  has one, are left out of the request, never sent as text.
  `NormalizeEvent`'s `orphan_tool_result_textified` is now
  `orphan_tool_result_dropped` (`toolUseId`), and `stray_tool_result_textified`
  is now `stray_tool_result_dropped` (`toolUseId`, `reason`, and
  `fromEnvelope` on the native path only, where it is set as before).
  Neither carries `recoveredChars`, and `reason` gains `'answered'`, which
  the builders without the normalizer's turns send. The Responses formatter
  and `AnthropicXmlFormatter` in XML tool mode now report their drops through
  `onNormalize` with these two events too, so a host hears each drop through
  one listener whatever its path. `NormalizeOptions.onBlockRewritten` is
  gone: `onBlockDropped` hears each block left out, and `onBlockReplaced` each
  block put in an input block's place.
  - **What a request carries now:** `NativeFormatter`, and
    `AnthropicXmlFormatter` in native tool mode, leave such a result out. A
    cache marker it carried moves to the last cacheable block before it,
    unless that block carries one already, and a user turn the drop empties
    stays, holding the leading text (`prefillUserMessage`, else
    `[continuing]`), so no request becomes a prefill and no two assistant
    turns merge. A second result is left out even when it, not the first, was
    the real output behind a placeholder. `AnthropicXmlFormatter` in XML tool
    mode leaves out a result that answers no call: one whose id names a call
    pairs with it when the call comes before it and nothing answered it yet,
    and one whose id names no call pairs by position with a call before it in
    its own message, as a generation parsed back from its text holds them. A
    breakpoint on a message that leaves empty marks what came before it. On
    every path the round report marks the message a result came from as
    altered.
  - **Migration:** a hook that matches the old kinds matches the new ones,
    without `recoveredChars`; a switch over `reason` needs a case for
    `'answered'`, and code that reads `fromEnvelope` must allow it absent. A
    caller whose history pairs every result with its call once sees no
    difference.
  - **Unchanged:** a result whose call is in the request, wherever the
    normalizer moves it, and the `[pending]` result a call without one gets.
  - **Siblings:** none of agent-framework, connectome-host and
    context-manager reads these events or options at runtime, so every
    release of each copes. context-manager's tests name the old kinds, so
    when it widens its range to this release they need the new ones in two
    files. In `test/tool-cycle-in-one-message.test.ts` they sit in a
    `Set<NormalizeEvent['kind']>`, which its typecheck flags. In
    `test/compression-shape-invariants.test.ts` they sit in an untyped
    `STAND_IN_REPAIRS`, which no typecheck flags: its wire-validating guard
    would stop catching these repairs, and its test that a lost call's
    result is refused would fail.
