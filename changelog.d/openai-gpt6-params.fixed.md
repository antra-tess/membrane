- OpenAI: `gpt-6-*` (and every later GPT generation) now gets the GPT-5-era
  parameter surface — `max_completion_tokens` instead of `max_tokens`, no
  `temperature`/`top_p`, no `stop`. The adapter matched these by listing
  `gpt-5` prefixes, so `gpt-6-astra` fell through to the legacy parameters and
  every request 400'd at the wire ("Unsupported parameter: 'max_tokens' is not
  supported with this model. Use 'max_completion_tokens' instead."). Detection
  is now by major version (`gpt-<n>` with n ≥ 5); `gpt-4o`/`gpt-4.1` and the
  o-series are unchanged. Adds `gpt-6-astra` default pricing.
