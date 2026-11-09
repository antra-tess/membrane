- A tool call's integer past `Number.MAX_SAFE_INTEGER` written as plain digits, such as a Discord id a model writes
  unquoted, now reaches the tool as those digits, a string, where `JSON.parse` used to round it to another number.
  This holds for native calls on Anthropic's and Bedrock's streamed paths and every OpenAI-style adapter, for
  Bedrock's non-streamed responses, and for XML mode's parameters at any depth, whose whole-parameter rule of 16 or
  more digits now takes either sign. A parameter declared `number` or `integer` gets such a value as digit text, as
  XML mode already gave it. Anthropic's non-streamed path, whose body the SDK parses, and Gemini are unchanged.
