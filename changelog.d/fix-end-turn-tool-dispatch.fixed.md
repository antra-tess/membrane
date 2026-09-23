- Native tool rounds now dispatch complete `tool_use` blocks when the provider
  reports `stop_reason: 'end_turn'` (observed on claude-opus-5); previously the
  calls were recorded in history but never run. Truncated (`max_tokens`) and
  unparseable calls are still not dispatched; each rescue logs a warning.
