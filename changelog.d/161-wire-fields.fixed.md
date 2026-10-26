- The Anthropic and Bedrock adapters build each block at the top of a
  message from the Messages API's own fields for its type (text, image,
  document, `tool_use`, `tool_result`, `thinking` and `redacted_thinking`)
  (#161). A field the API doesn't define, which it refuses ("Extra inputs
  are not permitted"), is left behind: MCP's `annotations` and `_meta`,
  membrane's `sourceUrl`, `tokenEstimate` and `rawItem`, a tool call's
  `rawXml`, or a host's own. Before, such a field reached the wire on a
  block the adapter passed on as it came, and since the block stays in
  history, every later request carrying it was refused. That included an
  image's `tokenEstimate` at the top of a message, and a `redacted_thinking`
  block's `tokenEstimate` on both adapters (agent-framework, whose stamp
  that is, leaves it off its requests since anima-research/agent-framework#571).
  A block of another type, such as a server-tool block the API produced,
  still goes as it came (on Bedrock without `cache_control.ttl`, as
  before), and so do the blocks of a passthrough `extra.messages`.
- Inside a `tool_result` on Bedrock, the content is now built as the
  Anthropic adapter already builds it: text as its type and text, an image
  with a base64 or URL source as its type and source, labelled by its bytes
  or sent as the placeholder, and any other block left out and reported.
  Before, Bedrock's adapter kept every field on each block there, so an MCP
  text block's `annotations` or an image's `sourceUrl` got every later
  request refused (#161).
- A document in membrane's form now goes with `media_type`, and its
  `filename` as its `title`, as `toAnthropicContent` sends it, where a
  request built directly sent `mediaType` and was refused (#161).
- An error `tool_result`, which the API takes with text only and never
  without content, now goes as the API takes it, on both adapters and from
  `toAnthropicContent`: an image there goes as a note saying it wasn't
  shown (or as the placeholder, when its data is no image the API accepts,
  as before), and one that would go with no content carries a note saying
  it carries no content this request can show. Before, Bedrock's adapter
  sent each block there, Anthropic's sent an image there, and an error
  result left empty went out empty, and the API refused each.
- A block that isn't an object, such as a `null`, at the top of a message
  or inside a `tool_result`'s content, is now left out and reported, on
  both adapters. Before, both adapters threw building a request with one at
  the top of a message, and inside a `tool_result` Anthropic's adapter threw
  and Bedrock's sent it and the API refused it.
