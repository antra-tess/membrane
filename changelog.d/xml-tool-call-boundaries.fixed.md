- **XML tool mode refuses a call whose parameter boundaries would change its
  arguments, instead of sending what the lenient parse read.** A value that
  contains a closing parameter tag in an unrecognized namespace (such as
  `</antra:parameter>`) followed by markup for a declared parameter the call
  lacks, a value that contains markup for a parameter the schema makes
  unconditionally required and the call lacks, text inside an invoke outside
  every parameter (a value cut short at a literal closing tag, or a parameter
  never closed), and text after a CDATA value's last section all refuse the
  invoke. A refused invoke is never a `ToolCall` or a `tool_use`. A value
  that contains markup for an optional declared parameter the call doesn't
  otherwise include is still sent as parsed, with a warning. Before, a
  miskeyed closer read through to the next well-formed one, and the call
  dispatched with the next parameter swallowed into the previous value. Both
  `parseToolCalls` and `parseAccumulatedIntoBlocks` apply the same rules. Each
  refusal and warning is a notice the model reads in the results (see Added).
- **CDATA is the literal spelling for a parameter value.** One or more
  consecutive CDATA sections directly after a parameter's opening tag (one
  framing newline allowed), followed only by whitespace before the closer,
  are taken exactly: tool-call, parameter and thinking tags inside are data,
  and `]]>` is carried by splitting it across sections. A CDATA value is a
  string under every declaration except a single non-string type, which gets
  the usual schema-directed JSON parsing. A CDATA opener anywhere else (in
  prose, in thinking, mid-value) is ordinary text. The XML tool instructions
  gain one line saying so, which changes the instruction bytes once, so each
  XML-mode deployment takes one prompt-cache miss.
- **Streaming respects CDATA payloads.** The incremental parser's depth
  tracking and chunk typing ignore tags inside a payload. Local stop detection
  skips a stop sequence inside one, so the chunk is kept rather than truncated
  into a continuation. A provider stop inside a payload is restored exactly
  once and the turn resumes under the existing stall and round guards. A
  payload left unterminated in history ends at the history boundary. One left
  unterminated in the turn keeps its block unclosed, so nothing in it is
  dispatched, and is reported with the parameter named.
- Legacy `tool_use` blocks without `rawXml` are reconstructed so every value
  reads back exactly with its type, under any declaration and without the
  schema: strings as CDATA, other values as JSON with `<` escaped, and a
  top-level number whose JSON is 16 or more digits in exponent form.
- The incremental parser reads tags by element name, so a parameter named
  `thinking_budget` no longer moves the thinking depth. It now also counts
  `antml:`-prefixed openers as it streams; before, `processChunk` emitted them
  as visible text.
