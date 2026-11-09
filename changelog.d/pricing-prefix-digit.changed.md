- `getDefaultPricing` still takes the longest prefix that names an id, but a
  prefix no longer names an id that goes on from it with a digit, unless the
  prefix ends in `-`. Before, a prefix named every id that began with it. So a
  dated Fable 5 or Mythos 5 snapshot, such as `claude-fable-5-20260301`, keeps
  Fable 5's or Mythos 5's row rather than taking the 5.2 row its id begins
  with.
