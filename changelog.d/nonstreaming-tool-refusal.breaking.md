- **Callers passing `onToolCalls` with `streaming: false`:** `stream()` now
  throws a typed `unsupported` error instead of silently returning after one
  provider call. The non-streaming fallback routes to `complete()`, which has
  no tool loop, so the handler was accepted, dropped and never called — the
  raw `<function_calls>` XML was returned as text and the turn ended. Leave
  streaming enabled, or drive the rounds yourself with `complete()`.
