- Isolate Anthropic keepalive bookkeeping failures from foreground results in
  both modes, with a payload-free warning about potentially partial state and
  corrective action. A failed begin permanently stops keepalive for that adapter,
  emits `disabled` with a reason, and explicitly warns of the permanent stop. This changes exception propagation, not the default
  legacy scheduling policy.
- Isolate asynchronous event observer rejections in both modes, like synchronous
  throws; this shared safety change does not alter default-off scheduling.
