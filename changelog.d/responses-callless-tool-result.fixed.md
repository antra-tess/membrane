- `OpenAIResponsesFormatter` leaves out a tool output whose call no input item
  carries, whether it converts the `tool_result` or carries it as a native
  item (`rawItem`, `openaiResponsesItems`), and reports its message as
  altered. OpenAI's Codex backend, reached through a ChatGPT subscription,
  refuses such a `function_call_output` ("No tool call found for function
  call output with call_id …"), so the whole request failed there, as when a
  context window had cut the call. A later output for a call an earlier output
  answered is left out the same way, so one output goes per call. An output
  whose call, of any call type, is anywhere in the input is sent as before.
  `OpenAIResponsesAPIAdapter` in subscription mode does the same for messages
  a host hands it in normalized form, and reports the block each output came
  from through `onContentAltered`.
