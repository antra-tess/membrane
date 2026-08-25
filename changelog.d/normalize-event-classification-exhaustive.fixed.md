- The prefix-rewriting classification of normalizer events is now exhaustive
  and compiler-enforced: a `Record` over the whole `NormalizeEvent` union
  derives `PREFIX_REWRITING_NORMALIZE_EVENT_KINDS`, so adding a kind is a
  missing-property error until someone decides whether it rewrites prefix
  bytes. The previous `[...] satisfies Array<NormalizeEvent['kind']>` only
  checked that the LISTED kinds were real and accepted any subset — a new
  prefix-rewriting repair could join the union, never be listed, and silently
  escape the cache-placement gate while the comment beside it promised a
  compile error that did not exist.
