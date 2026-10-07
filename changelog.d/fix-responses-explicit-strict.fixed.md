- **Responses API function tools now always state `strict`.** Every function
  tool the `openai-responses-api` adapter sends, in API-key and subscription
  modes, carries a boolean `strict`: an omitted or `null` value is sent as
  `false`, and an explicit `true` or `false` is kept. Previously `strict` was
  left out unless the caller set it, which handed validation to the provider's
  default; strict validation treats every property as one the model must send,
  so optional parameters of plain JSON Schema tools could reach the model as
  required. This applies to flat Responses functions, nested Chat-style
  `{ type: 'function', function }` tools and tools built from
  `inputSchema`/`input_schema`/`parameters`, and to the tools that reach the
  wire whether they came as `request.tools` or as a `providerParams.tools`
  override of them. A `strict` that is not a boolean,
  `null` or absent is refused with an `invalid_request` error naming the tool,
  before any request is sent. Non-function tools and the Chat Completions and
  openai-compatible adapters are unchanged; tools that already carried an
  explicit boolean serialize as before.
