- Isolate Anthropic keepalive bookkeeping failures from foreground results in
  both modes, with a payload-free warning about potentially partial state and
  corrective action. This changes exception propagation, not the default
  legacy scheduling policy.
- Isolate asynchronous event observer rejections in both modes, like synchronous
  throws; this shared safety change does not alter default-off scheduling.
- With refusal suppression enabled, retain SDK-native request values without a lossy JSON parse round trip
  (caller mutation and custom serialization are outside the identity guarantee), reject non-finite refresh usage as a processing failure, and release
  live attempt data on stop. Default-off scheduling remains unchanged.
- With refusal suppression enabled, honor newer ineligible prefix ordering after
  refusal and release finished attempt data even when opaque handles are retained.
