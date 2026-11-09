- Chat Completions providers (OpenRouter, openai-compatible) send tool-result
  images as native `image_url` parts instead of stringifying base64 into the
  tool message text (or replacing it with a text-only placeholder). Image-free
  tool results keep the byte-stable legacy form, so prompt caches are not
  disturbed; the text-only placeholder remains the fallback for unusable image
  sources. New adapter option `toolResultImages: 'native' | 'text-only'`
  (default `'native'`) forces the placeholder path for text-only models or
  servers that reject image parts in `role:'tool'` messages — replaying an
  image-bearing history to such an endpoint previously risked rejecting the
  whole request. The placeholder constant's wording changed accordingly (per-
  image, not result-wide); histories holding the old text still serialize
  byte-stably. The OpenRouter adapter now also preserves the model's reasoning
  stream (`reasoning`/`reasoning_content`) on responses and round-trips
  thinking blocks from history — previously, models that draft replies in the
  reasoning stream could lose the drafted text entirely, producing bare tool
  calls with no content. A thinking-only assistant turn now round-trips in
  both OpenRouter converters, and the public `fromOpenRouterMessage` export
  emits the leading thinking block like the adapter itself.
