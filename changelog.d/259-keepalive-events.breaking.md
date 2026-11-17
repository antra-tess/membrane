- **Exhaustive KeepaliveEvent consumers:** handle the new `suppressed` variant
  (`key`, `source: 'foreground' | 'refresh'`) in exhaustive switches. It is emitted
  only with opt-in refusal suppression; legacy scheduling remains the default.
  No released agent-framework, context-manager or connectome-host version is known
  to handle the new variant; no verified minimum compatible versions are available.
  Consumers with exhaustive switches must add the case before enabling suppression.
  Default-off consumers are unaffected by emission; recompiling an exhaustive
  TypeScript consumer against the extended union still requires the new case.
