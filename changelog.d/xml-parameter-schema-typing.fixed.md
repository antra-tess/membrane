- **XML tool mode now consults the declared `inputSchema` when parsing
  parameter values.** A parameter declared `type: "string"` keeps its raw,
  untrimmed text. Previously every value was guessed — trimmed, then
  `JSON.parse`d with the trimmed text as fallback — so leading and trailing
  whitespace was destroyed with no way for the model to express it, and a
  string argument whose text happened to be valid JSON silently arrived as an
  object, number, boolean or `null`. **This changes the arguments exact-match
  edit tools receive:** a value written as `"\n  indented line\n"` now arrives
  with its newline and indentation intact where it previously arrived as
  `"indented line"`, and a value of `{"a": 1}` for a string parameter stays the
  string `{"a": 1}`. Tools that compensated by re-trimming, or that relied on
  the coercion, should drop that workaround.
- Parameters declared `object`, `array`, `number`, `integer` or `boolean` are
  JSON-parsed as before, now with a loud `console.warn` naming the tool, the
  parameter and the declared type when the text does not parse (the raw text is
  passed through unchanged) or parses to a different JSON kind than declared.
  Large integers still stay strings so snowflake ids keep their precision.
- **Every spelling of a declaration is honoured, not just
  `properties[param].type`.** A parameter declared as a type array
  (`["string","null"]`), as an `anyOf`/`oneOf` of one type plus null, as a
  `$ref` into the tool's own `definitions`/`$defs` (followed up to three hops,
  cycles included), or inside a ROOT-level `oneOf`/`anyOf`/`allOf` union, now
  resolves to its declared type and is parsed by it. Previously only a direct
  scalar `type` counted, so all of those forms fell back to the legacy guess
  and quietly lost whitespace or changed a JSON-looking string into an object.
  Root-union parameters are found the way `flattenRootSchemaUnion` merges them
  for the Anthropic wire: root `properties` first, then the variants in
  `oneOf`, `anyOf`, `allOf` order, first declaration of a key winning.
- A declared parameter whose schema form does not resolve to a single type
  (a two-non-null union, a `$ref` this parser cannot follow) still gets the
  legacy guess, now with ONE `console.warn` per tool and parameter naming the
  unresolved form and the fallback. Parameters that are simply not declared
  stay silent, so the diagnostic cannot turn into noise.
- The XML tool instructions state the same resolved type, derived by the same
  function the parser uses, so what the model is told a parameter is and what
  the parser decides it is cannot drift. A parameter whose schema had no direct
  scalar `type` used to render as `type="undefined"` (and a type array as
  `type="integer,null"`); it now renders the resolved type, or omits the
  attribute entirely when none resolves. Parameters declared only inside a
  root-level union previously vanished from the XML instructions; they now
  render from the same first-wins property collection the parser uses. This
  changes instruction bytes for those previously broken schemas.
- Parameters with no declared schema keep the previous guess exactly, so
  callers that do not pass `tools` see no change. Schemas reach the parser
  through the new optional `tools` argument on `parseToolCalls`,
  `parseAccumulatedIntoBlocks`, `PrefillFormatter.parseToolCalls` and
  `PrefillFormatter.parseContentBlocks`; membrane threads `request.tools` into
  every XML-mode parse site itself.
