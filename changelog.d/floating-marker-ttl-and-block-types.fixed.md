- **Floating cache marker:** a longer TTL may not follow a shorter one, so the
  float no longer goes at 1h after a marker at 5m or with no `ttl` (a content
  block's own `cache_control`): each float goes at 1h only when `cacheTtl` is
  1h and every marker before it is 1h, otherwise at 5m, and none is placed
  where a 1h marker after it would then follow a 5m one. Under
  `membrane-system` the float is placed before the `beforeRequest` hook, so
  this reads the markers the request carries then; a marker the hook adds is
  the hook's to order. On Anthropic this changes only requests the API refused
  before: one carrying, before the float, a marker shorter than its
  `cacheTtl`, or, after it, a 1h marker when its `cacheTtl` is 5m. On Bedrock,
  which strips `ttl`, a float may now be skipped where a 1h marker follows it.
  Through an adapter that sends a marker only on some block types
  (`sendsCacheMarkersOn`), as OpenRouter's sends one only on text, the float
  no longer goes onto a block of another type, such as a tool result, an image
  or audio, which that adapter sends without it, so the request's cache
  receipt no longer lists a float that isn't sent. Through OpenRouter, with
  one free slot, that slot can now go to the message before the round's
  calling turn, when it ends in unmarked text and the TTL order allows a float
  there, where it is sent, instead of the newest round's tool result, where it
  wasn't.
