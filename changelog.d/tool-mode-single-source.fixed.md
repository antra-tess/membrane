- `request.toolMode` is now honored on the `complete()` path. `complete()` built
  through the formatter's constructor-time tool mode and never consulted
  Membrane's resolver, so a `complete()` request carrying `toolMode: 'native'`
  against the default `AnthropicXmlFormatter` still got XML tool instructions
  injected into the conversation and no native tool declarations on the wire,
  while the same request through `stream()` got native tools. Both paths now
  resolve through `resolveToolMode`.
- Tool-mode resolution honors a formatter's explicitly configured mode. The
  precedence is: an explicit non-`auto` `request.toolMode`, then the mode the
  building formatter was constructed with (`new AnthropicXmlFormatter({ toolMode:
  'native' })`), then formatter/provider derivation. Resolution reads the
  formatter that actually builds the request, so a per-request
  `options.formatter` override participates in it.
- Two previously incoherent `stream()` combinations move as a consequence, both
  reachable only with a formatter constructed as `toolMode: 'native'`: an
  explicit `request.toolMode: 'xml'` now wins over that constructor mode (it was
  silently ignored on both paths), and an `auto` request now runs the native tool
  loop instead of running the XML loop over a request that already carried native
  tool declarations.
