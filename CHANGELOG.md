# Changelog

Notable changes to `@animalabs/membrane`, loosely following
[Keep a Changelog](https://keepachangelog.com/). Entries land with the change
that causes them, as fragment files in [`changelog.d/`](changelog.d/) that are
folded into a version section at release time — see
[CONTRIBUTING.md](CONTRIBUTING.md#changelog).

Releases up to and including 0.5.75 predate this file; for their contents see
`git log` and the
[releases page](https://github.com/antra-tess/membrane/releases).

## Unreleased

## 0.5.82 — 2026-09-05

### Added

- Add caller-owned prompt-cache marker mode with fail-closed four-breakpoint validation and exact post-format cache-wire receipts; preserve all four markers through native, XML, and Bedrock request paths.

### Changed

- `dynamicHeaders` receives `{ lane: 'stream' | 'complete' }` so a host can
  withhold turn-describing stamps from background calls; zero-argument
  callbacks keep working, `DynamicHeadersContext` is exported (#67).

## 0.5.81 — 2026-09-01

### Breaking

- **Context module callers:** `processContext` now throws
  `MembraneContextIdentityError` when any message lacks `metadata.sourceId`,
  instead of inventing a random id per call. **Who needs to act:** any caller of
  `processContext` (or of the exported helpers) whose messages do not carry a
  stable source id. **Migration:** populate `metadata.sourceId` with the
  originating system's message id (Discord message id, UI message id) — the
  error names the offending message indices. **Unchanged:** callers that already
  set `sourceId`, and everything outside `src/context/` — this module is opt-in
  and no membrane request path calls it. Without stable ids the module's
  continuity check saw 0% overlap on every call and reset the state, so the roll
  threshold never accumulated, cache markers never stayed stable and
  `cachedStartMessageId` was meaningless; the failure was silent.

- **Callers passing `onToolCalls` with `streaming: false`:** `stream()` now
  throws a typed `unsupported` error instead of silently returning after one
  provider call. The non-streaming fallback routes to `complete()`, which has
  no tool loop, so the handler was accepted, dropped and never called — the
  raw `<function_calls>` XML was returned as text and the turn ended. Leave
  streaming enabled, or drive the rounds yourself with `complete()`.

### Added

- `AnthropicAdapterConfig.dynamicHeaders`: an optional callback evaluated at
  request time and merged over the per-request beta headers of the outgoing
  call — for values that change between calls (e.g. gateway telemetry
  stamps). Cache-keepalive replays deliberately resend their recorded
  pre-merge headers, so a stale stamp is never replayed (#65).

### Changed

- **Types:** `DiscardedAttemptsUsage` no longer extends `DetailedUsage`, so
  the discarded-spend record no longer claims to carry discarded spend of its
  own, arbitrarily nested — a shape nothing ever produced. It extends the new
  exported `CallUsage` instead (the token and cost fields shared by both), and
  every field it actually reports is unchanged.

### Fixed

- `Membrane.stream()` on the native-tools path (`streamWithNativeTools`) now tags every `onChunk`
  with the block type the provider is streaming (`thinking` / `text` /
  `tool_call`, with `visible` false for thinking) and emits `block_start` /
  `block_complete` through `onBlock`, mirroring the yielding-path fix from
  #19 (#20). Previously `meta.type` was hardcoded to `'text'` on every chunk
  and `onBlock` was never invoked from that path, so a caller wiring it to
  a UI saw thinking deltas as visible text. The deprecated
  `onContentBlockUpdate` pass-through is unchanged. Both native paths now share one
  block tracker, and a block whose provider reports it only once, already
  finalised (OpenAI Responses), is completed when the stream returns instead of
  being left as a dangling `block_start`.

- An abort landing during the overloaded (529) backoff sleep is now handled
  like every other cancellation: `stream()` returns an `AbortedResponse` (as
  its docstring promises) and `complete()` rejects with a `MembraneError`,
  instead of a raw `AbortError` escaping the retry loop. Whether a
  cancellation was a return value or a throw used to depend on which
  millisecond it landed in.
- Aborted results now report why they aborted instead of always claiming
  `reason: 'user'`. A caller signal that fired is still `'user'`; an
  adapter-side request timeout reports `'timeout'`, and anything else that
  reached the abort path reports `'error'`.

- One formatter is now selected per request and used by every part of it. The
  Responses transport keeps a configured `OpenAIResponsesFormatter`
  authoritative over a per-request `options.formatter` override, but that rule
  lived inside request building alone: tool-mode resolution and the stream
  parser read the override instead, so an override against the Responses
  adapter built a Responses-item request and then ran the XML tool loop over it
  — one provider call, no `onToolCalls`, `stopReason: 'tool_use'` dropped on the
  floor. `Membrane.resolveActiveFormatter` now makes that selection once per
  call and threads the instance to mode resolution, request building, the tool
  loop and the stream parser.
- The native tool loop builds with the per-request formatter override.
  `buildNativeToolRequest` read the instance formatter while resolution had
  already honored the override, so `stream()` with an
  `options.formatter` of `OpenAIResponsesFormatter` selected the native loop and
  then built Anthropic-style envelopes through the legacy path instead of
  Responses input items.
- `streamYielding()` resolves its tool mode through the same selection rather
  than calling the resolver with no formatter at all.

- Fixed: the streaming paths reported `details.model.actual` as the model that was REQUESTED, under a `// TODO: get from response`, discarding the resolved model the adapter already handed them — `complete()` had this right. Requesting `gpt-4o-mini` on 2026-08-25 was served by `gpt-4o-mini-2024-07-18`, and on OpenRouter `actual` is the routed provider's model, so the fabricated value hid real routing. The openai and openrouter adapters now capture the served model off their SSE chunks (anthropic and gemini already reported it).
- Fixed: pricing was always resolved from the requested model id, so an alias or an auto-routed request priced against a string the provider had replaced. `resolvePricing` now resolves on two axes, source outranking specificity: `registry[served]`, then `registry[requested]`, then `builtin[served]`, then `builtin[requested]`. Preferring the served model still breaks ties, but only WITHIN one source — the first cut merged the two per-model (`registry[served] ?? builtin[served]`, returning on the first hit), so membrane's shipped guess for a snapshot outranked the caller's own registry entry for the alias they asked for, and a caller pricing `gpt-4o-…` at their negotiated rate while letting the provider pick the snapshot was billed at membrane's number instead of theirs. Both fallbacks stay, for a model absent from a source and for a provider that names none. On the streaming paths pricing is re-resolved once the provider names what it served, and each round of a multi-round turn resolves through this same function, so every `details.model.perRound` row obeys the precedence on its own served model.

- Cache-marker accounting is now ONE recount of the built wire request
  (`countWireCacheMarkers`), taken at each moment that spends the budget,
  instead of per-site running tallies that could not see each other:
  - the tools/system fallback is gated on that recount, so caller-marked
    `system` blocks (an explicitly supported input) suppress the fallback
    instead of stacking on top of it. Three caller markers plus both
    fallbacks previously put five `cache_control` blocks on the wire — a
    non-retryable 400 on every inference of that configuration.
  - a final clamp runs at the last exit before every adapter call (both the
    `complete()` and the streaming funnel), where every contribution is
    visible at once — builder, formatter, stale block-level passthrough from
    imported histories, the floating tool-loop marker, and any `beforeRequest`
    hook. Over-budget requests keep the 4 DEEPEST markers (each subsumes the
    shallower prefixes) and drop the rest with a warning naming the overspend,
    rather than being rejected outright.
  - the same clamp is the runtime assertion that no `cache_control` ever rides
    a `thinking` / `redacted_thinking` block, which the API rejects. The rule
    previously lived only in each builder's `lastCacheableBlockIndex` call.
  - that recount now finds markers NESTED inside a block's own content array,
    not only top-level blocks. `tool_result.content` is typed
    `string | ContentBlock[]` and reaches the wire verbatim, so four top-level
    markers plus one inside a tool_result counted as four and shipped as five
    — rejected outright with the belt's blessing. Discovery recurses into any
    array-valued `content`, capped at 4 levels (the cap is also what makes the
    walk total on a caller-built structure that points back at itself), and
    the strip walks the same traversal, so a marker the count can see is
    always one the clamp can drop. Document order still governs which markers
    survive, wherever they sit.
- The floating cache marker now stands down for EVERY normalizer repair that
  rewrites prefix bytes, not only the synthetic `[pending]` tool_result: a
  textified orphan `tool_result` is rewritten the same way when its pairing
  arrives. The kinds live in one exported set
  (`PREFIX_REWRITING_NORMALIZE_EVENT_KINDS`) so a new repair cannot silently
  escape the guard.
- The float's budget warning is rate-limited (first occurrence, then at most
  once a minute, carrying the suppressed count) instead of latching once per
  Membrane instance forever — the only observable of an over-budget wire used
  to go quiet for the life of the process.
- Live receipts (claude-haiku-4-5-20251001, 2026-08-25): 5 markers → 400 "A
  maximum of 4 blocks with cache_control may be provided. Found 5."; the same
  request post-clamp with 4 markers → 200. A marker on a thinking block → 400
  "thinking.cache_control: Extra inputs are not permitted"; post-clamp that
  rejection is gone.

- The wire-boundary cache clamp can no longer reach back into the caller's own
  request. `request.system` accepts caller-marked blocks and the builders passed
  that array through by reference when they added no marker of their own, so an
  in-place strip at the wire would have deleted a long-lived caller's breakpoints
  permanently. Every build exit (native builder, `transformRequest`, both
  continuation builders) now copies the system array and its blocks, so
  the clamp's mutations stay inside the request it is clamping. The copy
  descends into nested `content` arrays to the same depth marker discovery
  walks — a shallow copy would have left the caller's nested blocks shared,
  moving the leak one level down instead of closing it.

- **Context module:** cache markers now reach the wire. `applyCacheMarkers` sets
  `cacheBreakpoint` — the field every request builder reads — in addition to the
  existing `metadata.cacheControl`, which has no reader inside membrane. Until
  now the whole placement engine computed a result that was discarded at the
  formatter boundary, `messageBreakpoints` stayed 0 so membrane fell back to
  caching system+tools only, and `ContextInfo.cachedTokens` reported a cached
  prefix that did not exist.
- **Context module:** markers placed by the module are capped at 3 regardless of
  `cache.points`, keeping one of Anthropic's four `cache_control` slots free for
  the request builders' own spends (the XML formatter's system block, the
  floating tool-loop marker), which nothing reconciles against `cache.points`.
  The cap binds the stability path too: markers carried over from prior state
  are clamped to the deepest 3, so a state written before the cap existed does
  not keep re-spending four slots on every later call.

- **Context module:** `shouldRoll` now compares the configured threshold against
  the measured window (`messageCount` / `totalTokens`) rather than against
  `state.messagesSinceRoll` / `state.tokensSinceRoll`. Those counters increment
  once per call and re-add the whole window per call respectively, so a
  threshold of 50 messages meant "roll on the 50th call" and a stable window
  crossed a token threshold purely by being sent repeatedly. Both counters
  remain as telemetry.
- **Context module:** the `limits.maxCharacters` hard limit is enforced by
  truncation instead of being announced and ignored. The character limit now
  supplies its own truncation target (drop from the front until the window fits)
  and is re-asserted afterwards; a breach that cannot be truncated away is
  reported through `ContextInfo.residualOverflow`.
- **Context module:** a roll that dropped nothing is no longer reported as a roll.
  `ContextInfo.didRoll` is true only when messages were actually dropped, so the
  roll counters stop resetting on every call while a conversation sits over a
  hard limit — which is exactly when threshold rolling is needed.

- **Context module:** rolling truncation no longer strands a `tool_result` whose
  `tool_use` it dropped. The chosen start index moves forward to the next clean
  tool-cycle boundary; when no clean boundary exists at or after it — the
  requested window would keep only the tail of a cycle — the cut walks back to
  the call that opens that cycle and keeps it whole. Previously the default XML
  formatter shipped the orphan verbatim (silent transcript corruption) and the
  OpenAI Responses builder emitted a wire-invalid `function_call_output`.
- **Context module:** truncation can no longer return an empty `messages` array.
  A window whose newest message alone exceeds the target keeps that message (or
  the whole tool cycle it belongs to), and the overshoot is reported through the
  new `ContextInfo.residualOverflow` (`{ unit, limit, actual }`) instead of
  shipping a message list every provider rejects.

- **Context module:** `cache.preferUserMessages` consults the deployment's own
  assistant name via the new `ContextConfig.assistantParticipant` instead of the
  hardcoded `claude`/`assistant`/`bot`/`ai` list. A deployment whose assistant is
  named anything else had every assistant turn classified as a user turn, so the
  adjustment was a no-op that could leave the marker on an assistant turn. With
  no `assistantParticipant` configured the legacy names still apply.
- **Context module:** `processContext` carries every field of the caller's
  `ContextConfig` through its internal default-merge instead of re-listing the
  survivors, so `assistantParticipant` (and any field added later) reaches the
  placement engine on the end-to-end path rather than only via the exported
  helpers.
- **Context module:** `processContext` no longer throws `TypeError` on messages
  that carry no `participant` (role-shaped producers). The user-turn heuristic
  treats a missing participant as a user turn, which is its own fallback intent.

- Fixed: `toAnthropicContent` had no `default` case, so a content block it did not recognise was dropped on the way to the provider — the model then answered about a message missing content the caller had supplied, with no signal anywhere. `audio`, `video` and unknown block types now throw the (previously exported but unused) `unsupportedError` instead. A dropped request block is unrecoverable, which is why this path fails loudly rather than degrading.
- Fixed: `generated_image` blocks were among those silently dropped; they are now carried across as Anthropic `image` blocks, so an image Gemini produced can re-enter Anthropic history rather than disappearing at the switch.
- Fixed: `document` blocks dropped their `filename`; it is now sent as Anthropic's `title`.
- Fixed: `fromAnthropicContent` and `parseProviderContent` silently discarded provider block types they could not normalize (`server_tool_use`, `web_search_tool_result`, `search_result`, `mcp_tool_use`, and anything added later). They are now preserved verbatim as `rawItem` carriers — recoverable, replayable by the formatters — with a one-time warning per block type naming what is not visible to normalized consumers.

- Refusal retries no longer hide the spend they discard. A re-issued attempt
  is a completed, billed provider call, and only the surviving attempt's
  usage was ever reported. `details.usage.discardedAttempts` now sums the
  abandoned attempts (count, tokens, cache tokens and estimated cost) on
  `complete()` and on the native yielding stream; the response's own `usage`
  still describes the attempt that stands.

- Gemini: `usageMetadata.thoughtsTokenCount` is now read and folded into `usage.outputTokens`, and surfaced separately as `usage.thinkingTokens` — the field `DetailedUsage` already declared for this quantity, now populated for the first time and threaded through every streaming accumulator rather than dropped there. Thinking tokens are disjoint from `candidatesTokenCount` and billed at the output rate, so thinking-model turns previously reported a small fraction of the tokens actually generated — live receipt (gemini-3.5-flash-lite, `thinkingBudget: 512`, 2026-08-25): prompt 35, candidates 2, thoughts 228, total 265, where membrane reported `outputTokens: 2` of 230 generated.
- Gemini: the adapter now checks `promptTokenCount + candidatesTokenCount + thoughtsTokenCount === totalTokenCount` and warns when it does not hold, so a future `usageMetadata` field carrying billed tokens surfaces instead of vanishing.
- Gemini streaming now reports the served model (`modelVersion` off the stream frames) as the response model rather than echoing the requested id.

- Streaming responses now report the provider calls a turn actually cost.
  Every streaming path passed a literal `attempts: 1`, so a stitched turn —
  tool rounds, automatic resumptions, refusal re-issues — was
  indistinguishable in durable logs from a single-shot one. `details.timing`
  also gains `rounds`, the number of continuation rounds, which is lower than
  `attempts` whenever a round was re-issued.

- Fixed: a multi-round turn was priced entirely at the LAST model that served it. Each tool/resumption round re-resolved pricing when the served model changed and then recomputed the whole accumulated usage at that newest rate, retroactively re-billing every earlier round — two 1M-token rounds served at 1,000/M then 10,000/M reported 20,000 against a real bill of 11,000. Each round is now priced under the model that served THAT round and the costs are summed. Mock-only: exercised against a scripted two-model adapter across all four tool loops, since reproducing a mid-turn model switch live needs an OpenRouter key.
- Added: `details.model.perRound` on the streaming paths — one entry per provider round, each naming the model that served it and carrying that round's own tokens and cost. It is the audit trail behind the summed `usage.estimatedCost`, which `details.model.actual` (the LAST served model) cannot supply on its own. Unset on `complete()`, which makes exactly one call.
- Changed: when any round of a turn has no known rates, the turn's `estimatedCost` is now omitted rather than reported as the sum of only the priced rounds — a partial sum presented as the total is a wrong number, while an absent cost already means "membrane does not know". The rounds that were priced stay readable in `details.model.perRound`.

- `details.cache.markersInRequest` on the native tool paths now counts the
  request that SHIPPED rather than the request the builder produced. The count
  was taken immediately after `buildNativeToolRequest`, before `streamOnce`
  applies the `beforeRequest` hook and before the wire clamp drops everything
  past the 4-breakpoint budget — so a hook that placed 7 markers on a wire that
  carried 4 was reported as 1. The number now comes from the clamp's own tally,
  the single point that sees every contribution.

- `details.cache.markersInRequest` now reports the real count on the native tool
  paths (`stream()` and `streamYielding()` with native tools), recounted from the
  request that was built. Both hardcoded `0` while placing markers of their own —
  including the floating tool-loop marker — which made the 4-breakpoint budget
  unauditable from response telemetry on exactly the paths that spend it hardest.

- The prefix-rewriting classification of normalizer events is now exhaustive
  and compiler-enforced: a `Record` over the whole `NormalizeEvent` union
  derives `PREFIX_REWRITING_NORMALIZE_EVENT_KINDS`, so adding a kind is a
  missing-property error until someone decides whether it rewrites prefix
  bytes. The previous `[...] satisfies Array<NormalizeEvent['kind']>` only
  checked that the LISTED kinds were real and accepted any subset — a new
  prefix-rewriting repair could join the union, never be listed, and silently
  escape the cache-placement gate while the comment beside it promised a
  compile error that did not exist.

- `openai-compatible` and `openai-completions` now request streamed usage
  (`stream_options.include_usage`) and report the token counts the server
  sent. Both adapters previously hardcoded `inputTokens: 0, outputTokens: 0`
  on every streamed call behind a comment claiming the data was unavailable —
  it is the same endpoint and wire format their `openai` and `openrouter`
  siblings already read usage from — which zeroed cost estimates, cache-hit
  ratios and any caller-side token budget. Zeros remain only as the
  genuinely-absent fallback for an endpoint that ignores `stream_options`.

- The prefill/thinking guard now strips the extended-thinking config from BOTH
  channels the adapter's resolver reads — the top-level `thinking` param and
  `extra.thinking` (spread from `providerParams`). Only the top-level field was
  deleted before, so a caller passing thinking through `providerParams` had it
  re-inserted by the adapter's `Object.assign(params, rest)` — sending thinking
  plus an assistant prefill (the 400 the guard exists to prevent) and turning on
  the interleaved-thinking beta header with it. Both continuation builders (plain
  and split-turn image) are covered, and the split-turn builder now copies
  `providerParams` instead of aliasing it, so the strip cannot leak back into the
  caller's own request object.
- Disclosure: the underlying API premise is model-dependent now. Measured live
  2026-08-25 against the Anthropic Messages API: `claude-haiku-4-5-20251001`
  accepts an assistant prefill AND accepts it together with
  `thinking: {type: 'enabled'}` (HTTP 200), while `claude-sonnet-4-6` refuses
  assistant prefill outright ("This model does not support assistant message
  prefill"). So the strip is no longer a bare 400-avoidance rule on
  haiku-class models: it is the prefill path's design — the XML formatter uses
  the thinking config to emit a literal `<thinking>` text prefix rather than
  the API feature, and sending both would pay for API thinking that the
  prefill format does not consume. On models that reject the combination it
  remains the 400 guard it always was; either way the two channels must agree.

- Fixed: three rows of the built-in pricing table were wrong when checked against the providers' published price pages on 2026-08-25. `claude-opus-4-6` was priced at the retired Opus 4 rate — 15/75 against a real 5/25, so every Opus 4.6 cost estimate was 3x too high. `claude-haiku-4-5` was priced at the retired Haiku 3.5 rate (0.80/4 against 1/5). `gemini-2.5-flash` was priced at 0.15/0.60 against a real 0.30/2.50, and with no `gemini-2.5-flash-lite` row the same entry also mispriced Flash-Lite at 3x input and 6x output.
- Removed: the `gpt-4o-2024` row, which was byte-identical to `gpt-4o` and so could never change an answer under longest-prefix matching. It is replaced by `gpt-4o-2024-05-13`, the one 4o snapshot that genuinely costs more (5/15) — a real difference the dead row was masking.
- Added: rows for the current model generations (Claude Fable 5 / Opus 5 / Sonnet 5 / Opus 4.5-4.8 / Sonnet 4.5, the GPT-5 family, Gemini 3.5 Flash and Flash-Lite), each carrying the date it was read off the vendor's price page.
- Added: `ModelPricing.asOf`, a PER-ROW verification date on every built-in pricing row, surfaced to callers as `CostBreakdown.pricingAsOf` and replacing a prose header that claimed "Last updated: 2025-07" for the whole table while it carried Claude 4.6 rows. Rows for currently-published models carry the new `DEFAULT_PRICING_LAST_VERIFIED` — the date the sweep read them off the vendor's page. A row for a RETIRED model carries the date its rate was last published instead: `claude-3-5-sonnet` is dated 2025-07-01 because it is no longer listed anywhere to verify against, and stamping it with the sweep date would claim a check that cannot be performed. Registry pricing that records no date leaves `pricingAsOf` unset rather than borrowing one.
- Fixed: an unpriced model is now distinguishable from a free one. `estimateCost` still omits `estimatedCost` when no rates are known, but warns once per model saying so explicitly — previously a caller seeing no cost could not tell "membrane has no rates for this" from "this cost nothing".

- Split-turn image injection now persists into the turn's message list, so
  every continuation after an image-bearing tool result keeps the image user
  turn on the wire. Previously the split existed on exactly one request and
  the next continuation flattened the accumulated document back over it,
  leaving `<function_results>` XML asserting a screenshot the model could no
  longer see.
- Both continuation builders now send the same `extra` contract as the
  initial request (`normalizedMessages` plus the pre-serialized `prompt`).
  The image builder previously sent neither, dropping completions-style
  adapters onto provider-shaped messages and re-adding participant stop
  sequences the continuation deliberately suppresses.

- Mid-stream SSE `error` frames inside an HTTP 200 now throw on every SSE
  adapter (`openai`, `openai-compatible`, `openai-completions`, `gemini`)
  instead of being dropped. Previously such a frame matched no
  `choices`/`candidates` branch, was swallowed by the loop's parse-error
  catch, and the adapter built a well-formed success from the content that had
  arrived so far — `end_turn`, `wasTruncated: false`, zero usage — which a
  caller cannot distinguish from the model choosing to stop, and which
  persists as a silently truncated turn. The check is the one `openrouter`
  already carried (see `tests/unit/openrouter-stream-error.test.ts`, whose
  header names the fake-successful-empty-completion failure) and which
  `openai-responses-api` states in its own comment; both now share a single
  `throwOnStreamErrorFrame` helper with the four adapters the fix never
  reached.
- A mid-stream `error` frame now keeps the classification the provider gave
  it. `throwOnStreamErrorFrame` threw a bare `Error`, leaving the frame's
  `code`/`type`/`status` as prose that each adapter's `handleError` then
  re-derived a category from by substring match — so a 429 arriving as
  `status: 429`, with no literal "429" in the message, normalized to
  `unknown, retryable: false` and suppressed the retry the provider had
  explicitly asked for. The helper now classifies from the structured fields
  before throwing: 429 or a rate-limit-shaped token becomes a retryable rate
  limit carrying the frame's retry hint (`retry_after`, `retryAfterMs`,
  `retryDelay`), 5xx or an overloaded-shaped token becomes a retryable server
  error (overloaded-without-a-status takes 529, so it lands on the capacity
  backoff schedule), and 401/403 or an auth-shaped token becomes a
  non-retryable auth error. Unrecognized frames still throw the previous bare
  `Error`, now with `code` and `type` preserved in the message. The provider's
  own message text is never dropped, and the raw frame and request ride along
  on the classified error.
- The Responses API adapter's own two error-frame throw sites (`response.failed`
  and the `error` event) route through that same classification. They dispatch
  on `event.type` rather than running the shared SSE line loop, so they had
  their own structureless throws: a frame whose code did not happen to contain
  a substring the adapter's `handleError` matches — `overloaded_error`,
  `too_many_requests`, `permission_denied` — normalized to unknown and
  non-retryable. The token lists now have a single source of truth.
- A Responses API terminal response carrying a structured `error` object on an
  HTTP 200 is classified the same way, from both paths that reach it: the
  stream's terminal frame (`response.completed`/`response.incomplete`) and a
  non-streaming response body. A 200 carrying an error object never reaches an
  HTTP-status classifier, so these had no other route to a category. The
  non-streaming failure is no longer described as a stream error.

- Streaming adapters now require a terminal event before reporting success:
  `openai`, `openai-compatible`, `openai-completions`, `openrouter`, `gemini`,
  `anthropic` and `bedrock` throw a retryable `network` failure
  (`stream ended before a terminal event`) when the stream reaches EOF with no
  `finish_reason` / `[DONE]` / `finishReason` / `message_delta`. Previously the
  terminal signal was an initialised default rather than an observation, so a
  graceful mid-stream close (proxy or LB idle timeout, early FIN, a gateway
  truncating the body) surfaced as `end_turn` over partial content — with a
  `raw.finish_reason: 'stop'` on the OpenAI family that never came off the
  wire. `openai-responses-api` already refused this; Bedrock's guard caught
  only the fully-empty case, so a stream truncated after any content passed.
  A final event that arrives with no trailing newline still counts as
  observed: every OpenAI-family loop drains its SSE line parser's buffer at
  EOF through the same frame handler, as `gemini` and `openai-responses-api`
  already did.
- Adapter `handleError` now returns an already-classified `MembraneError`
  unchanged (`openai`, `openai-compatible`, `openai-completions`,
  `openrouter`, `anthropic`, `bedrock`; `gemini` and `openai-responses-api`
  already did), instead of re-deriving its type by substring over the rendered
  message and downgrading it to non-retryable `unknown`.

- `stream()` now forwards `timeoutMs` to the provider on both the XML and
  native tool paths — it was declared, documented and adapter-honoured, but
  dropped at exactly the call sites where a wedged connection hangs the turn.
  `StreamOptions.idleTimeoutMs` is added for parity with the yielding path
  and forwarded the same way.

- Thinking signatures now pair with parser-derived thinking blocks by CONTENT
  IDENTITY instead of stream position. Index-zipping crossed the two lists
  whenever their shapes differed — a signature-only (`display: 'omitted'`)
  block beside a visible one stamped the omitted block's signature onto the
  visible text and re-prepended the real carrier as a second copy, and the XML
  path's visible `<thinking>` text could adopt a native signature outright. A
  mispaired carrier round-trips into stored history and fails Anthropic's
  signature validation on the next turn.
- Continuation splits are reconstructed rather than mis-signed: when a parsed
  thinking block is the concatenation of a run of consecutive provider blocks
  (a `<thinking>` block split across a `max_tokens` boundary, where capture
  runs per round but the parser sees the whole accumulation), the spanning
  block is REPLACED in place by the provider originals, each keeping its own
  signature. A span that does not reconstruct leaves the parsed block
  unsigned and prepends the originals instead of guessing.
- Signature-only thinking blocks are never text-match candidates (prepend
  only), and leftover carriers are de-duplicated against what the content
  already holds, so a merge can no longer emit two copies of one block.

- Thinking-text identity no longer erases internal whitespace, so two distinct
  signed payloads that differ only in where their spaces fall (`zz-ab c` vs
  `zz-a bc`) stay distinct and the wrong signature is no longer stamped onto
  the wrong reasoning. Normalization is now exactly the two named artifacts:
  the XML path's `<thinking>` scaffolding tags, and whitespace at the OUTER
  boundaries. A mis-stamped carrier round-trips into stored history and fails
  Anthropic's signature validation on the next turn.
- Continuation splits still reconstruct across the round boundary that loses a
  fragment's trailing whitespace: the spanning search now tries both the
  verbatim join and the join `buildContinuationRequest`'s trimEnd actually
  produces, instead of relying on blanket whitespace erasure.

- A request cancelled by an adapter's own `timeoutMs` deadline now reports
  itself as a timeout all the way out. Every `fetch`-based adapter (OpenAI,
  OpenAI-compatible, OpenAI Completions, both OpenAI Responses adapters,
  OpenRouter, Gemini, Bedrock) caught the deadline's `AbortError` and replaced
  it with a generic abort, so `stream()` handed back `reason: 'error'` where
  `reason: 'timeout'` was documented, and `complete()` rejected with
  `type: 'abort'` and the message "Request was aborted". The deadline now
  marks the abort reason it raises, and the adapters map that marked abort to
  a non-retryable `type: 'timeout'` error (`TimeoutAbortError`, exported)
  which the streaming paths still treat as a cancellation — partial content,
  tool calls and tool results are reported exactly as before.
- A caller's own cancellation is unaffected: it still reports `reason: 'user'`
  whenever the caller's signal fired, including when it beats a deadline that
  was also armed.

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

- Membrane now reports two previously silent XML tool-parse failures at turn end. A turn that ends with a tool block still open — the shape a `max_tokens` stop leaves, since the loop does not resume on a length stop — sets `details.stop.unclosedToolBlock` and logs a warning, so a consumer no longer persists a live-looking half-block that the next round's closing tag can splice onto. A `<function_calls>` block that parses to zero invokes also logs: nothing executed, the call was returned as assistant prose, and the turn closed on top of it with no signal at all.
- `hasUnclosedToolBlock` / `endsWithPartialToolBlock` were exported with no call site anywhere in the source tree; they are now the guards behind that flag.

- XML tool parser: a `<function_calls>` block quoted inside a `<thinking>` block or echoed back inside a `<function_results>` block is no longer dispatched. `parseToolCalls` — the path membrane executes from — selected the last unexecuted block out of a raw regex sweep with no containment check at all, so a model that named a tool and explicitly declined to use it had that call run anyway, and a tool result that quoted a call re-ran it. Both parse entry points now read the document through one span census and one containment rule, so the dispatch path and the block path cannot disagree about which blocks are real.
- Containment now refuses a call span that CROSSES out of its container, not merely one fully inside it. A `<function_calls>` opener quoted inside a `<thinking>` block or a tool result, whose closing tag lands after the container closes, was retained alongside its container: the quoted call dispatched, and the overlapping source text rendered twice — once as container content, once as a real `tool_use`. Retained spans never overlap; a dangling closer left downstream reads as ordinary text, which is what it is.
- Known bound: containment can only see a container that is CLOSED. On membrane's streaming stop-sequence path the accumulated text is cut at `</function_calls>`, so an enclosing `<thinking>` has no closing tag yet and a quoted call still dispatches there; the complete-document paths are covered.

- XML tool parser: a `<function_calls>` or `<function_results>` block quoted inside a `<thinking>` block no longer produces a phantom duplicate. Three independent regex sweeps recorded overlapping spans with no containment check, so the same source text was emitted twice — once as thinking content and once as a real `tool_use` in the response's `toolCalls` — and the text-gap walk, already past the inner span, rendered the container's own `</thinking>` tag as visible model text. Spans fully inside a retained span are dropped, and the gap cursor is clamped monotonically.

- XML tool parser: a `<function_calls>` block counts as already executed only when the next non-whitespace token after it is a `<function_results>` opener. The previous 100-character lookahead was wrong in both directions — padding past 100 characters could re-select a block that had already run, and a results block from a later exchange could mark a live call as spent. In membrane's own loop the first direction was masked by last-block selection; the mechanism is fixed regardless.

- XML tool parser: `<invoke>` tags are now recognised with single-quoted names and with whitespace before the closing angle bracket. Previously only one spelling (`name="…">`, no space) parsed, and any other spelling yielded a `<function_calls>` block with zero calls — the call became silent assistant prose and the turn ended.
- XML tool parser: a block that mixes self-closing and full `<invoke>` tags now yields its calls in document order. Two sequential regex passes previously emitted every full invoke before every self-closing one.
- XML tool parser: an `<invoke>` tag with an empty name is refused rather than dispatched as a call with an empty tool name; it reports through the zero-invoke diagnostic instead.

- Membrane logs a warning when a tool block had to be re-anchored past a second `<function_calls>` opener. The repair is silent by construction; the warning is how an operator learns that a truncated block is sitting in a stored conversation's assistant text, where it will keep being repaired on every later compile.

- XML tool parser: a `<function_calls>` match whose inner content holds another `<function_calls>` opener is no longer read as one block. Previously a max_tokens-truncated block left in the persisted turn spliced onto the NEXT round's closing tag, and the stale `<invoke>` paired with the new round's `</invoke>` — dispatching a call bearing the STALE tool's name with everything in between, intervening user text included, as its argument, while the real call never parsed and never ran. No dispatch now crosses an opener; the span is re-anchored to the innermost opener so the real call still runs and the truncated half falls out as ordinary preceding text.
- The same rule now holds one level down, for `<invoke>`. An invoke left OPEN paired with the NEXT invoke's `</invoke>` — the lazy full-form match — so the head dispatched carrying the inner call's parameters as its own while the inner call never parsed. A match whose body holds another invoke opener is refused and re-anchored to the innermost opener, so the swallowed call runs with its own parameters, and the refused heads are counted for the turn-end warning rather than dropped in silence.

- A streamed Anthropic tool call whose arguments never assembled into valid
  JSON no longer persists as a plausible empty-argument call. Two limbs: the
  accumulator's `catch { /* partial JSON */ }` discarded an unparseable
  accumulation, and a `max_tokens` truncation of a tool call sends NO
  `content_block_stop` at all (measured live against `claude-haiku-4-5`,
  2026-08-25), so every `input_json_delta` fragment was dropped on the floor
  and the block kept the `input: {}` that `content_block_start` carried —
  indistinguishable from a genuine no-arg call once written to history and
  re-shipped on the next compile. A block left open when the turn ends is now
  finalized (its accumulated text is no longer lost either), the raw argument
  text stays on the block as the typed `ToolUseContent.unparseableInput` —
  whose presence means `input` is not the model's arguments — and membrane's
  `parseProviderContent` surfaces it to the caller.

- `usage.inputTokens` now carries ONE convention across every adapter: cache-excluded, meaning `inputTokens`, `cacheReadTokens` and `cacheCreationTokens` are disjoint and each is priced at its own rate (total prompt size stays recoverable as `inputTokens + cacheReadTokens`). Adapters declare which convention their wire payload uses via the new `ProviderAdapter.usageCacheConvention`, and membrane normalizes at the single point provider usage enters. The field is OPTIONAL and defaults to `unknown`, so an existing custom adapter keeps compiling and simply gets the undeclared behaviour described below — silence about a convention is exactly what `unknown` means, and it is reported as such rather than guessed at. Per-adapter, verified live 2026-08-25: **anthropic** and **bedrock** cache-excluded (`input_tokens` 8 alongside `cache_read_input_tokens` 4650); **openai** and **openai-responses-api** cache-inclusive (`prompt_tokens` constant at 1732 across a hit reporting `cached_tokens` 1664); **openrouter** declares the convention per response because it fronts both, keyed on which field the routed provider sent; **gemini**, **openai-compatible** and **openai-completions** declare `unknown` (see below).
- Fixed: `details.cache.hitRatio` was `cacheReadTokens / inputTokens`, which is not a ratio under the cache-excluded convention — 120 fresh input against 48,000 cache-read tokens reported a "hit ratio" of 400. It is now `cacheRead / (cacheRead + freshInput)`, bounded by 1 on every adapter.
- Fixed: cost arithmetic double-charged the cached span on cache-inclusive adapters, pricing the whole prompt at the full rate AND the cached subset again at the discounted rate. Fresh input is now `prompt - cached`.
- Fixed: `complete()` narrowed its top-level `response.usage` to input/output tokens only, dropping the cache and cost fields that its own `details.usage` and every streaming path carried, despite the field being typed `DetailedUsage`.
- An adapter that declares `unknown` has its counts passed through unchanged and warns once — the first time it reports a cache read, since that is when the ambiguity affects a number. Gemini is `unknown` deliberately: no cache hit could be produced to measure on 2026-08-25 (implicit caching did not trigger across three identical 10,893-token calls, and explicit `cachedContents` is refused on the free tier).

- `AnthropicXmlFormatter` (the prefill path) now has a breakpoint budget. It
  attaches `cache_control` at five sites — system, contextPrefix, hasCacheMarker
  flush, cacheBreakpoint flush and the CLI-simulation system block — and
  compared the total to nothing, so a prefill turn with three marked messages
  put five markers on the wire and the API rejected the whole request. The
  finished artifacts are clamped once, keeping the 4 deepest markers, and the
  reported `cacheMarkersApplied` is that same recount rather than a running
  tally that could drift from the wire.
- A caller-supplied system ARRAY keeps its blocks and their per-block
  `cache_control` through the XML formatter instead of being flattened into one
  text block with every caller marker discarded. When the caller marked nothing,
  the formatter marks the last block (once) as before; when the caller marked
  anything, its allocation is authoritative and the formatter adds nothing.
  System-mode tool injection appends to the last block, so the earlier blocks'
  markers survive it.

- The yielding stream's iterator now implements `return()`/`throw()`, so
  breaking out of `for await` cancels the producer instead of leaving it
  streaming, auto-resuming and re-sending full context to a consumer that
  left (measured: 25 provider calls after the break, now 1).
- A departed consumer's queued events are dropped rather than accumulated
  without bound, and the stream removes its abort listener from the caller's
  signal at terminal — a long-lived shared signal no longer collects one
  closure per stream.

- `streamYielding()`'s iterator no longer swallows an error thrown into it.
  `iterator.throw(e)` cancelled the producer (correctly) and then reported
  `done: true`, so `e` vanished: a generator delegating with `yield*` resumed
  after the delegation as if nothing had been thrown in, and a direct
  `.throw(e)` resolved instead of rejecting. It now departs the consumer and
  rethrows `e`, like an async generator with no handler of its own.

## 0.5.80 — 2026-08-25

### Added

- **Floating cache marker: incremental prompt caching inside the native tool
  loop** (`NormalizedRequest.floatingCacheMarker` /
  `MembraneConfig.defaultFloatingCacheMarker`, on by default). Context
  strategies place cache breakpoints once per turn at compile time, but the
  native tool loop rebuilds the request on every tool round with that round's
  messages appended — so the deepest upstream marker stayed glued to the
  turn-start snapshot and every rebuild re-paid the whole growing suffix at
  full input price. A 30-round tool turn re-sent a suffix growing to ~118k
  tokens on every round (field incident 2026-08-20: ~5.3M uncached input
  tokens in 18 minutes across two agents whose single marker sat on message 2
  of 61). The tool loop only appends, so on each rebuild membrane now floats a
  `cache_control` marker onto the last cacheable block of the newest message:
  each round writes only its delta and cache-reads everything before it.
  - **Residual-budget only — upstream markers are never displaced or
    stripped.** Anthropic allows 4 `cache_control` slots; the float spends
    only what upstream markers (message breakpoints, stale block-level
    passthroughs, the tools/system fallback) left free, and is withheld with
    a one-time warning when they fill all 4. With 2+ free slots the previous
    round's endpoint stays marked too, so a wide parallel-tool round
    (appending more blocks than the provider's ~20-block backward search)
    can't orphan the previous round's cache entry.
  - Applies only to tool-loop rebuilds — the turn's first request remains
    byte-for-byte the context strategy's artifact. Skipped for a round whose
    request contains a synthesized `[pending]` tool_result (those bytes are
    rewritten when the real result lands, and caching past them poisons the
    prefix — same rationale as the normalizer's cache suppression).
  - Set `floatingCacheMarker: false` for context strategies whose request
    prefix churns between rounds, where a trailing marker is pure
    cache-write cost.
  - Complements the cache keepalive below: the keepalive addresses idle-gap
    expiry of the last written entry; this addresses the mid-session churn
    its sizing analysis explicitly left out.

- **Prompt-cache keepalive for the Anthropic 1h cache** (`AnthropicAdapterConfig.cacheKeepalive`,
  on by default; `{ enabled: false }` to opt out). An idle agent's cached prefix
  expires on its TTL and the next wake pays a 2x cache **write** over the whole
  context — but reading an entry restarts its clock, so replaying the last
  request with `max_tokens: 0` refreshes it at cache-**read** price (0.1x).
  - **Idle-gated, not a blind interval.** A poke fires only when the entry is
    actually near expiry, so an agent whose own traffic keeps the cache warm
    never fires one, and cost scales with real idleness rather than with the
    keepalive window. Measured on mythos llm-calls over 36h: 563 of 637 gaps
    were under 5 minutes and only 5 exceeded 1h — a blind timer there would be
    near-pure waste.
  - **The replay is byte-identical above the last breakpoint.** Only
    `max_tokens` (not part of the cache key) and `stream` (transport) differ.
    Request shapes that cannot tolerate `max_tokens: 0` — legacy
    `thinking.budget_tokens`, forced `tool_choice`, structured output, no 1h
    breakpoint — are **skipped**, never rewritten to fit: "normalizing" the
    request moves the invalidation boundary and silently converts a 0.1x read
    into a 2x write.
  - **Every poke is checked.** A refresh that reports `cache_creation > 0` or
    `cache_read == 0` has kept nothing alive; the lineage is dropped rather
    than repeatedly paying 2x. Consecutive send failures hard-disable the
    keepalive instead of becoming a retry loop.
  - Scope is the primary (`stream`) lane. The aux/compression lane emits no
    `cache_control` at all today, so it has no entry to keep alive.
  - Verified against the live Anthropic API (2026-08-22, `claude-opus-5`):
    a 5m entry poked every 4 min was still a pure read at t+12m (2.4x its
    nominal TTL, every poke `create=0`); `max_tokens: 0` replay returned
    `create=0 / read=7220` with zero output tokens; a non-streaming replay
    read a stream-written entry. The `thinking:{type:'disabled'}` mis-replay
    was confirmed to cost a full rewrite (`create=5081 / read=0`).
  - **Not verified:** only the direct Anthropic API was exercised, on
    `claude-opus-5` — not Bedrock (no 1h cache there; `cacheTtl` is stripped),
    not Vertex/Foundry, and not `claude-fable-5` or any other model. TTL
    sliding was demonstrated on the **5m** cache as a 12-minute proxy; the 1h
    cache was not held open for a multi-hour test. The unit tests use fake
    timers and a mocked send.

### Changed

- Changelog entries now land as per-change fragment files in `changelog.d/`
  (`<slug>.<breaking|added|changed|fixed>.md`), folded into the version
  section at release time — concurrent PRs no longer conflict in
  `CHANGELOG.md`. Editing `## Unreleased` directly still works and is merged
  at the same point.

### Fixed

- **Anthropic context-length heuristic is now gated on HTTP 400** (#17, #48).
  `AnthropicAdapter.handleError` classified any error whose message contained
  "context" or "too long" as non-retryable `context_length` regardless of
  status, so transient 5xx bodies like "Internal error: context processing
  failed" suppressed retries and failed permanently. Genuine prompt-too-long
  errors — including mid-stream SSE ones, whose status is recovered from the
  body's `invalid_request_error` type — still classify as `context_length`.

## 0.5.78 — 2026-08-06

### Added

- **`refusalRetries` — opt-in retry on provider refusals** (default `0`, so no
  existing consumer changes behavior). Near the content-policy threshold a
  refusal is probabilistic rather than a property of the payload: identical
  bytes pass and refuse minutes apart. Retrying at the provider seam is where
  the verdict actually lands, so every caller — main loop, compression, merges,
  subagents — benefits, and the replay is cache-warm, so only discarded output
  tokens are real spend.
  - `complete()` retries invisibly; nothing has reached the caller yet.
    Refusal retries are counted separately from the transport-error budget,
    since a refusal is a successful call with an unwanted verdict.
  - Streaming cannot retry silently, because a refusal can land after tokens
    have been emitted. A new `RetryingEvent` tells the consumer to discard
    everything the call has emitted so far, and membrane rolls its own
    accumulators back to the attempt boundary. `streamOnce` enables retries
    **only** when the caller passes an `onRetrying` hook, so a consumer that
    has not been updated cannot be corrupted by an option set upstream.
  - Native tool mode only. The XML path accumulates into a streaming parser
    carrying prefill context and resumption depths; a partial rollback there
    would corrupt turns rather than retry them, so it warns and stays off.

### Fixed

- `global.` cross-region inference-profile ids are recognized as already
  mapped. The already-in-Bedrock-format check used `/^[a-z]{2,4}\.anthropic\./`
  — written for `us.`/`eu.`/`apac.` — so a 6-character `global.` prefix fell
  through to the fallback and came out double-mangled
  (`apac.anthropic.global.anthropic.…-v1:0-v1:0`). On some gateway regions
  Sonnet 4.5 exists *only* under the `global.` profile.

## 0.5.77 — 2026-07-31

### Added

- **Bedrock `baseURL` endpoint override**, for pointing the adapter at an
  inference-gateway leg that discards the client SigV4 and re-signs with real
  credentials. Additive; default behavior unchanged.
- **`maxContinuationRounds`** (default 24, `-1` for unlimited on the yielding
  path) and **`maxResumptionRounds`**, bounding continuation and resumption
  rounds independently of `maxToolDepth`, plus two truthful stop reasons —
  `no_progress` and `round_limit`.

### Changed

- **Resumption guards no longer count tool rounds.** The yielding API's
  uncapped-by-default tool-loop contract is untouched; the guards apply solely
  to membrane-initiated false-positive stop-sequence resumptions. The stall
  guard now requires three *consecutive* short same-stop resumptions before
  ending the turn, and any progressing round resets the count — a chain that
  stalls twice and then completes is no longer truncated.
- `overloaded.maxRetries: 0` disables the dedicated 529 policy entirely, so
  capacity errors fall back to the base retry config exactly as they did
  before the policy existed, instead of being re-promoted to the long schedule
  by a positive base `maxRetries`.
- `stream()` pre-emission retries now consult `hooks.onError` with the same
  abort contract `complete()` honors, so host circuit-breakers work on the
  streaming path.
- On success-after-retry, `stream()` patches the real attempt count and actual
  backoff waits into the response, so durable logs stop reporting
  first-attempt success.

### Fixed

- **Prompt caching is usable on Bedrock at all** (Connectome #35). Two gaps
  kept it inert: `buildRequest` now strips the `ttl` field from
  `cache_control` markers on message blocks, system array blocks and tool
  entries — Bedrock runs its cache at a fixed default TTL and rejects the
  direct-API `ttl` extension as an extra input, so any caller setting
  `cacheTtl` 400'd on every marked request; and the stream parser now surfaces
  `cache_creation_input_tokens` / `cache_read_input_tokens` (reading
  `message_start`, treating `message_delta` as authoritative). Previously only
  `complete()` carried them, so streamed calls reported zero cache activity and
  downstream ledgers could never observe caching. The markers themselves are
  kept — caching works, at 5m.
- **Plain 4-era Claude ids route to Bedrock inference profiles.** Claude 4-era
  models reject on-demand invocation of the direct `anthropic.<id>-v1:0` form
  and require a cross-region profile; plain ids and the unlisted-id fallback
  now map to the profile form with the `us.`/`eu.`/`apac.` prefix derived from
  the adapter region. The `claude-haiku-4-5-20251001` alias also still pointed
  at 3.5 Haiku — a stand-in from before Haiku 4.5 reached Bedrock, and since
  EOL there — so every plain-id caller got a guaranteed end-of-life error.
  Legacy 3.x entries keep their historical direct-id shape.
- **Continuation spin** (#39, following #38 which removed one trigger but not
  the shape). The yielding path defaults `maxToolDepth` to `Infinity` because
  callers budget their own tool work, and false-positive resumptions counted
  against that same unlimited bound — tool budget and resumption patience
  shared one knob. A continuation round that streams under 16 characters and
  stops on the same stop sequence as the previous round now ends the turn with
  `no_progress` instead of re-sending context, and `config.logger` warns at
  round 5 with round count and input tokens, and on every guard trip. Observed
  before the fix as a 43-round, ~7M-input-token spin.
- 529 classification narrowed to exactly status `529` / `'529'` /
  `'overloaded_error'`, mirroring `classifyError`'s deliberate narrowness, so
  unrelated `overloaded` prose (a worker pool, say) no longer lands on the long
  schedule. Provider safety nets attach status 529, so those still route
  correctly.

## 0.5.76 — 2026-07-27

### Added

- **Long jittered backoff for overloaded (529) errors** (Connectome #25).
  Capacity errors were classified retryable, but the default `maxRetries` of 0
  meant they never actually retried — and the streaming paths, which is where
  production agents live, had no retry at all, so a 529 storm killed the turn
  outright. `RetryConfig.overloaded` is a separate schedule (7 attempts, 10s
  base, ×2, 5min cap) forced like the 429 path, with equal jitter so a fleet
  backing off doesn't re-create the stampede in sync. `stream()` gets a
  pre-emission retry wrapper — transparent when the 529 arrived before any
  callback delivered output; mid-stream errors still throw, since retrying
  would replay content the caller already consumed. `isOverloadedError()`
  chooses the schedule only among already-retryable errors and can never
  promote a non-retryable one.

### Fixed

- **The Bedrock stream adapter dropped `stop_sequence`, which broke prefill/XML
  tool use entirely.** The streaming `message_delta` handler captured
  `stop_reason` but never `delta.stop_sequence`, so `streamResult.stopSequence`
  was always undefined on Bedrock. The prefill tool gate matches
  `stopSequence === '</function_calls>'`, so tool calls from Bedrock-hosted
  prefill agents were never parsed or executed, the eaten close tag was never
  restored, and the turn looped forever on the dangling block — the model
  emitting ~6 tokens per round, at a full uncached prefill per retry. Observed
  live as 43 consecutive 172k-token retries after one perfectly-formed tool
  call.
- **`ToolContext.preamble` / `.accumulated` leaked the entire prefill
  document.** In prefill/XML mode the stream parser is deliberately seeded with
  the whole flattened document and records `initialPrefillLength` so turn-end
  paths can slice it off — but the tool-round paths never sliced, exposing
  document+generation instead of the model's text. Consumers persist the
  preamble as "what the agent said this round"; a turn completing normally is
  re-parsed from sliced turn text, so the leak stayed invisible, while a turn
  dying mid-rounds flushed the pending blocks and wrote the full document back
  into the agent's store as its own message. Observed as a ~720k-character echo
  persisted as 62 sharded assistant messages, doubling the store and wedging
  every subsequent compile. `slice(0)` is the identity on non-prefill paths, so
  native-tools flows are untouched.
- **Stale block-level `cache_control` now counts against the 4-breakpoint
  limit.** Request-time markers on imported or stored blocks passed through
  both formatters without occupying a counted slot, so the tools/system
  fallback stacked its own markers on top — 3 markers plus 2 stale blocks = 5,
  and a hard 400 on *every* inference.
