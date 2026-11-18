- Isolate Anthropic keepalive bookkeeping failures from foreground results in
  both modes, with a payload-free warning about potentially partial state and
  corrective action. This changes exception propagation, not the default
  legacy scheduling policy.
- Isolate asynchronous event observer rejections in both modes, like synchronous
  throws; this shared safety change does not alter default-off scheduling.
- In both keepalive modes, unprintable sender errors use `Unprintable keepalive error`
  and continue failure accounting and error/disabled notifications instead of
  throwing during formatting. Ordinary string-valued Error messages retain
  legacy formatting; non-string messages are converted to strings.
- With suppression enabled, keepalive notices explain how to recover from a
  replay preparation failure or a permanent stop at the consecutive failure
  threshold. After a replay snapshot is retired, send a new eligible foreground
  request once serialization is fixed.
- Opt-in `receipt-clone-failed` notices explain how to restore receipt delivery:
  make the replay request and response structured-cloneable.
