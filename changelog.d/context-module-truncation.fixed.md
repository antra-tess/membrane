- **Context module:** rolling truncation no longer opens the kept window on an
  orphan `tool_result`. The chosen start index is snapped forward to the next
  clean tool-cycle boundary before slicing, so the cut can no longer strand a
  result whose `tool_use` was just dropped — previously the default XML
  formatter shipped that orphan verbatim (silent transcript corruption) and the
  OpenAI Responses builder emitted a wire-invalid `function_call_output`.
- **Context module:** truncation can no longer return an empty `messages` array.
  A window whose newest message alone exceeds the target is floored at that one
  message, and the residual overflow is reported through the new
  `ContextInfo.residualOverflow` (`{ unit, limit, actual }`) instead of shipping
  a message list every provider rejects.
