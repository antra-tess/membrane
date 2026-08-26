- `details.cache.markersInRequest` on the native tool paths now counts the
  request that SHIPPED rather than the request the builder produced. The count
  was taken immediately after `buildNativeToolRequest`, before `streamOnce`
  applies the `beforeRequest` hook and before the wire clamp drops everything
  past the 4-breakpoint budget — so a hook that placed 7 markers on a wire that
  carried 4 was reported as 1. The number now comes from the clamp's own tally,
  the single point that sees every contribution.
