- The Anthropic adapter no longer keeps anything of a finished request alive
  through the caller's `AbortSignal` (#212). SDK 0.52 adds an `abort`
  listener to the signal each request is handed and never removes it. With
  an API key and no `timeoutMs`, the adapter handed it the caller's own
  signal, so a caller reusing one signal gained a listener, and a request's
  controller, per `complete()`. With a `credentials` resolver it handed it a
  signal from `AbortSignal.any()`, which, holding that listener, can outlive
  the request: on every runtime measured while a reused caller signal lives,
  and on Node 22.12 even after the caller's signal is gone. Each request
  given a signal now hands the SDK one of its own, which follows the caller's
  and lets go of it when the request settles.
