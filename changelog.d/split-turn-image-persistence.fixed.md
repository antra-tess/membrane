- Split-turn image injection now persists into the turn's message list, so
  every continuation after an image-bearing tool result keeps the image user
  turn on the wire. Previously the split existed on exactly one request and
  the next continuation flattened the accumulated document back over it,
  leaving `<function_results>` XML asserting a screenshot the model could no
  longer see.
- Both continuation builders now send the same `extra` contract as the
  initial request (`normalizedMessages` plus the pre-serialized `prompt`).
  The image builder previously sent neither, dropping completions-style
  adapters onto provider-shaped messages and re-adding participant stop
  sequences the continuation deliberately suppresses.
