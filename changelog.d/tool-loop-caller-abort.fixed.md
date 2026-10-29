- `stream()` ran a tool round's `onToolCalls` after the caller's signal had
  fired, in both its XML and native tool loops: a signal that fired while
  `onPreToolContent` ran, or anywhere after the round's text came in and before
  its tools ran, didn't stop them. Such a round now runs none of its tools, and
  the turn ends as the caller's abort already ends it: the aborted response,
  reason `user`, whose `toolCalls` and `toolResults` list only the rounds that
  ran.
