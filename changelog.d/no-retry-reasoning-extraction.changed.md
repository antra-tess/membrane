- `refusalRetries` no longer re-issues a refusal the provider reports as
  `reasoning_extraction`: it stands on the first attempt, in `complete()` and
  in streams. Other categories, and refusals with no category, are re-issued
  as before.
