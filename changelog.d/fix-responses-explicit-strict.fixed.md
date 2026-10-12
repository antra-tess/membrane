- **Responses API function tools now always state `strict`.** Every function
  tool the `openai-responses-api` adapter converts, in API-key and
  subscription modes, carries a boolean `strict`: an omitted or `null` value
  is sent as `false`, and an explicit `true` or `false` is kept. Previously
  `strict` was left out unless the caller set it, which handed validation to
  the provider's default; strict validation treats every property as one the
  model must send, so optional parameters of plain JSON Schema tools could
  reach the model as required. With `strict: false`, the model's arguments
  are no longer constrained to the schema as it generates them (`required`,
  `enum` and `type` included), so a tool's handler validates them as plain
  JSON Schema, as Chat Completions tools already were. This applies to flat
  Responses functions, nested Chat-style `{ type: 'function', function }`
  tools (whose `strict` is read from the function, or from the wrapper when
  the function's is omitted or `null`) and tools built from
  `inputSchema`/`input_schema`/`parameters`, whether they came as
  `request.tools` or as a `providerParams.tools` override of them. A
  `strict` that is not a boolean, `null` or absent (such as the string
  `'true'`, `1` or an object) used to be forwarded to the provider as given;
  it is now refused with an `invalid_request` error naming the tool, before
  any request is sent.
  - **What changes on the wire:** a function tool that lacked a boolean
    `strict` now carries `strict: false`, so the serialized tools change, and
    a prompt prefix cached before the upgrade that includes them no longer
    matches. A `providerParams.tools` entry in a membrane or Chat shape
    is now converted to a flat Responses tool, so its bytes change too; it
    wasn't a valid Responses tool before.
  - **Unchanged:** non-function tools, and container tools such as a
    Responses namespace tool, pass through as the caller wrote them, member
    functions included. Flat Responses functions that already carried a
    boolean `strict` serialize as before. The Chat Completions and
    openai-compatible adapters are unchanged.
