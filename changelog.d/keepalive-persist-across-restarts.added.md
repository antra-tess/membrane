- `cacheKeepalive.statePath` (Anthropic adapter): the prompt-cache keepalive
  saves its tracked lineages to this file and a new process given the same
  path takes them back up, so restarting an agent no longer leaves its
  cached prefix to expire. The replay is the recorded request's own bytes. A
  lineage whose entry went untouched for an hour or more while the process
  was down, or past `maxIdleMs`, isn't restored. Only `anthropic-*` request
  headers are saved, and the file is written atomically with mode 0600.
  New `KeepaliveEvent`s: `restored` and `persist-error`.
