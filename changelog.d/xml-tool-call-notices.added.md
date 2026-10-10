- **XML tool mode records why a call was not sent, for the model and the caller.**
  Each refused or warned invoke yields a `ToolCallNotice` (`invoke`, the
  invoke's 0-based ordinal among its block's invoke openers; `toolName`;
  `kind: 'refused' | 'warning'`; `message`, which for a refusal ends by
  pointing to CDATA). In both XML loops the injected `<function_results>`
  carries the round's notices after its results, as
  `<tool_call_notice invoke tool kind>` elements. `ToolContext.notices` holds
  them, and `formatToolResults` takes them as a second argument.
- A round in which every invoke was refused does not call the executor.
  Membrane answers the block with a notices-only envelope, recorded for
  continuation and replay, and continues once. The continuation counts
  against `maxToolDepth` and the resumption cap; at the cap the turn ends with
  `round_limit`, with the round still answered and recorded but the notices
  unread. The yielding stream emits a new non-executor event for every such
  round, `{ type: 'tool-attempt', rawXml, notices, context }`
  (`isToolAttemptEvent`), not a zero-call `tool-calls` event. The callback
  loop still delivers the round's text through `onPreToolContent`.
- `NormalizedResponse.toolCallNotices` lists the turn's notices with `block`,
  the function_calls block's 0-based index in the turn's text, beside
  `invoke`. Each also carries `answered`, which is true when membrane answered
  that block in-band (the notice is then also a `tool_notice` in the content
  and was on that round's event). It is false when nothing answered the
  block: it never closed, or no loop ran. The field is absent when there are
  no notices, and in native mode. `complete()` and `stream()` without
  `onToolCalls` run no loop, so their callers answer these notices with their
  results.
- Two content block types carry this history. `tool_attempt` `{ rawXml }` is
  a function_calls block that dispatched nothing, on the assistant side,
  because every invoke was refused or because the turn ended before it
  closed. It is never a tool_use. `tool_notice` `{ notices }` is the harness's notice, after
  the round's tool_results. The final parse produces them, and the XML
  formatter replays them as the bytes the model saw. The native formatter,
  whose output also feeds the Gemini, OpenRouter and openai-compatible
  adapters, membrane's native tool loop (which builds its own requests, first
  and on every continuation), and the Responses formatter render the attempt
  as the assistant's text and the notice as harness-side text after any tool
  results. The
  completions formatter omits both, as it omits every tool carrier. Code that
  switches exhaustively over `ContentBlock['type']` or `StreamEvent['type']`
  needs cases for the new members. A consumer that persists XML rounds from
  yielded events should persist the attempt and the notices, or the resident
  loses them from history.
- **Envelopes have provenance.** The loops record the offsets of every
  envelope they inject and pass them to the parse as
  `ToolParseOptions.harnessEnvelopes`; `complete()` passes none, since it
  injects nothing. With provenance supplied, only those envelopes speak for
  the harness: only they answer a block (so `parseToolCalls` no longer skips
  a call because the model wrote a lookalike envelope after it, which used to
  hide the call from `complete()`), only their results are tool results (a
  lookalike is the model's own text), and only their notices are read and
  decide their block's refusals. Each envelope is also a speaker boundary:
  markup the model wrote before it never pairs with a tag inside or after it,
  so a results or thinking opener the model left unclosed cannot take the
  call the envelope answers, its results or its notices out of the response.
  Offsets that do not span exactly one results element are not an envelope.
  Without provenance, as for an outside caller
  of `parseToolCalls` or a formatter's `parseContentBlocks` on a raw
  transcript, results spans are read as before, but no notices or recorded
  refusals are taken from them. `parseToolCalls` never selects a block that ends in the
  history `historyLength` covers, so a stray closer in the live text cannot
  re-run an earlier turn's call.
