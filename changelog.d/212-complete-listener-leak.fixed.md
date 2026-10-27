- The Anthropic adapter no longer leaks an `abort` listener onto the caller's
  `AbortSignal` on each `complete()` call made with an API key and no
  `timeoutMs` (#212), and no longer keeps signals alive after a request with a
  `credentials` resolver. SDK 0.52 adds a listener to the signal each request
  is handed and never removes it. With an API key the adapter handed it the
  caller's own signal, so a reused signal gained a listener per call. With a
  resolver it handed it a signal from `AbortSignal.any()`, which, once it holds
  a listener, stays alive until the caller's signal aborts on Node 22.12 and
  Bun: one reused caller signal kept two signals per `complete()` alive on
  every runtime, and each `stream()` kept three to five on Node 22.12 and Bun.
  Each request now hands the SDK a signal of its own, which follows the
  caller's and is released when the request settles.
