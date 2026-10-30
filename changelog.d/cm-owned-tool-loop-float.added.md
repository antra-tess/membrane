- **`cacheMarkers: 'cm-owned'` callers:** a caller can now ask for the
  floating cache marker with `floatingCacheMarker: true`, on the request or as
  the config's `defaultFloatingCacheMarker`. Left unset, a `cm-owned` request
  carries only the markers its caller placed, as before. When asked for, the
  native tool loop's later requests carry the float on their newest message,
  and on the message before the round's calling turn when two or more slots
  are free. It is placed after the `beforeRequest` hook, once the caller's
  markers have passed the check a first request's markers get. Without it,
  each later call of a tool turn pays every earlier round of the turn again as
  uncached input. When the caller's markers already occupy all four slots, the
  float takes the earliest message marker's slot: within one tool loop
  membrane changes nothing before the turn's opening, so that marker's prefix
  lies inside the newest marker's. A system or tools marker is never taken, so
  a request whose four markers all sit there gets no float, and membrane warns
  that it was withheld. No float is placed on a call whose normalization
  repair rewrote the prefix, or when prompt caching is off.
  Each later call then pays to write the part of its request it can't read:
  its newest round, once the turn's opening is cached. A later read of that
  write needs a marker at the same TTL whose backward search reaches it,
  within that TTL and with the prefix up to there unchanged: the turn's next
  call reaches it across one round of tool calls, and the next turn's first
  call reaches it from a marker the caller placed at that turn's opening. When
  each call reads the write before it and nothing reads the turn's last write,
  the turn costs more than before by at most the write premium on what its
  last call writes, plus, at a one-hour TTL, the read price of what the call
  before it wrote. A call that can't read an earlier write, because its TTL
  has passed or the search doesn't reach it, writes that part again at the
  premium. With a one-hour TTL, a prompt-cache keepalive after such a turn
  refreshes through the float, so it keeps the turn's rounds warm too.
  A caller on context-manager's kv-unified strategy should ask for it only
  with a context-manager release whose cache receipts leave a tool loop's
  later calls out of its cache reference. With an older one, a floated call
  whose marker count differs from the compile's clears kv-unified's cache
  reference, so its next compile weighs no cache costs, and one whose count
  matches records its own wire receipt beside the reference the first call
  set.
- **Provider adapters:** `ProviderAdapter.sendsToolResultCacheMarkers`, left
  out as true, says whether a `cache_control` marker on a `tool_result` block
  reaches the provider. `OpenRouterAdapter` declares false, since it sends a
  tool result as a `role: 'tool'` message with string content. Through such an
  adapter membrane floats no marker onto a tool result and takes no caller's
  marker for one; a float on a text block is sent. A decorator should forward
  it; one that doesn't is taken to send them.
