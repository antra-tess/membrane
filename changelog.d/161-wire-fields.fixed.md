- The Anthropic and Bedrock adapters build the request's messages from the
  Messages API's own fields for each block type membrane uses (text, image,
  document, `tool_use`, `tool_result`, `thinking` and `redacted_thinking`),
  at the top of a message and inside a `tool_result` (#161). A field the API
  doesn't define, which it refuses ("Extra inputs are not permitted"), is
  left behind: MCP's `annotations` and `_meta`, membrane's `sourceUrl`,
  `tokenEstimate` and `rawItem`, a tool call's `rawXml`, or a host's own.
  Before, such a field reached the wire on a block the adapter passed on as
  it came, and since the block stays in history, every later request
  carrying it was refused. That included an MCP text block's `annotations`
  and an image's `sourceUrl` inside a tool result on Bedrock, and a
  `redacted_thinking` block's `tokenEstimate` on both (agent-framework,
  whose stamp that is, leaves it off its requests since
  anima-research/agent-framework#571). A block of another type, such as a
  server-tool block the API produced, still goes as it came, and so do the
  blocks of a passthrough `extra.messages`.
- A document in membrane's form now goes with `media_type`, and its
  `filename` as its `title`, as `toAnthropicContent` sends it, where a
  request built directly sent `mediaType` and was refused.
- Inside a `tool_result` on Bedrock, where each was sent and refused, a
  block of a type the API refuses there (a `tool_use`, `thinking`, audio and
  the like) is now left out and reported, as Anthropic's adapter already
  left it out. So is a search result or a tool reference beside a block of
  another type, which the API takes only in content all of its own type; a
  browser state outside the result of a browser toolset member, as the
  result's `toolset_name` says; and, in such a result, anything but text,
  images and its first browser state.
- A cache breakpoint inside a `tool_result` on Bedrock now goes only on the
  content's last block, and only when the `tool_result` carries none of its
  own, the one place in it the API takes one, and `cache_control.ttl` is
  left out there as at the top. Bedrock is taken to accept what the Messages
  API does here, which nobody has run against Bedrock itself.
- Inside an error `tool_result`, which the API takes with text only, an
  image now goes as a note saying it wasn't shown, and any other block that
  isn't text is left out and reported, on both adapters. Before, Bedrock's
  adapter sent each of them, and Anthropic's sent an image, and the API
  refused the request.
- An error `tool_result` that would go with no content now carries a note
  saying why, on both adapters, since the API takes none without content:
  that what it held was left out, or that it came with nothing (no content
  or null, an empty string, or text with nothing in it). Before, it went out
  empty, or with blocks the API refuses there, and was refused.
- A `null` block inside a `tool_result`'s content is now left out and
  reported, on both adapters. Before, Anthropic's adapter threw while
  building the request, and Bedrock's sent it and the API refused it.
- A field the API takes is kept, so a request that succeeds today goes out
  with the same bytes, except as Changed says.
