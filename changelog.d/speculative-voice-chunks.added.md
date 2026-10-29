- `emitToolInputDeltas` (streamYielding, default off): a native tool call's
  argument JSON streams as `tokens` events (`meta.type: 'tool_call'`,
  `toolCallPart: 'input'`, with `toolId` and `toolName`) while the model
  writes it, for consumers that act before the call completes, such as speech.
  Providers report fragments through the new `StreamCallbacks.onToolInputDelta`
  (Anthropic). The finished call in `tool-calls` stays authoritative.
