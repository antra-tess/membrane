- `NormalizeEvent`: the `cache_suppressed_for_synthetic` variant is removed. It
  described a cache suppression that no longer occurs, so a consumer's switch
  arm for it is now dead and can be deleted; there is no replacement event.
