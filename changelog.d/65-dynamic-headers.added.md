- `AnthropicAdapterConfig.dynamicHeaders`: an optional callback evaluated at
  request time and merged over the per-request beta headers of the outgoing
  call — for values that change between calls (e.g. gateway telemetry
  stamps). Cache-keepalive replays deliberately resend their recorded
  pre-merge headers, so a stale stamp is never replayed (#65).
