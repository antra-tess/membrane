- On Anthropic's wire, a `tool_result`'s content now carries what the API
  takes there, where the adapter rebuilt it as text and images alone (#161).
  A document, which it left out and reported, now goes, except in an error
  result or a browser toolset member's result, which take none, and so does
  an image whose source is a file id, in an error result as a note that it
  wasn't shown. A search result or a tool reference now goes as it came in
  content all of its own type, and so does a browser state in the result of
  a browser toolset member, the first where there are more. A text block's
  `citations` there now go too, and so do an image's `transformations` and a
  document's own fields, and a cache breakpoint on the content's last block
  when the `tool_result` carries none of its own, the one place in it the
  API takes one, and a `cache_control` of null wherever it sits. An image
  there whose data the API doesn't accept goes as the placeholder text with
  that breakpoint, as on Bedrock. Each of these is content or a breakpoint a
  caller put in a tool result. `toAnthropicContent` builds a tool result's
  content the same way, so it sends a document there, which it left out.
- An image or a document whose source has no type the API names for it
  (`source: {}`, say) is now left out and reported by both adapters, at the
  top of a message and inside a `tool_result`. At the top, both sent it, and
  the API refused the request; inside a `tool_result`, Bedrock's adapter
  sent it, and Anthropic's already left it out. A source of a type the API
  names that membrane doesn't build, such as a file id, goes as it came.
