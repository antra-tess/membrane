- `openai-compatible` now sends OpenAI's own parameter surface when the model
  is one of OpenAI's reasoning-generation models (GPT-5 and later, o-series),
  e.g. with `baseURL` pointed at `https://api.openai.com/v1`: `max_completion_tokens`
  instead of `max_tokens`, and no custom `temperature`/`top_p` or unsupported
  `stop`. Previously every request for those models failed with "Unsupported
  parameter: 'max_tokens' is not supported with this model". Model detection is
  shared with the `openai` adapter; all other model ids keep the legacy
  parameters.
