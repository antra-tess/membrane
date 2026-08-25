- Tool-pair normalizer: a re-roled reasoning block — `thinking` or
  `redacted_thinking` — is no longer welded into an assistant envelope that
  already holds a `tool_use`. `rebuildEnvelopes` opened a new envelope on role
  change only, so a reasoning block living under a user message was appended
  to the PREVIOUS assistant turn — signature and all — landing after that
  turn's `tool_use`. It now opens a fresh envelope,
  which the following `mergeConsecutiveRoles` cannot re-weld because phase 3
  guarantees a user envelope after any `tool_use`. This is a
  content-correctness fix (signed reasoning attributed to the wrong turn), not
  400-prevention. Live verification, 2026-08-25: replaying a real signed
  `thinking` block from `claude-haiku-4-5-20251001` with the block placed after
  its `tool_use` returned 200, as did the correctly-ordered control, so the
  API accepts the welded shape; the same was observed for
  `claude-sonnet-4-6`, and separately for a real `redacted_thinking` block
  from `claude-haiku-4-5-20251001` (welded 200, control 200). The tests
  covering this change are mock-only — no test in the suite makes a provider
  call.
