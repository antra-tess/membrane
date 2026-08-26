- **Context module:** `shouldRoll` now compares the configured threshold against
  the measured window (`messageCount` / `totalTokens`) rather than against
  `state.messagesSinceRoll` / `state.tokensSinceRoll`. Those counters increment
  once per call and re-add the whole window per call respectively, so a
  threshold of 50 messages meant "roll on the 50th call" and a stable window
  crossed a token threshold purely by being sent repeatedly. Both counters
  remain as telemetry.
- **Context module:** the `limits.maxCharacters` hard limit is enforced by
  truncation instead of being announced and ignored. The character limit now
  supplies its own truncation target (drop from the front until the window fits)
  and is re-asserted afterwards; a breach that cannot be truncated away is
  reported through `ContextInfo.residualOverflow`.
- **Context module:** a roll that dropped nothing is no longer reported as a roll.
  `ContextInfo.didRoll` is true only when messages were actually dropped, so the
  roll counters stop resetting on every call while a conversation sits over a
  hard limit — which is exactly when threshold rolling is needed.
