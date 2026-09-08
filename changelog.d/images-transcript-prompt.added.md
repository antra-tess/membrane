- OpenAI Images adapter (`OpenAIResponsesAdapter`, `/v1/images/generations|edits`):
  opt-in `promptFormat: 'transcript'` flattens the conversation into
  role-delimited `### User` / `### Assistant` turns and references every
  attached image inline as `[Image N]` in the turn it belongs to, so a previous
  generation (an image-only assistant message) reads as the assistant's own
  prior turn instead of vanishing from the prompt. Adds `maxInputImages`
  (clamped to the API cap of 16; transcript keeps the most recent, legacy the
  first) and `transcriptPreamble`. Default `'legacy'` is byte-for-byte unchanged.
