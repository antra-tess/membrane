- **Exhaustive KeepaliveEvent consumers:** handle the new `suppressed` variant
  (`key`, `source: 'foreground' | 'refresh'`) in exhaustive switches. It is emitted
  only with opt-in refusal suppression; legacy scheduling remains the default.
