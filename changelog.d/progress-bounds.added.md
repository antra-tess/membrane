- `progressBounds` on `stream()` and `streamYielding()`: bounds, off by default, that end a streamed
  call which stops making progress while its connection stays open. `true` takes `PROGRESS_BOUNDS`:
  60 s from the send to content, or, once a thinking block has started, the later of that and its
  `max_tokens` at 87 tokens a second from its start, and 150 s between provider events once
  content has begun. An object replaces any of the three. They apply on `AnthropicAdapter` and
  `BedrockAdapter`, run beside `progressTimeoutMs`, and end a call as aborted with reason
  `'timeout'`, which membrane doesn't send again. The README's "Progress bounds" says where the
  values come from and what they weren't measured on.
- `@animalabs/membrane/progress-bounds` exports `PROGRESS_BOUNDS`, `ProgressBounds`,
  `resolveProgressBounds` and `trackProgress`, and imports nothing else of membrane's.
- `AbortedResponse` and the `aborted` stream event carry `message`, what ended the call when the
  caller didn't: a deadline's names the bound that ran out, `progressTimeoutMs`'s included.
- **Provider adapters and decorators:** `ProgressSeen` gains `'think'`, which an adapter that
  reports content (`SendReport.reportsContent`) passes for a thinking block's start unless the
  body asks for summarized thinking. `AnthropicAdapter` and `BedrockAdapter` do. With progress
  bounds on, a decorator that forwards `onSend` but drops `onProgress` or its argument has every
  call still running `beforeContentMs` after its send ended.
