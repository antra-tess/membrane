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
- The cache-marker budget counts a breakpoint inside a document's content
  source, including one the adapters then leave out there: one not on the
  source's last block, beside the document's own, or in a document that
  isn't its `tool_result`'s last block or whose `tool_result` carries its
  own, or in a document the adapters leave out (in an error result or a
  browser toolset member's result, which take none, or one whose source
  holds nothing the API takes there). So:
  - A request whose only breakpoints sit there, in a `tool_result` (the
    native formatter refuses a top-level document, or leaves it out with
    its breakpoints under `unsupportedMedia: 'strip'`, as before), no longer
    gets membrane's fallback breakpoints on the system prompt and the tool
    list, and a system prompt given as a string then goes as one. On
    Bedrock, which sends such a document as it came, that is the one change
    to a request whose breakpoint is on the source's last block. A request
    whose breakpoints there are all left out goes with none, unless an error
    result holding such a document has nothing else to send: the note that
    stands in for its content then takes the document's own breakpoint, or
    else the one on its source's last block the build takes, if either has
    one.
  - In the native tool loop, the floating breakpoint takes only what the
    count leaves of the four.
  - A request with four other breakpoints and one there has its shallowest
    dropped by the clamp, which may be one of the four.
    `NativeFormatter.buildMessages` with its own budget check refuses it
    instead ("cache_control limit exceeded"), and a cm-owned build refuses
    the source's breakpoint as an import (below), where Anthropic's adapter
    left the document out and sent four.
  - The Anthropic adapter's keepalive, which refreshes a request carrying a
    1h breakpoint, now finds one in a content source, so for a request whose
    only breakpoints sit there, their ttl decides it where the fallbacks'
    did.
- A `tool_result` the tool-pair normalizer turns into text, as an orphan or
  a duplicate, now gives the text the last cache breakpoint the cache-marker
  budget finds inside it, nested in a search result's content or a
  document's content source too, when it carries none of its own. So a
  request whose only breakpoints are nested in such a result no longer gets
  the fallback breakpoints, and where a nested breakpoint comes after one on
  a block of the result's own content, the text takes the nested one's ttl.
- Under cm-owned cache markers, a `cache_control` a caller hands in nested
  in a block the native formatter keeps (a `tool_result`'s content, a search
  result's, a document's content source) is now refused, as one on a text
  block was: the build throws "cm-owned cache markers reject imported
  block-level cache_control". Before, the request went: Bedrock's adapter
  sent the breakpoint beside the strategy's, and Anthropic's left it out.
  One the formatter leaves out, as before (on an image, a `tool_use` or a
  `tool_result` block itself), isn't sent and isn't refused, and a top-level
  document is refused as before, or left out with its breakpoints under
  `unsupportedMedia: 'strip'`.
- A cache breakpoint nested in a `tool_result` now goes on Anthropic's wire
  where the API takes one, and on an orphan's text, and the API refuses a 1h
  breakpoint after a 5m one ("a ttl='1h' cache_control block must not come
  after a ttl='5m' cache_control block"). So a request whose history holds
  a nested breakpoint that puts a 1h one after a 5m one (a nested 1h after
  an earlier 5m, or a nested 5m before a later 1h), which Anthropic's
  adapter sent without the nested one, is now refused for as long as that
  breakpoint stays in its history. membrane leaves the ttl order to
  callers, at the top of a block as nested in one. Bedrock's adapter leaves
  out every ttl.
- An Anthropic server block replayed from history now goes without a
  `cache_control` stored anywhere in it, where only the one on the block
  itself was left out. The API returns server blocks without breakpoints,
  and the builders mark only top-level blocks, so only a caller's own edit
  of stored history can put one below a server block's top; such a
  breakpoint is no longer sent.
