- **`cacheMarkers: 'cm-owned'` callers:** the native tool loop's later
  requests now carry the floating cache marker on their newest message, and on
  the message before the round's calling turn when two or more slots are free.
  They carry none when `floatingCacheMarker` or prompt caching is off, or on a
  call whose normalization repair rewrote the prefix. The float is placed
  after the `beforeRequest` hook, once the caller's markers have passed the
  check a first request's markers get. Before, a `cm-owned` request carried no
  floating marker, so each later call of a tool turn paid every earlier round
  of the turn again as uncached input. When the caller's markers already
  occupy all four slots, the float takes the earliest message marker's slot:
  within one tool loop membrane changes nothing before the turn's opening, so
  that marker's prefix lies inside the newest marker's. A system or tools
  marker is never taken, so a request whose four markers all sit there gets no
  float, and membrane warns that it was withheld. Each later call now pays to
  write, at the request's `cacheTtl`, the part of its request it can't read:
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
  premium. With a one-hour `cacheTtl`, a prompt-cache keepalive after such a
  turn refreshes through the float, so it keeps the turn's rounds warm too.
  OpenRouter's adapter sends a tool result as a string, so a float on a
  tool-results message isn't sent there; one on a text message is. Under the
  default `membrane-system`, nothing changes. context-manager's kv-unified
  strategy should take a release whose cache receipts leave a tool loop's
  later calls out of its cache reference before it takes this one: with an
  older one, each floated call whose marker count differs from the compile's
  clears kv-unified's cache reference, so its next compile weighs no cache
  costs.
