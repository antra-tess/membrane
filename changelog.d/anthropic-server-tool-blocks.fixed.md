- Anthropic server-tool blocks (`server_tool_use`, `web_search_tool_result`
  and the other blocks the API returns for a tool it runs itself, and
  `container_upload` for a file it puts in the code-execution container) go
  back to the Anthropic API in their place in the turn. The native tool
  loops and `fromAnthropicContent` kept each on a zero-width `rawItem`
  carrier, but NativeFormatter, which the native tool loops build through,
  and the exported `toAnthropicContent` dropped the carrier as empty text.
  So a replayed web-search turn lost its search results. With signed
  thinking in the turn, claude-sonnet-4-6 refused it in a live check:
  "`thinking` or `redacted_thinking` blocks in the latest assistant message
  cannot be modified". claude-haiku-5-5 accepted it and ran the search
  again. Each now sends the block itself, as a copy without any
  `cache_control` stored on it or its carrier. A block stored as itself, as
  a seeded history can hold it, goes back the same way. NativeFormatter
  sends it only in the assistant's own turns, the native tool loops'
  requests included: another participant's message, sent as a user turn,
  still leaves it out. `toAnthropicContent` sends it when given
  `{ role: 'assistant' }`, and otherwise leaves it out, as it always left
  out a carrier.
- Except where the API refuses a block in its turn. A server call goes only
  with its result after it in the turn, and a result only with its call
  before it: the API refuses either alone, so a lone one is left out of its
  turn and its message is reported altered. The request's final assistant
  message keeps its lone calls, since a paused turn (`pause_turn`) resumes
  there; `toAnthropicContent` takes `lastMessage` for that turn. The API
  takes each id once per turn, so the first call of an id pairs with the
  first result after it, and a second call with that id, or a second result
  for it, is left out too. A call whose `id`, or a result whose
  `tool_use_id`, isn't a string is left out of every turn, the final one
  included. A turn left with nothing is dropped. `container_upload`, which
  the API refuses in any assistant turn, is always left out.
- Membrane sends these blocks back only through `AnthropicAdapter`. Live
  checks on claude-haiku-4-5 had the Anthropic API accept each type sent
  back beside its partner, with or without a cache marker on it, except
  `container_upload`; the MCP connector's pair was checked through
  `count_tokens` only, and code execution's success results were built from
  the SDK's types. It leaves them out of every other provider's requests,
  Bedrock's included, in the build itself, before it places cache markers
  and merges turns, so those requests are what they were before: a provider
  adapter declares `replaysAnthropicServerBlocks`, and NativeFormatter takes
  `anthropicServerBlocks`, off by default, so a caller that builds with
  NativeFormatter itself for the Anthropic API, such as a token count,
  passes `true`. Whether Bedrock accepts them is unknown, and a refusal
  there would fail every request carrying the conversation. In XML tool
  mode the turn is text, so these blocks still aren't sent there.
- Anthropic API requests for a stored history with such a turn change from
  that turn on: a prompt-cache prefix written before upgrading that reaches
  past the turn no longer matches, and the search results are input tokens on
  every later request. A turn stored through `complete()` before this release
  has no carrier to send, so a model that refuses it with signed thinking
  still refuses it: an upgrade can't restore what was never kept.
- Streaming: a server tool's call (`server_tool_use`, `mcp_tool_use`) kept
  the empty `input` of its `content_block_start`, because only a `tool_use`
  assembled its `input_json_delta` fragments. It now holds the input the
  model wrote. Fragments that don't parse to an object, and a call cut off
  mid-input, leave the start's `input: {}` with the text in
  `unparseableInput`, and a warning names the block; whitespace alone is no
  input. Either call goes back as stored, `{}` without the marker, wherever
  the pairing rule keeps it: a stopped call with its result after it, or a
  lone call in the request's final message. A cut-off call has no result
  after it, so only the final message keeps it.
- `complete()` keeps a provider block it has no normalized form for (an
  Anthropic server-tool block, or an opaque Responses item such as a
  compaction) on a zero-width carrier, as the native tool loops do, instead
  of dropping it, and an XML closing tag it restores goes on the last text
  block that isn't a carrier. It still keeps no `rawItem` on the text and
  thinking blocks it normalizes, which the native tool loops do keep.
  `fromAnthropicContent` carries a server-tool block without the
  unknown-type warning.
- Request shapes for other wires leave a server-tool block out, bare or on
  its carrier. The OpenAI Responses formatter no longer replays one as an
  input item, the Responses input normalization no longer passes one through
  as a message part or an empty text part, and the XML and completions
  formatters, the OpenAI, OpenAI-compatible, OpenRouter and OpenAI
  completions adapters, and the exported `toOpenAIMessages`,
  `toOpenRouterMessages`, `toOpenAIContent` and `toGeminiParts`, no longer
  write a zero-width carrier as an empty text part or line, and neither does
  the exported `extractText`. `toOpenAIContent` still answers `''` for a
  turn whose only text blocks are carriers.
