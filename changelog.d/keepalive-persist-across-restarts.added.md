- `cacheKeepalive.statePath` (Anthropic adapter): the prompt-cache keepalive
  saves its tracked lineages to this file and a new process given the same
  path takes them back up, refreshing each when it's due, so restarting an
  agent no longer leaves its cached prefix to expire. A refresh replays the
  saved request as before the restart (with `max_tokens: 0` and the messages
  after its last one-hour marker left out). A lineage whose cache entry was
  last read or written an hour or more before the restart, or past
  `maxIdleMs`, isn't restored. Only the `anthropic-beta` and
  `anthropic-version` headers are saved, a request holding what looks like a
  credential (such as `mcp_servers[].authorization_token`) stays in memory
  only, and the file is written atomically with mode 0600. One keepalive per
  file; `CacheKeepalive#persistPath` says which file it is saving to. New
  `KeepaliveEvent`s: `restored`, `persist-error` and `not-persisted`.
