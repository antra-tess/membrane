- `cacheKeepalive.statePath` (Anthropic adapter): the prompt-cache keepalive
  saves its tracked lineages to this file and a new process given the same
  path takes them back up, refreshing each when it's due, so restarting an
  agent no longer leaves its cached prefix to expire. A refresh replays the
  saved request as before the restart (with `max_tokens: 0`, and with the
  messages after its last one-hour marker left out apart from what it takes to
  end where a user turn ends). A lineage is restored only when its lane is
  kept, its request is still eligible, its last real request is less than
  `maxIdleMs` old and its cache entry was last read or written less than an
  hour before; each one left out gets a `skipped` or `expired` event. A
  restored lineage whose model, system prompt or tools the agent no longer
  sends is still refreshed until `maxIdleMs`: delete the file after such a
  change. Only the `anthropic-beta` and `anthropic-version` headers are saved.
  A request that looks like it holds a credential stays in memory only:
  outside the conversation, a field with a credential-like name in any
  spelling (such as `mcp_servers[].authorization_token`) or a URL with a
  password or credential-like query parameter; inside it, a string under a
  credential-like name, such as a tool call's `api_key` input. Secrets in free
  text aren't detected. The file is written atomically with mode 0600 (on
  POSIX), under a lock beside it, and temp files a crash left are removed at
  start. One keepalive per file: one takes the file when it starts, and the
  one that had it stops saving there; `CacheKeepalive#persistPath` says which
  file it is saving to. New `KeepaliveEvent`s: `restored`, `persist-error` and
  `not-persisted`.
