- A stream that keeps its connection up with keepalives while the model
  sends nothing ends. `AnthropicAdapter`'s idle timer counted keepalive bytes
  as activity, so a stream that pinged and never progressed ran until the
  caller gave up; the bounds per phase now end it (400 s before first content,
  180 s between events after it, or a silent think's allowance when that's
  longer).
