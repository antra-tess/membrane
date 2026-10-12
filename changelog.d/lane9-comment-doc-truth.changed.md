- Corrected three stale API-law claims in code comments against live provider
  behaviour measured 2026-08-25. `ToolContext.roundContent` no longer claims
  that a signed thinking block after its `tool_use` makes "the next request
  fail API validation" — claude-sonnet-4-6 accepted exactly that replay
  (HTTP 200); provider order is a content-correctness rule, and the doc now
  says so. The continuation builders no longer claim the API rejects extended
  thinking combined with an assistant prefill — claude-haiku-4-5 accepted the
  combination (HTTP 200); the parameter is still dropped, because prefill
  builds carry thinking as literal `<thinking>` text and refusing models
  exist. No behaviour changed with these.
- `src/providers/openai-responses.ts` now opens with a DO-NOT-CONFUSE note:
  it is the **Images** API adapter, and the real Responses-API surfaces are
  `src/formatters/openai-responses.ts` and
  `src/providers/openai-responses-api.ts`. The rename stays deferred; the
  note records why and which name a given branch is reading.
