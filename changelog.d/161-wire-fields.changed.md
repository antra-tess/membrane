- Inside a `tool_result` on Bedrock, only what the Anthropic adapter
  sends there now goes: a text block's type and text, and an image with a
  base64 or URL source as its type and source. A document, a search
  result, a tool reference, a browser state or an image with a `file`
  source there is now left out and reported, and a `cache_control`, a text
  block's `citations` or an image's `transformations` there no longer
  goes. Bedrock's adapter sent each as it came, so a request whose history
  holds one now goes without it, and its prompt cache is written again
  from that block on. One whose only breakpoints sat inside a
  `tool_result` goes uncached while that block is in history, as on the
  Anthropic adapter today: by our reading, the breakpoint budget still
  counts them, so `NativeFormatter` adds no system breakpoint. membrane
  builds none of them inside a `tool_result`, and MCP's content types
  include none of them.
- Whitespace-only text inside a `tool_result` on Bedrock is now removed as
  the adapter builds the content, and reported as its `tool_result`, as the
  Anthropic adapter does, where the empty-text cleanup removed it after the
  build and reported the text block.
