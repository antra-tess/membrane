- A tool call's integer past `Number.MAX_SAFE_INTEGER`, such as a Discord id a model writes unquoted, now reaches
  the tool as the digits the model wrote, a string, where `JSON.parse` used to round it to another number. This
  holds wherever membrane parses a call's arguments from their text: native calls on Anthropic's and Bedrock's
  streamed paths and every OpenAI-style adapter, Bedrock's non-streamed responses, and XML mode's parameters at any
  depth. A parameter declared `number` or `integer` gets such a value as digit text, as XML mode already gave it.
  Anthropic's non-streamed path, whose body the SDK parses, and Gemini are unchanged.
