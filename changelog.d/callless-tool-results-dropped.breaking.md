- **Callers that read `hooks.onNormalize` or call `normalizeToolPairs`:** a
  tool result without its call, and a second result for a call that already
  has one, are left out of the request, never sent as text.
  `NormalizeEvent`'s `orphan_tool_result_textified` is now
  `orphan_tool_result_dropped` (`toolUseId`, `'<missing>'` for a result with
  no id or an empty one), and `stray_tool_result_textified` is now
  `stray_tool_result_dropped` (`toolUseId`, `reason`, and `fromEnvelope` on
  the native path only, where it is set as before). Neither carries
  `recoveredChars`, and `reason` gains `'answered'`, which the builders
  without the normalizer's turns send. The Responses formatter and
  `AnthropicXmlFormatter` in XML tool mode now report their drops through
  `onNormalize` with these two events too, so a host hears each drop through
  one listener whatever its path. `NormalizeOptions.onBlockRewritten` is
  gone: `onBlockDropped` hears each block left out, and `onBlockReplaced`
  each block put in an input block's place.
  - **What a request carries now:** `NativeFormatter`, and
    `AnthropicXmlFormatter` in native tool mode, leave such a result out. A
    cache marker it carried moves to the last cacheable block before it in
    the messages, unless that block carries a marker of its own; with no
    such block it goes with the result, and none moves onto the system
    prompt. A user turn the drop leaves holding nothing the API is sent (no
    blocks, or only blank text or media without a source) stays, holding the
    leading text (`prefillUserMessage`, else `[continuing]`), so no request
    becomes a prefill and no two assistant turns merge. A second result is
    left out even when it, not the first, was the real output behind a
    placeholder.
    `AnthropicXmlFormatter` in XML tool mode sends a result only where the
    model reads it as its own call's answer, by our reading of how a model
    reads a transcript that carries no ids, which no run with a model has
    tested; `withoutCalllessResults` in `src/formatters/anthropic-xml.ts`
    says how, and when a result moves, goes without its name, or renders
    from its fields. A breakpoint on a message that then shows nothing marks
    the conversation text before it. On every path the round report marks
    the message a result came from as altered.
  - **Prompt cache:** a stored history that holds such a result sends a
    different prefix once a host upgrades, so its first request after the
    upgrade misses the prompt cache from that result on. In XML tool mode,
    so does one that stores results out of their calls' order where the
    model can't tell them apart, or holds a result naming a tool other than
    its call's.
  - **Migration:** a hook that matches the old kinds has to match the new
    ones instead, without `recoveredChars`; a switch over `reason` needs a
    case for `'answered'`, and code that reads `fromEnvelope` must allow it
    absent. A caller whose history gives each call one result, after it, in
    its call's place, naming its call's tool, sees no difference.
  - **Unchanged:** on the native path, the first result for a call in the
    request, wherever the normalizer moves it, and the `[pending]` result a
    call without one gets. A dropped second result's cache marker can move
    onto the first, as onto any cacheable block before it.
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
