- Isolate Anthropic keepalive bookkeeping failures from foreground results in
  both modes, with a payload-free warning about potentially partial state and
  corrective action. This changes exception propagation, not the default
  legacy scheduling policy.
- Isolate asynchronous event observer rejections in both modes, like synchronous
  throws; this shared safety change does not alter default-off scheduling.
- With refusal suppression enabled, send the same owned JSON body that the keeper
  hashes, reject non-finite refresh usage as a processing failure, and release
  live attempt data on stop. Default-off scheduling remains unchanged.
