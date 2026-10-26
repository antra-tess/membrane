- The Anthropic adapter no longer leaks an `abort` listener onto the caller's
  `AbortSignal` on each `complete()` call made with an API key and no
  `timeoutMs` (#212). SDK 0.52's `fetchWithTimeout` adds a listener to the
  signal it's handed and never removes it, and `credentialSession`'s
  no-resolver branch handed it the caller's own signal; it now hands a signal
  derived per call, as the resolver branch always did, so a caller reusing
  one signal across calls no longer accumulates listeners.
