- **Callers:** every provider call now has a progress deadline by default.
  Left unset, or set to anything that isn't a number (`null` included),
  `progressTimeoutMs` used to mean none; it now means bounds per phase of
  the call. On a stream from `AnthropicAdapter` or
  `BedrockAdapter`, which report their phases: 400 s from the send for the
  first content; a silent think (thinking whose display isn't `'summarized'`)
  is allowed its request's whole `max_tokens` at 35 tokens a second from its
  start, and before content the call ends only once both have run out; after
  content, 180 s between provider events, or the think's allowance after a
  silent think's start when that's longer. Every other call, `complete()` on
  any adapter and a stream on any other adapter, gets 400 s plus its
  `max_tokens` at 35 tokens a second, from the send and again from each
  event. Keepalives never count as progress. A call that goes longer without
  progress than its bound, which today runs on, now ends as a
  `TimeoutAbortError` (`type: 'timeout'`), on a stream as an `aborted` result
  with reason `'timeout'` carrying what arrived, and membrane doesn't send it
  again. A host that treats every aborted stream as a completed answer will
  now turn a stalled stream into a partial answer marked as a success. A
  positive `progressTimeoutMs` still gives one flat bound, from the send and
  from each event, and `Infinity` none; 0 still turns it off, as a negative
  number or NaN does.
- **Callers of `AnthropicAdapter`:** its own first-event and idle timers are
  gone, and `firstEventTimeoutMs` with them. The first event now falls under
  the 400 s for first content, where it had 600 s. `idleTimeoutMs` is
  removed from `stream()`'s and `streamYielding()`'s options, where it set
  that idle timer: a connection that sends no byte at all, keepalive pings
  included, is now left to the runtime's own body timeout, such as undici's
  on Node (300 s by default), where the idle timer gave 600 s from the first
  event. That timeout still throws, as before, rather than ending a stream as
  an `aborted` result. When either timer ran out, the call threw a retryable
  `MembraneError` of type `timeout`; any expiry is now a `TimeoutAbortError`,
  which isn't retryable, and a stream that stalls ends as an `aborted` result
  with reason `'timeout'` carrying its partial content instead of throwing.
  The deadlines are `Membrane`'s: an adapter called directly, not through
  `Membrane`, gets none of them, and `AnthropicAdapter`'s own two timers are
  gone.
- **Provider adapters:** `ProviderRequestOptions.idleTimeoutMs` and
  `firstEventTimeoutMs` are removed: membrane core keeps a call's progress
  deadline (`timeoutMs` stays the adapter's), and the adapter says what it
  saw. The new `onSend`, beside `onRequest`, takes a
  `SendReport`: the output-token limit the body asks for (`maxTokens`), and
  whether this stream reports its phases (`reportsPhases`). `onProgress` takes
  an optional `ProgressSeen`: `'content'` for a content delta or a
  `redacted_thinking` block's start, or `'think'` for a silent think's start.
  A stream whose adapter reports phases at the send
  is bounded per phase. An adapter that calls neither, or calls `onProgress()`
  with nothing, as before, keeps working, and gets the bound for an answer
  that can arrive whole, sized from the request's `maxTokens`.
