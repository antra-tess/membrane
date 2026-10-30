- **Floating cache marker:** it no longer goes at a longer TTL than a marker
  the request already carries. With `cacheTtl: '1h'`, it goes at 5m when the
  request carries a marker at 5m or one with no `ttl` (a content block's own
  `cache_control`, or one a hook set), since the API refuses a one-hour marker
  after a five-minute one. Through an adapter that declares
  `sendsToolResultCacheMarkers: false`, as `OpenRouterAdapter` does, it no
  longer goes onto a tool result, which that adapter sends without it, so the
  request's cache receipt no longer lists a marker that isn't sent.
