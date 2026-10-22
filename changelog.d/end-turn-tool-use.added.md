- `AnthropicAdapter` keeps what it needs to report a response to Anthropic,
  on `ProviderResponse` and on its `raw` response: `responseId` / `raw.id`,
  the message id, and `requestId` / `raw.request_id`, the `request-id`
  response header, on `stream()` and `complete()`. Before, the stream path
  kept neither, and `complete()`'s raw response lost the request id when
  serialized (the SDK attaches it non-enumerably). The stream path's `raw`
  also carries `provider_events`: `message_start` (the event, its message
  without `content`), `message_delta`, and `unhandled`, the first 20 events
  or deltas the adapter doesn't read or doesn't apply, with
  `unhandled_omitted` counting the rest; each kept event is cut to 4,096
  JSON characters. A field the API adds to `message_start` or
  `message_delta`, a delta type the adapter doesn't read, and a
  `content_block_stop` carrying more than its type and index are now visible
  where they used to be dropped. A new event type isn't: the SDK
  (`@anthropic-ai/sdk` 0.52) yields only the event types it knows. Block
  content stays in `content`, though an event kept in `unhandled`, such as a
  `citations_delta`, keeps the payload it carried. `ProviderResponse` gains
  optional `responseId` and `requestId` for any adapter to fill.
