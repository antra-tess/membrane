- **`cacheMarkers: 'cm-owned'` callers:** a caller can now ask for the
  floating cache marker with `floatingCacheMarker: true`, on the request or as
  the config's `defaultFloatingCacheMarker`. Left unset, a `cm-owned` request
  carries only the markers its caller placed, as before. When
  asked for, the native tool loop's later requests carry the float on their
  newest message, and on the message before the round's calling turn when two
  or more slots are free and its block can carry one. It is placed after the
  `beforeRequest` hook, once the caller's markers have passed the check a
  first request's markers get. Without it, each later call of a tool turn pays
  every earlier round of the turn again as uncached input. When the caller's
  markers already occupy all four slots, the float takes the earliest message
  marker's slot, through an adapter that declares which blocks it sends a
  marker on (below); through one that doesn't, it takes none, and membrane
  warns that the float was withheld, naming the missing declaration when a
  caller's message marker was there to take. Within one tool loop membrane
  changes no message content before the turn's opening, so that marker's
  content lies inside the newest marker's prefix, though its block no longer
  carries `cache_control` on the wire. A system or tools marker is never
  taken, so a request whose four markers all sit there gets no float, and
  membrane warns that it was withheld. No float is placed on a call whose
  normalization repair rewrote the prefix, when prompt caching is off, or on a
  block of a type the adapter sends no marker on: through OpenRouter's
  adapter, which sends a marker only on text, a tool loop's newest round, a
  tool result, gets none and no withheld warning, and only the message before
  the round's calling turn can be marked, when it ends in text. Where the
  float is placed, each later call then pays to write the part of its request
  it can't read: its newest round, once the turn's opening is cached. A later
  read of that write needs a marker whose backward search
  reaches it, within that TTL and with the prefix up to there unchanged: on
  the Claude API, the turn's next call can reach it across one round of tool
  calls, since the backward search checks 20 positions and counts a run of
  `tool_use` blocks, or of `tool_result` blocks, as one
  (https://platform.claude.com/docs/en/build-with-claude/prompt-caching), and
  the next turn's first call from a marker the caller places at that turn's
  opening.
  When each call reads the write before it and nothing reads the turn's last
  write, the turn costs more than before by at most the write premium on what
  its last call writes, plus, at a one-hour TTL, the read price of what the
  call before it wrote. A call that can't read an earlier write, because its
  TTL has passed or the search doesn't reach it, writes that part again at the
  premium. When the last call's float is at 1h, which needs a one-hour
  `cacheTtl` and every marker before it at 1h, a prompt-cache keepalive after
  such a turn refreshes through that float, so it keeps the turn's rounds warm
  too. A caller on context-manager's kv-unified strategy should ask for it
  only with context-manager 0.25.0 or later, whose cache receipts leave a tool
  loop's later calls out of its cache reference. With an older one, a floated call
  whose marker count differs from the compile's clears kv-unified's cache
  reference, so its next compile weighs no cache costs, and one whose count
  matches sets the reference again from the compile's layout, as the first
  call did, and records its own wire receipt with it.
- **Provider adapters:** `ProviderAdapter.sendsCacheMarkersOn` says which
  content blocks an adapter sends a `cache_control` marker on. A list of types
  narrows both where a float goes and the take to blocks of those types:
  `OpenRouterAdapter` declares `['text']`, since its image, audio, tool-use
  and tool-result parts carry none. `true`, a marker on any block membrane
  would place one on, leaves a float free to go on any such block, and allows
  the take: `AnthropicAdapter` and `BedrockAdapter` declare it. Left out, a
  float may still go on any such block, but no caller's marker is taken, since
  membrane can't tell whether the float it would place is sent. A decorator
  should forward it; one that doesn't leaves it out, so under `cm-owned` a
  caller's marker is never taken for a float the wrapped adapter may not send.
