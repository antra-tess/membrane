- OpenAI Images adapter: a previous output carried forward in history as a
  `generated_image` block is now attached to `/v1/images/edits` and referenced
  in the transcript like any other image, instead of being silently dropped
  (Greptile review on #71).
