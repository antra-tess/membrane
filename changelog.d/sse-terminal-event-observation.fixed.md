- Streaming adapters now require a terminal event before reporting success:
  `openai`, `openai-compatible`, `openai-completions`, `openrouter`, `gemini`,
  `anthropic` and `bedrock` throw a retryable `network` failure
  (`stream ended before a terminal event`) when the stream reaches EOF with no
  `finish_reason` / `[DONE]` / `finishReason` / `message_delta`. Previously the
  terminal signal was an initialised default rather than an observation, so a
  graceful mid-stream close (proxy or LB idle timeout, early FIN, a gateway
  truncating the body) surfaced as `end_turn` over partial content — with a
  `raw.finish_reason: 'stop'` on the OpenAI family that never came off the
  wire. `openai-responses-api` already refused this; Bedrock's guard caught
  only the fully-empty case, so a stream truncated after any content passed.
  A final event that arrives with no trailing newline still counts as
  observed: every OpenAI-family loop drains its SSE line parser's buffer at
  EOF through the same frame handler, as `gemini` and `openai-responses-api`
  already did.
- Adapter `handleError` now returns an already-classified `MembraneError`
  unchanged (`openai`, `openai-compatible`, `openai-completions`,
  `openrouter`, `anthropic`, `bedrock`; `gemini` and `openai-responses-api`
  already did), instead of re-deriving its type by substring over the rendered
  message and downgrading it to non-retryable `unknown`.
