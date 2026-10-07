- **XML tool mode now parses parameter values by the tool's declared
  `inputSchema`.** Previously every value was guessed: trimmed, then
  `JSON.parse`d with the trimmed text as fallback. Leading and trailing
  whitespace was lost unless the model happened to write the value as a JSON
  string literal, and a string argument whose text was valid JSON silently
  arrived as an object, number, boolean or `null`.
- A parameter declared `string` receives its text as written — untrimmed,
  never JSON-parsed — except that one newline directly after the opening tag
  and one directly before the closing tag are layout, the framing tool results
  are written in (`<stdout>\n…\n</stdout>`). **This changes the arguments
  string parameters receive:** an indented line written inline keeps its
  indentation, a value laid out on its own lines arrives without the two
  framing newlines, `{"a": 1}` stays the text `{"a": 1}`, and a value written
  as a JSON string literal keeps its quotes. Tools that compensated by
  re-trimming, or that relied on the coercion, should drop that workaround. A
  value that itself begins or ends with a newline is written with one more
  there.
- A declaration that also admits `null` (`["string","null"]`, an
  `anyOf`/`oneOf` with a `null` branch) receives JSON `null` for the text
  `null`, and the XML tool instructions mark the parameter `nullable="true"`.
  A string parameter that does not admit null receives the text `null`.
- Parameters declared `object`, `array`, `number`, `integer`, `boolean` or
  `null` are JSON-parsed as before, with a `console.warn` naming the tool, the
  parameter and the declared type when the text does not parse (the raw text
  is passed through) or parses to another JSON type. The diagnostic never
  includes the argument value: tool inputs routinely carry credentials, tokens
  and private document text. Integers of 16 or more digits (Discord snowflakes
  and the like) stay text under every declaration, as on the legacy path; for
  a declaration other than `number`/`integer` that also warns.
- **Which declarations are read.** A parameter's type is what its declaration
  admits: its `type` (a name or an array of names) when present; otherwise its
  `enum`/`const` values, `anyOf`/`oneOf` (any branch), `allOf` (every branch)
  and `$ref` into the tool's own `definitions`/`$defs` (flat names, chains of
  any length), all together. Parameters are read from the root `properties`
  and, when every variant of a root `oneOf`/`anyOf`/`allOf` is an object
  schema — exactly the unions the Anthropic native wire merges — from the
  variants: the root's own declaration and `allOf` branches all apply, while
  the `oneOf`/`anyOf` alternatives that declare a parameter are alternatives.
  The XML tool instructions are rendered from the same reading, so the type a
  model is told a parameter has is the type its value is parsed by.
- **What is not read.** A declaration that admits several types (`string` or
  `number`; root alternatives that disagree, such as a discriminated union
  whose alternatives declare one parameter as `string` and as `object`), none
  (a contradiction), a name that is not a JSON Schema type, or a `$ref` that
  cycles or points outside the tool's schema keeps the legacy guess, with one
  `console.warn` per distinct schema form, and the instructions state no type
  for it. A root union with a variant that is not an object schema (a `$ref`
  variant, a string alternative) is read on neither wire: the native wire
  falls back to a permissive schema, the XML instructions list the root's own
  parameters, and a parameter outside them keeps the legacy guess, with one
  warn. Keywords such as `not` and `if`/`then`/`else` are not consulted. A
  declaration that admits any value (`{}`, a description alone) and an
  undeclared parameter keep the legacy guess silently.
- **XML tool instructions.** `type`, `nullable="true"` and `required="true"`
  come from the reading above; requiredness follows root-combinator semantics
  (root `required` and every `allOf` branch's, plus keys every
  `oneOf`/`anyOf` alternative requires) through the derivation the native
  `flattenRootSchemaUnion` uses. For tools without a root union whose
  parameters all carry a direct JSON Schema `type` name, the instructions are
  byte-identical to before. They change where the old rendering was broken:
  `type="undefined"` for a parameter without a direct `type` (now the type
  read, or no attribute), a type array joined with commas
  (`type="integer,null"` is now `type="integer" nullable="true"`;
  `type="string,number"` now has no attribute), parameters declared only
  inside a mergeable root union (previously missing), and a type name that is
  not a JSON Schema type (now no attribute).
- `flattenRootSchemaUnion` merges a variant property named like an
  `Object.prototype` member (`constructor`, `toString`) instead of dropping it,
  and no longer keeps such a name in `required` with no property behind it.
- Schemas reach the parser through the new optional `tools` argument on
  `parseToolCalls`, `parseAccumulatedIntoBlocks`,
  `PrefillFormatter.parseToolCalls` and `PrefillFormatter.parseContentBlocks`;
  membrane threads `request.tools` into every XML-mode parse site itself.
  Callers that pass no `tools` see no change. `toolDefinitionForPrompt` is
  exported: a tool as the XML instructions present it, from the same reading.
