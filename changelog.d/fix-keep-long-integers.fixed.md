- A tool call's integer past `Number.MAX_SAFE_INTEGER` written as plain digits, such as a Discord id a model writes
  unquoted, now reaches the tool as those digits, a string, where `JSON.parse` could round it to another number.
  Every integer past that bound is kept this way, even one a number would hold exactly. This holds for native calls
  on Bedrock's streamed path, on Anthropic's where the arguments come as `input_json_delta` fragments, and on every
  OpenAI-style adapter, including a gateway whose response body, or Responses stream item, carries a call's arguments
  as an object; for Bedrock's non-streamed responses; and for XML mode's parameters at any depth, a negative one
  included. A parameter declared `number` or `integer` gets such a value as digit text, as XML mode already gave it.
  Where the SDK parses Anthropic's response (its non-streamed body, and arguments a stream's block start carries),
  and on Gemini, nothing changes.
