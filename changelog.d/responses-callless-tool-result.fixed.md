- `OpenAIResponsesFormatter` leaves out a tool output whose call no input item
  carries, whether it converts the `tool_result` or carries it as a native
  item (`rawItem`, `openaiResponsesItems`), and reports its message as
  altered. OpenAI's Codex backend, reached through a ChatGPT subscription,
  refuses such a `function_call_output` ("No tool call found for function
  call output with call_id …"), so the whole request failed there, as when a
  context window had cut the call. An output for a call id past as many as
  there are calls carrying it before it is left out the same way, so no call
  gets a second output; an output ahead of an id's first call counts for it,
  and one ahead of a later call of a reused id is left out. A
  `local_shell_call_output`, which has no `call_id`, names its call by its
  `id`, as either id of a `local_shell_call`. A stored history that held such
  an output sends a different prefix after the upgrade, so its first request
  misses the prompt cache from there on.
  `OpenAIResponsesAPIAdapter` in subscription mode does the same for messages
  a host hands it in normalized form, and reports the block each output came
  from through `onContentAltered`.
