- **`cm-owned` callers whose config sets `defaultFloatingCacheMarker: true`,**
  as 0.9.0 documented its default: their native tool loop's later requests
  now carry the floating cache marker, as described under Added, where before
  they carried only the markers their caller placed. Through an adapter that
  declares `sendsCacheMarkersOn` (under Added), when the caller's markers hold
  all four slots, the float can take the earliest message marker's slot.
