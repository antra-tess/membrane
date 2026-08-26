- **Context module:** rolling truncation no longer strands a `tool_result` whose
  `tool_use` it dropped. The chosen start index moves forward to the next clean
  tool-cycle boundary; when no clean boundary exists at or after it — the
  requested window would keep only the tail of a cycle — the cut walks back to
  the call that opens that cycle and keeps it whole. Previously the default XML
  formatter shipped the orphan verbatim (silent transcript corruption) and the
  OpenAI Responses builder emitted a wire-invalid `function_call_output`.
- **Context module:** truncation can no longer return an empty `messages` array.
  A window whose newest message alone exceeds the target keeps that message (or
  the whole tool cycle it belongs to), and the overshoot is reported through the
  new `ContextInfo.residualOverflow` (`{ unit, limit, actual }`) instead of
  shipping a message list every provider rejects.
