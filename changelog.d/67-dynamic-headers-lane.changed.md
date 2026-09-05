- `dynamicHeaders` receives `{ lane: 'stream' | 'complete' }` so a host can
  withhold turn-describing stamps from background calls; zero-argument
  callbacks keep working, `DynamicHeadersContext` is exported (#67).
