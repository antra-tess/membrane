- Isolate Anthropic keepalive bookkeeping failures from foreground results in
  both modes, with a payload-free warning about potentially partial state and
  corrective action. A failed begin stops keepalive rather than scheduling with
  an unobservable refusal. This changes exception propagation, not the default
  legacy scheduling policy. Observe complete refusals before prefix bookkeeping
  and do not qualify streams cancelled in final callbacks.
- Isolate asynchronous event observer rejections in both modes, like synchronous
  throws; this shared safety change does not alter default-off scheduling.
- With opt-in refusal suppression, nonfinite lineage caps use the bounded default.
  With suppression unset or false, cap handling matches main without normalization
  (NaN and positive Infinity are unbounded; negative Infinity retains nothing).
