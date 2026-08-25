- The wire-boundary cache clamp can no longer reach back into the caller's own
  request. `request.system` accepts caller-marked blocks and the builders passed
  that array through by reference when they added no marker of their own, so an
  in-place strip at the wire would have deleted a long-lived caller's breakpoints
  permanently. Every build exit (native builder, `transformRequest`, both
  continuation builders) now shallow-copies the system array and its blocks, so
  the clamp's mutations stay inside the request it is clamping.
