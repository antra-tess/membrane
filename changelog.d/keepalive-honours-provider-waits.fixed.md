- The Anthropic cache keepalive honours a provider's stated wait for every
  lineage of a model. When a call to a model through the adapter states a
  wait (`retryAfterMs` on a failed `complete` or `stream` call, whatever its
  retryability, or on a refused poke), no lineage of that model is poked
  until the wait passes, including one due later in the same tick. A later,
  shorter wait never shortens a hold, and a wait that isn't a finite positive
  number holds nothing. The hold is that adapter's keepalive's, so another
  adapter's lineages of the model aren't held.
  - A poke refused with a failure the adapter classifies as retryable, such as
    a rate limit or an overload, no longer counts toward
    `maxConsecutiveErrors`, and doesn't reset the count. It holds the model
    for the later of its stated wait and a backoff of `checkIntervalMs`
    doubling with each such refusal in a run, never more than
    `refreshAfterMs`, and its lineage keeps its age, so it's poked again once
    the hold passes. An accepted poke ends the run. A refusal carries it on
    only when its poke came from the first check to begin at or after the end
    of the model's last hold, whatever set it, and a hold set once a check
    that began at or after that end has finished starts a new run. Before,
    three refused pokes in a row, such as one overload with three lineages
    due, stopped the keepalive for the adapter's life. A failure that isn't
    retryable still counts, and a wait it states still holds the model. A
    retryable refusal whose hold comes to 0, as with no stated wait and a
    `checkIntervalMs` or `refreshAfterMs` of 0, counts too.
  - The SDK no longer retries a refused poke itself. It sent the poke up to
    twice more within about 1.5 s when no wait was stated, and also when the
    stated wait was 60 s or more, which put those resends inside the wait.
    So a refused poke's one receipt (`onCall`) now carries the refusal,
    where a retry the SDK made could end in a success.
  - New: `CacheKeepalive.holdModel(model, retryAfterMs, reason)`; the `held`
    event, `{ type: 'held', model, until, reason }`, sent when a hold begins
    or grows; and an optional third constructor argument that classifies a
    failed poke's error as a `KeepaliveFailureClassification`, which the
    Anthropic adapter passes.
  - A `CacheKeepalive` option given as `undefined` takes its default, as one
    left out does.
