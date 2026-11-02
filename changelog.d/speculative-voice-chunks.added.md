- `emitToolInputDeltas` (streamYielding, default off): a native tool call's
  argument JSON streams as `tokens` events (`meta.type: 'tool_call'`,
  `toolCallPart: 'input'`, with `toolId` and `toolName`) as the API sends
  it, for consumers that act before the call completes, such as speech.
  Providers report fragments through the new `StreamCallbacks.onToolInputDelta`
  (Anthropic). The finished call in `tool-calls` stays authoritative.
- `ToolDefinition.eagerInputStreaming`: the Anthropic adapter sends it as the
  tool's `eager_input_streaming`. True, the API streams that tool's input as
  the model writes it instead of sending each parameter's value once
  complete, and doesn't validate it, so it can be partial or invalid JSON,
  and input the SDK's stream parser can't recover fails the turn. It's part
  of the tool's definition, so set it per agent and keep it: changing it
  rewrites the prompt cache from the tools onward.
