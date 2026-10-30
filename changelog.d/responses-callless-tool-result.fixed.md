- `OpenAIResponsesFormatter` sends a `tool_result` it converts whose call no
  input item carries as user text in its place, `[orphan tool_result for ID]:
  …`, rendered as `NativeFormatter` renders an orphan (an inline image in it
  as its note), and reports the message as altered. OpenAI's Codex backend,
  reached through a ChatGPT subscription, refuses such a
  `function_call_output` ("No tool call found for function call output with
  call_id …"), so the whole request failed there, as when a context window
  had cut the call. A result whose call, of any call type, is anywhere in the
  input is sent as before. A call-less output carried as a native item
  (`rawItem`, `openaiResponsesItems`) isn't changed by this, so the API still
  refuses it.
