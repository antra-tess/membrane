- Tool-pair normalizer: a re-roled `thinking` block is no longer welded into
  an assistant envelope that already holds a `tool_use`. `rebuildEnvelopes`
  opened a new envelope on role change only, so a thinking block living under
  a user message was appended to the PREVIOUS assistant turn — signature and
  all — landing after that turn's `tool_use`. It now opens a fresh envelope,
  which the following `mergeConsecutiveRoles` cannot re-weld because phase 3
  guarantees a user envelope after any `tool_use`. This is a
  content-correctness fix (signed reasoning attributed to the wrong turn), not
  400-prevention: measured against `claude-sonnet-4-6` on 2026-08-25, the live
  API accepts the welded shape.
