- `AnthropicAdapter`'s cache keepalive passes a failed poke's error through
  the adapter's own error handling, as it does a foreground call's error. Its
  `onCall` receipt now carries a `MembraneError`, with the SDK's error
  serialized in `rawError`, where it carried the SDK's error before. The
  error's `retryAfterMs` is the wait that holds the model's pokes. A poke
  refused for the account, a 402 or a 400 such as "Your credit balance is
  too low", now reaches `onCall` as a `MembraneError` of type `auth`, as a
  foreground call refused that way does, where the SDK's error carried only
  its status. The SDK's own retries of a poke are unchanged.
