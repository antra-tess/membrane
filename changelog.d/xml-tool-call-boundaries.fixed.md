- **XML tool mode refuses a call whose parameter boundaries would change its
  arguments, instead of sending what the lenient parse read.** These refuse
  the invoke:
  - a value that contains a closing tag the parser doesn't recognize as a
    parameter closer, followed by a parameter opener of any name, with any
    text between. Such a closer is any closing tag whose name begins with
    `param` (a misspelling such as `</param>`, `</paramter>`, `</parameters>`
    or `</parameter >`, and other names such as `</parameterList>`), or a
    `parameter` closer in another namespace (such as `</antra:parameter>`);
  - a value that contains an opener for a parameter the tool declares and the
    call lacks, required or optional: an unclosed or wrongly closed value
    swallowed it. Declared means any name the schema gives a parameter, in a
    root combinator's variants and in `required` lists too;
  - text inside an invoke after a parameter (a value cut short at a literal
    closing tag, or a parameter never closed), markup before an invoke's first
    parameter (a parameter the parser doesn't read, such as `<path>…</path>`,
    another namespace or a single-quoted name), text in an invoke with no
    parameter the parser reads, and text after a CDATA value's last section;
  - an invoke left open before another invoke begins, which used to be
    dropped with only an operator log line. The invoke it swallowed still runs.

  A parameter opener inside a value is read in any namespace, with either
  quote. One for a parameter the call includes, or one the tool doesn't
  declare, with no such closer before it, is the value's own text. So is
  another vocabulary's element, such as a C# doc comment's `<param>` or
  XSLT's `<xsl:param>`. The closer rule needs no schema. Text after a CDATA
  value runs to the value's closer and is part of that value: an `<invoke>` or
  `<function_calls>` opener written there starts no call of its own and is
  refused with the invoke that holds it, rather than re-anchoring the parse
  onto a call inside the value. A refused invoke is never a `ToolCall` or a
  `tool_use`. Text before an invoke's first parameter that contains no markup
  apart from complete comments and processing instructions, such as a model's
  commentary, keeps the call as parsed, with a warning: no value precedes it
  to have been cut, and the tool never receives it. So do complete comments
  and processing instructions alone in an invoke with no parameter. Before, a
  miskeyed closer read through to the next well-formed one, and the call
  dispatched with the next parameter swallowed into the previous value; text
  inside an invoke outside every parameter was ignored, so the tail of a value
  cut at a literal closing tag, or a value written as a parameter the parser
  doesn't read, was dropped without a word. **This also refuses calls that
  used to work:** prose between or after an invoke's parameters, or in an
  invoke with no parameter, is now refused, as is a value holding a lone
  opener for a parameter the call leaves out, which CDATA sends as written.
  Prose before the first parameter still dispatches, now with a warning. Both
  `parseToolCalls` and `parseAccumulatedIntoBlocks` apply the same rules.
  Each refusal and warning is a notice, recorded in the results the loop
  injects and on the response (see Added). A refusal about a value ends by
  pointing to CDATA; one with no value at fault, text where no parameter holds
  it, points to the parameter element.
- **CDATA is the literal spelling for a parameter value.** One or more
  consecutive CDATA sections directly after a parameter's opening tag (one
  framing newline allowed), followed only by whitespace before the closer,
  are taken exactly: tool-call, parameter and thinking tags inside are data,
  and `]]>` is carried by splitting it across sections. A CDATA value is a
  string under every declaration except a single non-string type, which gets
  the usual schema-directed JSON parsing. A CDATA opener anywhere else (in
  prose, in thinking, mid-value) is ordinary text. The XML tool instructions
  (conversation and system placement, and `getToolInstructions`) gain one
  line saying so, `CDATA_INSTRUCTION`, so their bytes change, and so does
  every cached prefix that includes them.
- **Streaming respects CDATA payloads.** The incremental parser's depth
  tracking and chunk typing ignore tags inside a payload. Local stop detection
  skips a stop sequence inside one, so the chunk is kept rather than truncated
  into a continuation. A provider stop inside a payload is restored exactly
  once and the turn resumes under the existing stall and round guards; the
  resumption spends none of `maxToolDepth`, which bounds tool rounds. A
  payload left unterminated in history ends at the history boundary, and so
  does a value history left open after its payload. One left unterminated in
  the turn keeps its block unclosed, so nothing in it is dispatched, and is
  reported with the parameter named. A thinking or results block that history
  left unclosed does not stop the turn's own calls from being read as calls,
  so their payloads are recognized while they stream, as the complete-text
  parse reads them. Nor is anything inside an envelope the loop injects read
  as the model's markup (the optional `StreamParser.pushEnvelope`, which a
  custom parser that reads markup should implement; one without it is pushed
  the envelope as before), so a tool's output that opens a thinking block
  cannot hide a later call's payload.
- A tool-call block the turn's text ends inside is a `tool_attempt` in the
  final content, not text, from its opener to the end of the text, once an
  invoke head follows the opener. That covers an unterminated payload and also
  a `max_tokens` cut mid-call. A cut right after a bare opener stays text, as
  an opener quoted in prose does. Before, the partial XML reached consumers as
  assistant prose. `details.stop.unclosedToolBlock` still flags it.
- Legacy `tool_use` blocks without `rawXml` are reconstructed without the
  schema, so that a value reads back exactly, type included, under any
  declaration it satisfies and when undeclared. Strings are written as CDATA,
  other values as JSON with `<` escaped, and a top-level number whose JSON is
  16 or more digits in exponent form. A stored value that contradicts its
  declaration cannot round-trip by any spelling. A number under a declared
  `string`, for example, reads back as a string. A history holding such blocks
  therefore renders different bytes after upgrading, and its cached prefix
  misses once.
- The incremental parser reads tags by element name, so a parameter named
  `thinking_budget` no longer moves the thinking depth. It now also counts
  `antml:`-prefixed openers as it streams; before, `processChunk` emitted them
  as visible text. A stray closer no longer takes a depth below zero while
  streaming, a self-closing parameter tag opens no value, and a tag right after
  a stray `<` is still read, each as the complete-text parse reads them.
- `onPreToolContent` (XML mode, callback loop) receives only the current
  round's model text, the same slice as `ToolContext.roundPreamble`. Before,
  from the second round on, it received everything after the prefill: earlier
  rounds' text and the `<function_results>` the harness injected.
- `complete()` reads `antml:`-prefixed tool-call blocks. Before, it parsed
  only the unprefixed spelling, so a namespaced call returned neither
  `toolCalls` nor notices.
