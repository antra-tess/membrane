- A cancelled `streamYielding()` turn keeps what it had (#142). Its `aborted`
  event, from `cancel()` or from the caller's `AbortSignal`, now carries
  `partialContent`, `rawAssistantText`, `toolCalls` and `toolResults`, built
  the way a provider or deadline abort's event builds them. Before, it carried
  none of them. A round whose tools were still running shows its calls with no
  results. So does a round whose results were passed to `provideToolResults()`
  just before the cancel, since the turn hadn't recorded them yet.
