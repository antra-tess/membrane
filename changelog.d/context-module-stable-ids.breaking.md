- **Context module callers:** `processContext` now throws
  `MembraneContextIdentityError` when any message lacks `metadata.sourceId`,
  instead of inventing a random id per call. **Who needs to act:** any caller of
  `processContext` (or of the exported helpers) whose messages do not carry a
  stable source id. **Migration:** populate `metadata.sourceId` with the
  originating system's message id (Discord message id, UI message id) — the
  error names the offending message indices. **Unchanged:** callers that already
  set `sourceId`, and everything outside `src/context/` — this module is opt-in
  and no membrane request path calls it. Without stable ids the module's
  continuity check saw 0% overlap on every call and reset the state, so the roll
  threshold never accumulated, cache markers never stayed stable and
  `cachedStartMessageId` was meaningless; the failure was silent.
