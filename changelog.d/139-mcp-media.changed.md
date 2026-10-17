- The stripped-image note, which membrane writes in place of an image it
  can't send, now says so when the image came without its data, with no
  base64 data in its source or on the block and no URL (#139). It used to
  give a media type as the reason: "undefined", unless a source declared
  one. Before: "[system: an image that belongs here was NOT shown to you —
  its media type "undefined" is not accepted by the model API (only
  jpeg/png/gif/webp are). You are not seeing this image. If it matters, ask
  for it in a supported format.]", with the warning
  `[membrane] image block stripped: unsupported media type "undefined"`.
  After: "[system: an image that belongs here was NOT shown to you — it came
  without its data. You are not seeing this image.]", with the warning
  `[membrane] image block stripped: no data`. An image with data whose media
  type is the reason, MCP's form without a `mimeType` among them, keeps the
  note about its media type where it gets one. Where an image is left out
  with no note, as media with no source is at the top of a message, nothing
  is written before or after, and the Responses formatter's own note for a
  `tool_result` image it can't carry is unchanged. The first request after
  upgrading carries the new text where a history holds such an image under
  that note, so a provider's prompt cache misses from that note on, once.
- In an xml tool loop's results, an image that came as a link, with a URL
  source, gets a note that says so and gives the link, where the split that
  sends a result's images gave it the note above naming its media type
  "undefined" (#139). After: "[system: an image that belongs here was NOT
  shown to you — it came as a link (https://…), which tool results here
  can't carry. You are not seeing this image.]", with the warning
  `[membrane] image block stripped: a URL source, which the XML tool path can't carry`.
  Only an http or https link is repeated, cut at 2,048 characters between
  code points; for any other URL, such as a data URL, or one holding half a
  surrogate pair, which the API refuses in a request's JSON, the note leaves
  out the parenthesis. `formatToolResults` and the remainder after a split
  threw on such an image before (see Fixed), and write this note now.
