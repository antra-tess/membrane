- **Context module:** `cache.preferUserMessages` consults the deployment's own
  assistant name via the new `ContextConfig.assistantParticipant` instead of the
  hardcoded `claude`/`assistant`/`bot`/`ai` list. A deployment whose assistant is
  named anything else had every assistant turn classified as a user turn, so the
  adjustment was a no-op that could leave the marker on an assistant turn. With
  no `assistantParticipant` configured the legacy names still apply.
- **Context module:** `processContext` carries every field of the caller's
  `ContextConfig` through its internal default-merge instead of re-listing the
  survivors, so `assistantParticipant` (and any field added later) reaches the
  placement engine on the end-to-end path rather than only via the exported
  helpers.
- **Context module:** `processContext` no longer throws `TypeError` on messages
  that carry no `participant` (role-shaped producers). The user-turn heuristic
  treats a missing participant as a user turn, which is its own fallback intent.
