- **Cache keepalive callers and `onEvent` observers:** a failed poke now
  retires only its own lineage, not the whole keepalive.
  `maxConsecutiveErrors` counts one lineage's failed pokes in a row, of any
  kind. A successful response resets that count, and so does a real request
  recorded for the lineage. At the cap, that lineage alone is dropped, with a
  `skipped` event whose reason is `failure-cap`. Nothing emits `disabled`
  now, and an `error` event's `consecutive` counts its lineage's failures.
  - **Who needs to act:** an observer that read `disabled` as the keepalive
    stopping. Other lineages now go on, later real requests are still
    recorded, and each lineage spends its own `maxConsecutiveErrors`.
    connectome-host logs every event as JSON, so it copes as it is.
  - **What else changes:** a failed poke leaves the lineage's refresh clock
    where it was, so it is tried again at the next check, or once its
    model's wait ends. A poke that fails with an error whose `retryAfterMs`
    is a finite positive number, as a `MembraneError` with a stated wait
    has, holds every lineage of that model until the wait has passed, new
    lineages included. A lineage that falls due an hour or more after its
    last real request or cache-reading poke is dropped instead of sent
    (`cache-expired`), and so is one whose model's wait lasts to that hour
    or beyond (`wait-past-expiry`). An ineffective poke doesn't count as a
    read for that hour, so at the default `refreshAfterMs` a lineage is
    dropped before a second ineffective poke, and `maxIneffective` above 1
    has no effect there. A real request recorded after one sent later on its
    lineage changes nothing, so the lineage keeps replaying its newest
    request. Before, it replaced the snapshot and set the lineage's touch
    from its own send, and one in a shape that isn't kept warm dropped the
    lineage.
  - **Unchanged:** the replay's bytes and headers, lanes, `maxLineages`,
    `maxIdleMs`, one receipt per send, and `stop()` and
    `enabled: false`.
