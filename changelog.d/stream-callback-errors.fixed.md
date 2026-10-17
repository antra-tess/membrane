- A stream callback's error is no longer swallowed (#117). The OpenAI,
  OpenAI-compatible, OpenAI completions and OpenRouter adapters ignored an
  error thrown by `onChunk` (or, on OpenRouter, `onContentBlock`), and the
  Bedrock adapter logged it as a malformed event and skipped it, so the stream
  finished as if nothing had happened. Now the error fails the stream through
  the adapter's error boundary, as it already did on the Anthropic, Gemini and
  Responses API adapters. The provider's response body is cancelled rather
  than left unread, on Gemini too. The error is typed by `classifyError` like
  any other, a plain `Error` by its message: most are `unknown` and not
  retryable, while one whose code reads as a network failure, such as
  `EPIPE` from a callback writing to a closed pipe, is typed `network` and
  retryable. With stop sequences, text held back for a possible stop isn't
  handed to a callback that has thrown.
- What these adapters can't read is still dropped. A data line that isn't
  JSON, and `data: null`, drop their frame, on Gemini too; other JSON that
  isn't an object reads as nothing. On the OpenAI, OpenAI-compatible and
  OpenRouter adapters, a `tool_calls` that isn't an array drops its tool
  calls, and an entry that isn't an object, or whose `index` isn't a
  non-negative integer (absent or `null` counts as 0, and a string of digits
  counts, as before), drops that entry; the rest of the frame is read. The
  calls placed are gathered in index order, so a first call at index 1, or
  one after a dropped entry, no longer fails the response. A number entry
  used to become an empty tool call. On Bedrock, an event that doesn't
  decode, has no `bytes` field, or decodes to `null` is skipped with a
  warning, as before, and so is a block start or stop whose index or block
  can't be placed.
