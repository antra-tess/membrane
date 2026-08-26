- `details.cache.markersInRequest` now reports the real count on the native tool
  paths (`stream()` and `streamYielding()` with native tools), recounted from the
  request that was built. Both hardcoded `0` while placing markers of their own —
  including the floating tool-loop marker — which made the 4-breakpoint budget
  unauditable from response telemetry on exactly the paths that spend it hardest.
