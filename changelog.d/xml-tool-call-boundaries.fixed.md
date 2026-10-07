- **XML tool mode refuses a call whose parameter boundaries would change its
  arguments, instead of sending what the lenient parse read.** A value that
  contains a closing parameter tag in an unrecognized namespace (such as
  `</antra:parameter>`) followed by markup for a declared parameter the call
  lacks, a value that contains markup for a parameter the schema makes
  unconditionally required and the call lacks, text inside an invoke outside
  every parameter (a value cut short at a literal closing tag, or a parameter
  never closed), and text after a CDATA value's last section all refuse the
  invoke. Text after a CDATA value runs to the value's closer and is part of
  that value: an `<invoke>` or `<function_calls>` opener written there starts
  no call of its own and is refused with the invoke that holds it, rather than
  re-anchoring the parse onto a call inside the value. A refused invoke is
  never a `ToolCall` or a `tool_use`. A value
  that contains markup for an optional declared parameter the call doesn't
  otherwise include keeps the call as parsed, with a warning: membrane's loops
  dispatch it, and a no-loop result returns it as a call. Before, a
  miskeyed closer read through to the next well-formed one, and the call
  dispatched with the next parameter swallowed into the previous value. Both
  `parseToolCalls` and `parseAccumulatedIntoBlocks` apply the same rules. Each
  refusal and warning is a notice, recorded in the results the loop injects
  and on the response (see Added).
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
  once and the turn resumes under the existing stall and round guards. A
  payload left unterminated in history ends at the history boundary, and so
  does a value history left open after its payload. One left unterminated in
  the turn keeps its block unclosed, so nothing in it is dispatched, and is
  reported with the parameter named. A thinking or results block that history
  left unclosed does not stop the turn's own calls from being read as calls,
  so their payloads are recognized while they stream, as the complete-text
  parse reads them. Nor is anything inside an envelope the loop injects read
  as the model's markup (the optional `StreamParser.pushEnvelope`; a custom
  parser without it is pushed the envelope as before), so a tool's output
  that opens a thinking block cannot hide a later call's payload.
- A tool-call block the turn's text ends inside is a `tool_attempt` in the
  final content, not text, from its opener to the end of the text. That
  covers an unterminated payload and also a `max_tokens` cut mid-call. Before,
  the partial XML reached consumers as assistant prose.
  `details.stop.unclosedToolBlock` still flags it.
- Legacy `tool_use` blocks without `rawXml` are reconstructed without the
  schema, so that a value reads back exactly, type included, under any
  declaration it satisfies and when undeclared. Strings are written as CDATA,
  other values as JSON with `<` escaped, and a top-level number whose JSON is
  16 or more digits in exponent form. A stored value that contradicts its
  declaration cannot round-trip by any spelling. A number under a declared
  `string`, for example, reads back as a string.
- The incremental parser reads tags by element name, so a parameter named
  `thinking_budget` no longer moves the thinking depth. It now also counts
  `antml:`-prefixed openers as it streams; before, `processChunk` emitted them
  as visible text.
- `onPreToolContent` (XML mode, callback loop) receives only the current
  round's model text, the same slice as `ToolContext.roundPreamble`. Before,
  from the second round on, it received everything after the prefill: earlier
  rounds' text and the `<function_results>` the harness injected.
- `complete()` reads `antml:`-prefixed tool-call blocks. Before, it parsed
  only the unprefixed spelling, so a namespaced call returned neither
  `toolCalls` nor notices.
