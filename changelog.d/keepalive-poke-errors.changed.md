- `AnthropicAdapter`'s cache keepalive passes a failed poke's error through
  the adapter's own error handling, as it does a foreground call's error.
  Its `onCall` receipt now carries a `MembraneError` where it carried the
  SDK's error, with that error serialized in `rawError` (an abort's carries
  none) and the poke's request in `rawRequest`, as a foreground call's error
  has. A credential resolver's failure reached `onCall` as a `MembraneError`
  before and still does, now with the poke's request in `rawRequest`. The
  `error` event's message is the `MembraneError`'s. The error's
  `retryAfterMs` is the wait that holds the model's pokes. A poke
  refused for the account, a 402 or a 400 such as "Your credit balance is
  too low", now reaches `onCall` as a `MembraneError` of type `auth`, as a
  foreground call refused that way does, where the SDK's error carried only
  its status. The SDK no longer retries a failed poke, as it doesn't a
  foreground call's request. Until now the README and `RetryConfig`'s doc
  made the keepalive's replays the one exception that kept the SDK's own
  retries.
