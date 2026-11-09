- **Cache keepalive callers and `onEvent` observers:** a failed poke now
  retires only its own lineage, not the whole keepalive.
  `maxConsecutiveErrors` counts one lineage's failed pokes in a row, of any
  kind. A successful response resets that count, and so does a real request
  recorded for the lineage. At the cap, that lineage alone is dropped, with a
  `skipped` event whose reason is `failure-cap`. Nothing emits `disabled`
  now, and an `error` event's `consecutive` counts the failures of the
  lineage's snapshot that the poke replayed. A poke whose snapshot a real
  request replaced or dropped while it was under way counts on the old one,
  and drops nothing at the cap.
  - **Who needs to act:** an observer that read `disabled` as the keepalive
    stopping. Other lineages now go on, later real requests are still
    recorded, and each lineage spends its own `maxConsecutiveErrors`.
  - **Migration:** where an observer acted on `disabled`, it acts on a
    `skipped` event whose reason is `failure-cap`, for that lineage alone.
    No sibling's current release acts on `disabled`: connectome-host 0.24.0
    logs each keepalive event as JSON, and agent-framework 0.34.0 and
    context-manager 0.27.0 set no keepalive observer. Those releases cope
    once their ranges admit this version.
  - **What else changes:** a failed poke leaves the lineage's refresh clock
    where it was, so it is tried again at the next check, or once its
    model's wait ends. A poke that fails with an error whose `retryAfterMs`
    is a finite positive number, as a `MembraneError` with a stated wait
    has, holds every lineage of that model until the wait has passed, new
    lineages included. A lineage that falls due an hour or more after its
    last real request or cache-reading poke is dropped instead of sent, and
    so is one whose model's wait lasts to that hour or beyond. Each gets a
    `skipped` event, not an `expired` one, whose reason is `cache-expired`
    or `wait-past-expiry`, two new reasons. An ineffective poke doesn't
    count as a read for that hour. So at the default `refreshAfterMs`, a
    lineage is dropped before a second ineffective poke, unless a real
    request is recorded between them. A lineage dropped at `maxIneffective`
    now gets a `skipped` event, reason `ineffective-cap`, where it got none.
    While a lineage is tracked, a real request recorded after one sent later
    on it changes nothing, so the lineage keeps replaying its newest
    request. Before, it replaced the snapshot and set the lineage's touch
    from its own send, and one in a shape that isn't kept warm dropped the
    lineage. Once a lineage is dropped, a real request recorded on a listed
    lane and in a shape kept warm starts it again, as before.
  - **Unchanged:** the replay's bytes and headers, lanes, `maxLineages`,
    `maxIdleMs`, one receipt per send, and `stop()` and
    `enabled: false`.
