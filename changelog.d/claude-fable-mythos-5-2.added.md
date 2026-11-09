- Claude Fable 5.2 and Claude Mythos 5.2 (`claude-fable-5-2`, `claude-mythos-5-2`):
  default pricing at $8 input, $40 output, $10 for a 5-minute cache write and
  $0.20 for a cache read per million tokens, where each was priced at Fable 5's
  or Mythos 5's row; a 1,000,000-token window and 128,000 tokens of output from
  `getDefaultModelLimits`, where each had none; and `temperature`, `top_p` and
  `top_k` left out of their requests, as for the rest of the family.
  `ANTHROPIC_PRICING_LAST_VERIFIED` is now `2026-11-09`; `claude-3-5-haiku`,
  not on that day's price page, keeps `2026-10-19`.
- `getDefaultPricing` still takes the longest prefix that names an id, but a
  prefix no longer names an id that goes on from it with a digit, unless the
  prefix ends in `-`. Before, a prefix named every id that began with it. So a
  dated Fable 5 or Mythos 5 snapshot, such as `claude-fable-5-20260301`, keeps
  Fable 5's or Mythos 5's row rather than taking the 5.2 row its id begins
  with.
