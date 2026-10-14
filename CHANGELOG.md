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

## 0.5.87 — 2026-10-13

### Breaking

- **Default/native Membrane callers:** automatic tool mode selects native when the active formatter supports it across `complete()`, `stream()`, and `streamYielding()`, including tool-free calls. `AnthropicXmlFormatter` in resolved native mode now builds a real native conversation rather than an assistant-prefill transcript with attached tools. Native paths share formatter-backed normalization, media handling, context prefixes, participant labels, custom stops, and provider parameters. The tool loop retains its separate floating-cache placement. **Request bytes and cache prefixes change** for the former default/XML representation, for native paths that previously dropped caller fields, and for a request whose caller marked their own system content but no message, where membrane used to add its own fallback marker on the last system block and no longer does, so deployments on those representations re-warm their cached prefixes once after upgrading. Native stream/yielding preserve opaque message metadata by passing their prompt-serialization input in adapter options rather than adding it to semantic requests/receipt hashes. The prior complete/XML and configured Responses metadata contracts remain unchanged. To keep transcript-prefill behavior, select `toolMode: 'xml'` on a compatible formatter/transport/model. Explicit request mode takes precedence over the active formatter's explicitly configured mode, then its declared capabilities.
- **Native streaming callers, stop sequences:** native `stream()` and `streamYielding()` apply the request's stop sequences to visible text themselves, as they stand after `beforeRequest` hooks. The accepted output ends at the first stop whether or not the provider applied it: the Responses API has no stop parameter, Chat Completions drops it for some models and sends at most four, Gemini sends five, and a custom adapter need send none. The stop is the first in the visible text the provider returned, which the next request replays. No chunk, block event, returned block or replayed Responses item carries it or anything after it, however the provider chunks the text or divides it into blocks; the exception is chunks already sent when the stop is in text the provider returned ahead of them without streaming it, such as a Responses refusal part. Text that could still begin a stop is held until it settles, and text a provider reports only in its returned output is held to the same stops. An adapter's chunks need not match what it returns (`OpenAICompatibleAdapter` returns its text without reasoning a backend leaked into it, and the Responses adapter reports its blocks only at the end), so a stop found while streaming withholds what follows it until the provider returns. If the returned content holds no stop, nothing stopped and the withheld text arrives then. If it holds one elsewhere, withheld text up to that stop arrives then where the chunks match the returned text, and otherwise the chunks end where streaming found its stop. If the call fails first, only what preceded that stop is kept. With stops configured, a block event is reported once a chunk follows it or the stream ends, so a trailing tool call's events arrive when the stream ends rather than as they stream. The response reports `stopReason: 'stop_sequence'` with the stop. A tool call after the stop is neither returned nor run, and one finished before it is returned but not run, as when the provider applies the stop itself. Thinking is never scanned, a non-text block ends a stretch of visible text, and the provider's own stream runs to its end, so usage and `raw` are the provider's. Explicit XML keeps its parser-aware stop handling, which now also ends at the stop that ends first rather than the first listed. `complete()` still returns what the provider returned, and so does `stream()` with `streaming: false`, which is `complete()`. Covered with the actual Anthropic, Responses and OpenAI-compatible adapters over synthetic streams.
- **`prefillUserMessage` in native mode:** when a native conversation needs a synthetic leading user turn (after a `contextPrefix`, before assistant-first history, or after role repair moved a block to the front), that turn carries `prefillUserMessage`. Without it, or when it is empty or only whitespace, the turn stays `[continuing]`.
- **Formatter authors:** declare both required booleans `supportsNativeTools` and `supportsXmlTools`. Missing JavaScript declarations now fail explicitly. False native support does not imply XML support; a tool-bearing request using an unsupported selected carrier fails before HTTP instead of silently losing tools. `CompletionsFormatter` supports neither tool carrier. This supersedes the unmerged PR's `buildsAssistantMessagePrefill` flag: parser prefill, a manufactured assistant prefix, and actual transport prefill are different facts.
- **Message-adapter callers and decorators:** the built-in message transports (Anthropic, Bedrock, OpenAI, OpenAI-compatible, OpenRouter and the Responses API, whose endpoint a gateway can point at a Claude model) check the final converted model/body, including post-hook/native overrides, against the assistant-prefill capability table. Gemini's adapter serves no Claude model and the Images adapter takes no conversation, so neither checks. Known-incompatible tails fail with non-retryable `unsupported`, naming the selected formatter when called through Membrane. XML streaming runners also declare their future continuation requirement, so rejection can precede the first tool round; plain and image continuations are checked again. Native mode preserves caller-authored assistant-ended history rather than inventing a user turn. `ProviderRequestOptions.requestContext` carries the selected carrier and protocol facts outside provider JSON/receipts; decorators must forward options. Actual prompt transports, including renamed `OpenAICompletionsAdapter` instances, remain exempt from the Messages-prefill rule. Nonempty native tool lists that a prompt adapter would discard are rejected, including `request.tools` and `extra.tools`/`providerParams.tools`. On `OpenAICompletionsAdapter`, caller-owned XML `providerParams.prompt` content remains usable with an XML-capable formatter and XML mode. The Images adapter instead reports a tool-capable transport or omission as its remedy.
- **Native cache-budget callers:** Membrane's shared native build delegates membrane-owned budgets to its existing final post-hook clamp; CM-owned markers remain fail-loud. This changes `NativeFormatter`/`complete()`'s earlier message-only over-budget refusal into the same final policy used by native streaming. Standalone `NativeFormatter.buildMessages()` checks the complete messages/system/tools budget by default. Only callers owning a later complete-request check should set `BuildOptions.deferCacheBudgetCheck: true`; it never disables CM-owned assertions.
- The prefill table recognizes dotted OpenRouter versions, `bedrock:` aliases, dated IDs, Vertex suffixes, and Bedrock profile and ARN IDs that carry the model name. An application inference profile's ARN is opaque, so it can't be recognized: it's treated as capable, and an assistant-ended body sent to a refusing model gets the provider's own 400. The original August measurements and the maintainer's September re-measurement remain attributed to their sources; Opus 5 is now correctly labelled measured, while Mythos entries remain family inferences. This correction's transport tests are mocked.

- Native tool calls restore names against the declared definitions instead of treating every double underscore as a colon. This preserves literal double-underscore names in complete, stream, and yielding calls. NativeFormatter rejects definitions whose encoded names collide before dispatch.

- **Native complete and plain-completion callers:** XML-looking response text is no longer interpreted as a tool invocation. Native structured tool blocks remain supported. XML tool decoding, stop-tag reconstruction, and diagnostics follow the selected XML-capable formatter/protocol; plain CompletionsFormatter output stays text across complete, streaming, yielding, and partial/aborted responses. To retain textual XML tool decoding, use an XML-capable formatter and `toolMode: 'xml'`. Plain paths retain provider-native thinking as structured blocks rather than adding XML wrappers.

- **Plain and native streaming callers:** provider thinking deltas remain typed and non-visible instead of entering a plain text parser. Received signatures and redacted blocks survive partial responses, including a thinking signature that arrived before its block finished. It is preserved as received; a signature cut off part-way is not thereby valid for replay. Adapters report such a signature through the new optional `StreamCallbacks.onThinkingSignature(index, signature)`, which carries the whole signature so far and neither starts nor completes a block. The Anthropic and Bedrock adapters call it on each signature delta, and adapter decorators should forward it. `rawAssistantText` contains visible text on plain and native streams alike, and so do a native tool round's `preamble` and `accumulated`, while thinking stays in typed content. **Native callers:** thinking deltas no longer enter these text fields, where they were joined to the visible text with no delimiter. Native aborted responses now include typed `partialContent` from completed rounds and from what the current round received: its text and thinking, and each block the provider finished, including a finished tool call, which is listed but not run. A tool call whose arguments never finished is left out. A block counts as finished when the adapter reports it so, which the Anthropic and Bedrock adapters do as each block ends. The Responses adapter reports its blocks only after its terminal response, and the Chat Completions, OpenAI-compatible, OpenRouter and Gemini adapters report no tool call before they return, so an abort on those keeps the streamed text and no tool call. Once the provider has returned a round, every block it returned counts as received, so a callback that aborts after the stream keeps them. An abort thrown from a callback while a single-final provider (Responses) is still reporting its finished blocks ends that call before it returns, and a finished tool call reported there is not kept. Explicit XML keeps its tagged protocol. Covered with actual Anthropic and Bedrock adapters over synthetic streams, including interrupted transport reads, plus the compatible adapter’s separately reported reasoning.

- **Custom formatter authors and decorators:** streamed plain responses can parse visible text spans around native thinking. Update prefix-sensitive or whole-response-sensitive `parseContentBlocks(content, tools?, context?)` implementations to honor the optional third argument, `ContentParseContext { visibleText, offset }`. Forward it through decorators. Merely accepting the optional argument does not preserve a whole-response assumption. Literal, span-independent parsers need no behavioral change. Built-in CompletionsFormatter now trims only the complete response's leading whitespace; NativeFormatter distinguishes a wholly blank response from internal whitespace-only spans. Whole-response calls without context and the second tool-schema argument keep their existing semantics.

- **Code that switches over or builds `NormalizeEvent`:** the
  `cache_suppressed_for_synthetic` variant is removed, since the suppression
  it described no longer happens; there is no replacement event. A case
  label naming it no longer typechecks, so delete that arm with the
  upgrade. The union also gains `stray_tool_result_textified`, and
  `orphan_tool_result_textified` now requires `recoveredChars`: an
  exhaustive switch needs a case for the new kind, and code that constructs
  these events needs the new field.
- **Code that reads `toolUseId` from `normalizeToolPairs`' output:** a
  `tool_result` given as `toolUseId`, Membrane's content spelling, now
  leaves the normalizer as `tool_use_id` only, the field the wire pairs by,
  so code reading the output's results must read `tool_use_id`. Membrane's
  own request builders already send that field.
- **Callers whose histories hold synthetic `[pending]` results:** the
  normalizer keeps caller `cache_control` markers on and after those
  results instead of stripping them. Such requests change bytes once on
  upgrade, so their first request misses the cache, and the kept markers
  count toward the four-marker limit: under `cacheMarkers: 'cm-owned'`, a
  layout that fit only because the strip removed one is now refused, while
  the default mode clamps as before.

- **Consumers that switch exhaustively on `StopReason`:** the public `StopReason` union gains a member, `pause_turn`, reported when a provider pauses a long-running turn and expects the caller to resume it (Anthropic's `pause_turn`). Previously such a turn was mapped to `end_turn` and looked finished. **Who needs to act:** any code with an exhaustive `switch` over `StopReason`, or a `Record<StopReason, …>` lookup — TypeScript now reports a missing case or missing key, and at runtime a paused turn arrives carrying a token that never appeared before. **Migration:** add a `case 'pause_turn':` that resumes the turn, or a `default:` that treats an unfamiliar stop as non-final; mapping it to a completion reproduces the bug this fixes. **Unchanged:** every other `StopReason` member and its value, ordinary completions still reporting `end_turn`, and non-exhaustive consumers — an `if (stopReason === 'tool_use')` chain compiles and behaves exactly as before. Within this repository no consumer switches exhaustively on `StopReason` (9 sites inspected in shipping code — 8 single-member equality tests and one `switch` that maps the provider's own token and carries a `default`; no `Record<StopReason, …>` lookup exists — verified at this commit).
- Verified against mock provider responses only: `pause_turn` is emitted by long-running server-side tool turns, which are not cheap to induce on demand, so the mapping and its stop-reason plumbing are exercised with a stub adapter.

- **Custom provider adapters:** an adapter that signals its own deadline by throwing a plain `AbortError` (for example `new DOMException('Request timed out', 'AbortError')`) now yields `AbortedResponse{ reason: 'error' }`, where it used to yield `'timeout'` because its message said "timed out". Throw `TimeoutAbortError` for a deadline: it is a timeout by type and an abort by provenance.

### Added

- **Formatter implementers:** `PrefillFormatter` now has an optional readonly `nameFormat` string for native participant prefixes. Implementers with an existing private or non-string member of that name must rename it or expose a compatible public string. Formatters without the member retain the default template. `NativeFormatter.nameFormat` is a readonly data property, so subclasses can override it with a field. Accessor overrides are unsupported; use a field or the constructor option.
- Add `CacheKeepaliveConfig.onCall` receipts so applications can log background cache-refresh calls alongside foreground inference. Each logical poke reports its payload, timing, lineage, and complete terminal vendor response or error, including ineffective writes. SDK-internal retries belong to one receipt; usage comes from the terminal response. Request and success-response copies isolate observers from cached prefixes and effectiveness checks. Tested with fake timers and a mocked Anthropic transport, including an SDK retry; live provider behavior was not tested.

- **`hooks.onNormalize`:** Membrane passes each repair its formatter's tool-pair normalization makes while building a request to an optional `MembraneConfig.hooks.onNormalize(event)`, on `complete()`, `stream()` and `streamYielding()`, every attempt and tool-loop rebuild included. That's where a stray or duplicate tool result turned into text is reported, with `recoveredChars`. Until now Membrane kept only its own prefix-rewrite flag from these events, so they reached none of its callers. The hook runs synchronously inside the build, and one that throws fails the build before anything is sent. A promise it returns isn't awaited, so its rejection is the caller's to handle. Only NativeFormatter's builds normalize, including AnthropicXmlFormatter's native mode.

### Changed

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

- The tool-pair normalizer's coverage note identifies `NativeFormatter.buildMessages`, including AnthropicXmlFormatter’s native-mode delegation, and its callers through shared complete/native stream/yielding construction, rather than claiming every formatter uses the pass. XML/completions serialize text without structural tool blocks. Responses retains its own native item representation, including IDs, encrypted reasoning, phases, and compaction items; its item pairing remains outside this Anthropic-shaped normalizer. Custom formatters own their structural validation.

### Fixed

- Preserve normalized images in native tool-result history and resolve PNG, JPEG, GIF, and WebP media types from their bytes before applying formatter allowlists. Correct mislabeled images on native and XML request paths, native streaming, XML tool-image continuations, Anthropic requests, Responses input images, and OpenAI Images uploads. Unsupported formats still receive the existing formatter placeholders. Verified with mocked request transports and regression tests; live provider acceptance was not tested. **Request bytes change** for histories holding images that were previously replaced by placeholders (normalized `mediaType` tool-result images, accepted formats with labels such as `image/jpg` or `application/octet-stream`), for mislabeled images, and for non-lowercase labels on unrecognized bytes: expect a one-time prompt-cache miss after upgrading, and more input tokens where images are restored. Already-correct images keep their exact bytes.
- Bedrock rejects malformed consumer `anthropic_beta` values with a non-retryable `invalid_request` error, regardless of whether the interleaved-thinking beta is needed. Supply an array of strings; valid consumer arrays still pass through on non-firing models and merge without mutation when the beta is required. Previously, pre-4.6 Claude 4 thinking requests silently replaced non-array values such as a string or `null` with the interleaved-thinking beta and proceeded to the provider; they now throw before sending.
- Native tool streaming honors the active formatter's `nameFormat`, matching non-streaming requests. Participant names prefix only the first retained text block of each message and remain literal when they contain replacement tokens such as `$&`. **Request bytes change** for non-assistant multi-text messages on NativeFormatter complete and native stream/yielding paths, custom `nameFormat` on native streaming, and names containing replacement tokens on NativeFormatter. For cached requests, expect a prompt-cache rewrite from the first changed block after upgrading.
- Initial and continuation requests consistently omit empty system arrays while preserving nonempty system blocks and their cache markers. **OpenRouter wire bytes change** for an empty system array with NativeFormatter or native tool streaming: the leading empty system message is omitted, which can require a prompt-cache rewrite. Other built-in adapters already omitted it from their wire payloads. `beforeRequest` hooks and custom adapters now see `system: undefined`, and default-basis cache receipts report a changed `requestHash`.
- CompletionsFormatter preserves literal participant names in message prefixes, context prefixes, assistant prefills, and stop sequences. Names containing replacement tokens such as `$&` now change prompt and stop-sequence bytes to match the name as written; cached prompts may need a rewrite.
- Preserve OpenRouter response images from content arrays and the separate `images` field through complete, stream, and yielding responses. Inline base64 images become normalized image sources; other URLs remain references. Streaming keeps text callbacks text-only and retains images alongside tool calls. XML streams append provider images after parsed text, matching the existing generated-image behavior. Native tool continuations now replay preserved base64 outputs as assistant-role images alongside tool calls, changing the next request's bytes; later history replay through NativeFormatter uses the same image representation. Replaying a stored assistant image turn through the default XML formatter places its named text and image in a user-role message; histories without such image turns keep their existing replay bytes. URL-source images remain response references and are omitted by NativeFormatter's request conversion.
- OpenRouter skips malformed response image entries with one warning per response, preserving valid text, tools, stop reasons, and usage. Non-string text parts are omitted from both complete and streamed normalized responses; empty array-text parts no longer emit empty stream callbacks. Base64 image data URLs support additional header parameters while preserving payload bytes.
- Strip empty, whitespace-only, and non-string text blocks from Anthropic and Bedrock wire requests, including system and nested tool-result content. Drop messages left empty unless doing so would change the request's final role, which now fails locally with `invalid_request` instead of silently switching between reply and prefill. Warn when discarded text carries cache markers. Requests containing removed whitespace change bytes and can rewrite affected cache prefixes. Retained text bytes, non-text blocks, empty tool-result envelopes, and legacy Bedrock system-string separators are preserved. Shared formatting remains unchanged for other providers.
- Keep cache receipts at one per logical streaming round, including native refusal retries, while raw `onRequest` logging still observes every attempt. Receipts retain their existing post-hook/post-clamp semantic representation by default, including OpenAI, Responses, Gemini, OpenRouter, and custom adapters that omit `onRequest`. Anthropic and Bedrock declare `cacheReceiptBasis: 'wire-request'` so their receipt hashes and marker counts reflect the sanitized final body. Adapter decorators must forward this optional capability and `onRequest`; concrete subclasses inherit it. Because the hash basis moves to the final body, **every Anthropic and Bedrock receipt's `requestHash` changes value on upgrade** (and `prefixHash` / `estimatedOffset` where the adapter rewrites blocks, e.g. tool-result images or Bedrock's TTL strip), even for requests with no removed text; marker counts are unchanged for such requests. `details.cache.markersInRequest` on `complete()` and on `stream()` without native tools now reports the markers actually sent rather than the formatter's count. A wire-request receipt consumer that throws still fails the call before any provider request, even behind adapter decorators that swallow `onRequest` errors: membrane aborts the adapter call through its signal and rethrows the consumer's error. Existing receipt consumers need no sibling version upgrade or callback-shape migration.

- Anthropic's two refusals of the account are `auth` errors, keeping `httpStatus: 400` and their `providerErrorCode`, as a 402 already is. Anthropic sends them as `invalid_request_error`, with no code of their own: "Your credit balance is too low to access the Anthropic API", and "You have reached your specified API usage limits. You will regain access on …". Both used to be `invalid_request`, which agent-framework's poison-history breaker reads as a request worth shedding history over. They are read inside OpenRouter's wrapper too, where `providerErrorCode` stays the router's own, and without a status. Other providers' refusals of the account are typed as before, by their codes or their status.
- A Gemini 429 `RESOURCE_EXHAUSTED` is no longer retryable when its `google.rpc.QuotaFailure` names a quota that no retry within the call, and no caller's backoff, can outlast: one with no allocation at all (`quotaValue` 0, as the string proto3 JSON gives or a number), or a daily window (a `quotaId` naming `PerDay` or `Daily`), which resets only once the day is out. Any one such violation decides. A per-minute quota with an allocation stays retryable. The body's `retryDelay` is still reported either way, but a wait stated only in the message's prose isn't taken from a 429 that isn't retryable. A Google quota inside OpenRouter's wrapper is left retryable, since it may be the router's own, which another route can serve.
- The text that types an error as `context_length` or as an account refusal (`auth`) is read only from the provider's own error message: a `message` field, a string `error`, the first of an `errors` list, or the first entry of a body wrapped in an array, and a router's upstream body only as that body's own message. A body with no message of its own, which can echo the request, is never read for them, with a status or without one. So a prompt echoed in such a body no longer types the error, though a provider's message that quotes the words still does. A bare "too long" no longer reads as a context overflow either, on either path: a provider says that of a field, such as a string past its maximum length, which no shorter history fixes. "Prompt is too long" and "input is too long" still do, with or without "is".

- Provider errors are now classified at the fetch boundary, where the HTTP response is still live: status is preserved verbatim (a 503 is a 503, not a fabricated 500; 402/403/404/413/422 are no longer erased into `unknown` with no status: 402 and 403 are non-retryable `auth`, 404 and 422 `invalid_request`, and 413 `context_length`, a request too large, which a caller that compacts on `context_length` will now answer by shedding history), `retry-after` is read from the response headers (and from google's body `retryDelay`), and the provider's own error type/code reaches the caller as `providerErrorCode`.
- `insufficient_quota` and its billing siblings are no longer reported as retryable rate limits: a 429 whose provider code says the account is out of credit is non-retryable. HTTP failures and HTTP-200 SSE error payloads share this classifier. SSE error statuses in 400–599 take precedence over conflicting descriptive tokens; a transport 200 or arbitrary numeric provider code leaves symbolic-code classification available. Numeric code strings no longer hide a symbolic error type. Frame diagnostics, raw evidence, and retry hints are retained. An explicit SSE 400 now yields a typed non-retryable `invalid_request` rather than a bare `Error`; truly unclassified payloads yield an `unknown` MembraneError with their evidence.
- The per-adapter substring tables that re-derived a classification from a rendered error string are gone; `classifyError` remains as the last resort for non-HTTP throwables only, with narrowed patterns (a body containing "generated"/"moderate", or "moderate limit", is no longer promoted to a rate limit, and an internal `TypeError` mentioning "maximum" is no longer reported as a provider context-length error).
- Preserve the retryable network classification for Node/browser `fetch failed` and `Failed to fetch` errors. On the Anthropic adapter, a Vercel AI Gateway aggregate (an error carrying routing metadata such as `providerMetadata` or `modelAttempts`) whose status may not describe the request stays a retryable server error, as before, now keeping its provider code, retry hint and raw evidence; when its status, sent or implied by the provider code, is 400, 401 or 429 (terminal quota included), it classifies normally instead, so gateway metadata no longer turns a 401 or a terminal quota into a retry or erases a rate-limit hint. Other statuses keep main's handling: a 402, 403 or 404 aggregate stays a retryable server error, since another route may serve the request, and one whose message says overloaded takes 529, the overloaded schedule. Bedrock errors carry the same model ID and stream identity reported by `onRequest`, alongside the existing body.
- A transient 5xx whose body happens to mention "context", "too long" or "token" stays a retryable server error on every adapter — the status guard that previously existed only in the Anthropic and Responses adapters now holds at the shared boundary, bedrock's bare `token` match included.
- Under that guard, a 400 or 422 is a context-length error in each form providers send it: Anthropic's "input length and `max_tokens` exceed context limit" and "prompt is too long", Gemini's "The input token count (N) exceeds the maximum number of input tokens allowed (M)", and OpenAI's `context_length_exceeded`. OpenRouter's generic "Provider returned error" is classified by the upstream provider's own error in `error.metadata.raw`.
- A 400 whose structured evidence names a credential failure is an `auth` error, keeping `httpStatus: 400`: Google's `ErrorInfo` reason `API_KEY_INVALID` (or `API_KEY_EXPIRED`, `ACCESS_TOKEN_EXPIRED`), or an `invalid_api_key`-class code.
- A retry hint stated only in the message ("Please retry after 60 seconds.") is read when no `retry-after` header or body field carries one, on every adapter: only a wait stated in seconds, and only on a rate limit or server error, so a 400 whose text mentions retrying, or a wait in minutes, never becomes a hold. Bedrock's exception type, sent in the `x-amzn-ErrorType` header, reaches the caller as `providerErrorCode`. So does an exception Bedrock sends inside a response stream, which now also takes the status its type implies (`validationException` 400, `throttlingException` 429, `modelTimeoutException` 408, `serviceUnavailableException` 503; internal and model-stream errors 500), where every one but a throttle was a retryable 500 with no code. An Anthropic `error` event inside a Bedrock stream is typed by its `error.type`, so an `overloaded_error` there is a 529.
- Transport failures without a status are typed: the Anthropic SDK's `APIConnectionError` ("Connection error.") is a retryable network error and its `APIConnectionTimeoutError` a retryable timeout, and a socket code on an error or its `cause` (`ECONNREFUSED`, `ENOTFOUND`, Bun's `ConnectionRefused`, `ETIMEDOUT`, …) classifies it when the message says nothing.
- Once an error carries a status, only `529` selects the overloaded retry schedule and its retry allowance: a rate limit or other 5xx whose body mentions an upstream `529`/`overloaded_error` keeps its own policy. An error without a status still matches a word-anchored `529` or the exact `overloaded_error` token in its message, so an ordinary retryable error whose text merely contains those digits ("timeout after 5290 ms", "req-98529abc") is no longer put on the ~10-minute overloaded schedule.
- Original PR verification used live testing: invalid-model 404 and invalid-key 401/400 against Anthropic (`claude-haiku-4-5-20251001`), OpenAI (`gpt-4o-mini`) and Google (`gemini-3.5-flash-lite`), each returning its status and provider error code verbatim (`not_found_error` / `model_not_found` / `NOT_FOUND`), plus one successful call per provider. Mock-only: 429 rate limits, `retry-after` headers, 402/413/422/5xx, openai-compatible, openai-completions, OpenRouter and Bedrock.
- The current composition and review corrections were verified locally with scripted/mocked providers; the preceding live results remain attributed to the original contributor.

- `openai-compatible` now captures a reasoning trace delivered as
  `reasoning_content` (the DeepSeek spelling, used e.g. by Xiaomi's official
  MiMo API in both non-streamed messages and stream deltas) into a thinking
  block. It was previously read only from `reasoning`, so on those endpoints the
  trace was silently dropped: never persisted, never re-sent on later turns.
  `reasoning` keeps precedence when a backend sends both, so OpenRouter-style
  responses are unchanged; the outbound round trip still re-sends the trace as
  `reasoning` on prior assistant turns.

- OpenAI Responses (`openai-responses` and the Codex subscription transport):
  a tool result that carries images is now sent as a native
  `function_call_output.output` array of `input_text` / `input_image` parts.
  Both the `OpenAIResponsesFormatter` and the subscription input normalizer
  previously `JSON.stringify`'d any non-string tool-result content, so the
  model received the image's base64 as text: it could not see the image, and
  a single ~760 KB screenshot cost roughly 500k input tokens (the same image as
  a native part is ~500). Image-free content arrays keep the existing string
  form, so replayed histories without tool images are byte-identical.

- Retries now honour the server's `retry-after`: the wait is `min(maxRetryDelayMs, max(backoff, retryAfterMs))` on both the `complete()` and `stream()` retry paths. A stated wait lengthens the backoff up to the schedule's `maxRetryDelayMs` (30 s by default): a 429 that says "wait 20s" is retried after 20 s rather than on the 1 s backoff, and one that says "wait 60s" is retried every 30 s, so two of its five attempts land inside the stated window where all five used to. A body's `retry_after_ms` is read as a number or a digit string, as an SSE frame's already was.
- The five-attempt 429 floor applies only to genuine rate limits. A 429 whose provider code is a quota/billing failure (`insufficient_quota` and friends) is non-retryable and gets no floor.
- `stream()` now retries a rate limit that arrives before any output reaches the caller, exactly as it already retried a 529 — pre-emission retries stay transparent, and post-emission errors still throw rather than replay consumed content.
- Retry policies remain API-specific: `complete()` can retry eligible network errors when configured; callback `stream()` retries eligible pre-emission rate-limit/overload failures, not every error marked retryable; yielding retains its existing retry policy. Classification, raw stop metadata, and typed abort/deadline identity apply across all paths.
- Verified against mock provider responses only: inducing a real rate limit is not cheap, so the `retry-after` waits, the quota-429 path and the streaming pre-emission retry are exercised with mock `Response` objects and stub adapters.

- Disclose the provider's verbatim terminal token as `details.stop.providerReason` across complete, callback-stream, and yielding responses, independently of the normalized `stopReason` (for example, OpenAI `length` and Gemini `MAX_TOKENS`). Built-in message adapters report this through the optional `ProviderResponse.providerStopReason`; Responses uses its incomplete reason or terminal status. Custom adapters supply that field when they have the raw token. Absent metadata stays absent, including a bare `[DONE]` or locally detected completions EOT marker; Membrane does not guess from a normalized reason. When the adapter's own end-of-turn token ends an `openai-completions` stream, the normalized reason stays `end_turn`, while a `finish_reason` and usage that arrived in that same frame are kept; later frames are not read. A reason Membrane has no member for still normalizes to `end_turn`, since callers switch on a closed union, and is logged once per reason as well as disclosed: the token is printed as a JSON string, cut at 128 characters, and the first 64 distinct reasons in a process are logged, then one line says that further ones are not. `openai`, `openai-compatible` and `openrouter` now pass a `finish_reason` they don't recognize (OpenRouter's `error`, a compatible server's own token) through as the provider's token, as `openai-completions` does, so it is logged and disclosed instead of read as a clean finish. The Responses adapter maps an incomplete `content_filter` to `refusal` and passes any other incomplete reason through the same way.
- `openai-completions` maps `content_filter` to `refusal`, matching its three sibling OpenAI-family adapters.
- Gemini maps the safety enums it previously dropped (`PROHIBITED_CONTENT`, `BLOCKLIST`, `SPII`, `IMAGE_SAFETY`) to `refusal`, passes reasons with no membrane equivalent (`MALFORMED_FUNCTION_CALL`, `LANGUAGE`, `OTHER`) through as the provider token, and surfaces a prompt blocked before generation (`promptFeedback.blockReason` with no candidates) as a refusal, whatever the block reason (`OTHER` and `BLOCK_REASON_UNSPECIFIED` included), instead of an empty clean finish — on `stream()` as well as `complete()`. A promptFeedback-only frame used to reach `stream()` callers as a clean `end_turn`, the stream ending on the parser's initial `STOP`, or, with the guard that a stream must end on a terminal event, as a retryable network error from that guard. Both paths now resolve the stop reason through one shared helper, so they cannot drift apart again.
- Original PR verification used mock provider responses plus one live `max_tokens` stop per provider (Anthropic `claude-haiku-4-5-20251001`, OpenAI `gpt-4o-mini`, Google `gemini-3.5-flash-lite`); the safety and blocked-prompt paths are mock-only.
- The current composition and review corrections were verified locally with scripted/mocked providers; the preceding live results remain attributed to the original contributor.

- Tool-pair normalization no longer strips caller `cache_control` markers merely because it synthesized `[pending]` results. Repeated normalization of unchanged input is stable; later real results can still change the prefix. Request builders retain their existing marker-budget refusal/clamp policies, and native tool loops withhold automatic floating markers after prefix-rewriting repairs.
- Formatter builds reporting `ready: false` are refused before hooks or provider execution with exported `MembraneNotReadyError`, a non-retryable `invalid_request` carrying `formatterName`, which `complete()` and the streaming paths pass to the caller as it is. This applies to the shared formatter-build boundary used by `complete()`, `stream()`, and `streamYielding()`, including native loop rebuilds. Membrane passes no `pendingToolCallIds`, so the built-in formatters report ready through it (the Responses formatter's `ready: true` is a literal); the refusal reaches a formatter that reports not ready, such as a subclass that passes its own in-flight set, whose caller waits for those results and rebuilds. Ordinary loops await tool results before rebuilding.

- Tool-pair normalizer: the pairing invariant is now enforced in both
  directions. Every phase asked only "does each `tool_use` have its
  `tool_result` in the next user envelope?", so a `tool_result` whose
  `tool_use` was not in the immediately-preceding assistant envelope passed
  all eight phases and validation on its way to the 400 this module exists to
  prevent. Three reachable shapes are repaired: an out-of-order append and a
  leading result are relocated into their own cycle (payload preserved as a
  real `tool_result`, and no spurious `[pending]` is synthesized over a result
  that actually landed), and a duplicate re-append after a later turn is
  textified. `validate` now asserts the converse as well as the forward rule.
- Tool-pair normalizer: pairing is enforced as one-to-one, not as id
  membership. Every matching site asked only "is this id called here?" and
  never consumed the id, so a user envelope holding two `tool_result` blocks
  for the same `tool_use` kept both — a malformed one-call/two-result cycle
  that reaches the provider for rejection or ambiguous interpretation. The
  converse sweep now consumes ids: the first result carrying an id pairs, and
  every later copy of it is textified with the same
  `[duplicate tool_result for <id>]` provenance the stray repair already
  used, payload preserved. `validate` additionally counts results per id and
  refuses any id with more than one, so its contract holds independently of
  the sweep; `assertToolPairsValid` exports that check for callers holding
  messages from a path this module does not normalize.
- Tool-pair normalizer: orphan textification no longer destroys array-form
  `tool_result` content. `ToolResult.content` may be a block array (image
  results ride it), and recovery read only the string branch, replacing every
  array payload with the empty string. Both textifications (orphan and
  duplicate) now join text parts, turn inline image, document, audio and
  video data into `[Image: <media-type>, ~<n>KB]`, `[Document: …]`,
  `[Audio: …]` and `[Video: …]` placeholders, and keep every other part (url
  or file sources, text-source documents, other part types) and non-array
  content as JSON. A result that was an error says so
  in its provenance line.
- `NormalizeEvent`: `orphan_tool_result_textified` carries `recoveredChars`
  so a payload drop can never be silent, and a new
  `stray_tool_result_textified` event reports duplicate results converted to
  text, carrying `reason` (`'cycle_closed'` for a copy stranded outside its
  already-answered cycle, `'duplicate_in_cycle'` for a copy behind the result
  that answered its call). `tool_result_hoisted` now also fires for a result
  pushed DOWN into its own later cycle (`fromEnvelope < toEnvelope`) — the mirror of phase 3's
  existing pull-back from downstream (`fromEnvelope > toEnvelope`).
- Export `assertToolPairsValid` from the package root and enforce known strict-role placement, including user-role tool calls and assistant-role tool results, before checking one-to-one adjacency. The assertion also enforces the normalizer's reasoning-block role policy. It reads a history as the provider does, with consecutive messages of one role as one turn, names the messages at fault, and says the history broke the rule (after `normalizeToolPairs`'s own repair, a violation is still reported as the normalizer's bug). It is not a complete provider-schema or cache-budget validator; explicitly pending calls may remain unmatched.
- Preserve a recovered tool result's `cache_control` marker when recovering its content as text, orphan or duplicate, including the marker's TTL (an orphan's was dropped); a result with no marker of its own keeps the last one inside its content. This keeps an explicit message breakpoint from disappearing after the formatter has suppressed its system fallback; the builder's existing marker-budget policy still applies.
- A `tool_result` that names its call as `toolUseId`, Membrane's own spelling, leaves the normalizer naming it as `tool_use_id`, the only field the wire pairs by. It used to pair here and reach the provider unanswered.
- Enforce results-first ordering after orphan/duplicate recovery and synthesis. Tool results form a complete prefix before text, images, and other blocks, including when non-results originally appeared between two results. The stable ordering repair preserves relative order within both groups, their payloads, and existing marker attachments. `assertToolPairsValid` now rejects results after non-result content independently of the repair pass. Requests needing this repair change block order and cache-prefix bytes to the required results-first shape.

- Tool-pair normalizer: producer defects now refuse at entry with a typed
  `MembraneNormalizerError` instead of failing late or silently mis-repairing.
  It is a `MembraneError` (`invalid_request`, not retryable), and Membrane's
  `complete()` and streaming paths pass it to the caller as it is, so a
  refusal is never retried as a transport error or rewrapped.
  - `pendingToolCallIds` is validated on every call: it must be set-like and
    hold strings. It was consulted only for an unmatched `tool_use`, so an
    array (the shape a JSON config round-trip produces) passed every
    well-formed transcript and threw an untyped `TypeError` mid-pipeline
    exactly when the net was load-bearing, and a set of numbers silently
    gave an in-flight call a `[pending]` result. The public type stays
    `ReadonlySet<string>`; the value is not coerced. `null`, like an absent
    set, means nothing is pending.
  - Two `tool_use` blocks sharing an id in one turn are refused: their
    results can't be told apart, and the API refuses such a request. An id
    reused across turns is accepted, as the API accepts it, and pairs by
    position: a result answers the nearest call with its id before it, so
    hoisting no longer hands a later call's result to an earlier one.
  - A `tool_use` without a string id is refused: no result can answer it.
  - A message that isn't an object with role `user` or `assistant`, and a
    content block that isn't an object with a string `type`, are refused
    instead of throwing an untyped `TypeError` mid-pipeline.
  - Message content that is neither a block array nor a string is refused
    instead of being coerced with `String()`, which shipped the literal text
    `[object Object]` to the model. `null` or `undefined` content is an
    empty block list, as before.

- Tool-pair normalizer: hoisting results back from a downstream envelope no
  longer reverses them. Phase 3 unshifted each hoisted `tool_result` onto the
  front of the cycle's user envelope, so a turn whose two calls were answered
  in one downstream batch came back as results `[ite2, ite1]` — wire-valid,
  but the model read its results in an order that did not match the order it
  made the calls. Each hoisted result is now placed at its own call's
  position, which is still the front while no earlier call's result has
  landed, so hoisted results keep preceding any interloping content.

- Tool-pair normalizer: a synthetic `[pending]` result is now inserted at its
  own `tool_use`'s position instead of at the front of the cycle's user
  envelope. With two calls in one turn where only the first landed, the
  `[pending]` for call #2 was placed ahead of call #1's real result — still
  wire-valid, but the model read its results in an order that did not match
  the order it made the calls.

- Tool-pair normalizer: a reasoning block — `thinking` or
  `redacted_thinking` — is no longer welded into an assistant envelope that
  already holds an earlier message's `tool_use`. `rebuildEnvelopes` opened a
  new envelope on role change only, so a reasoning block living under a user
  message, or in an assistant message right after a call message whose
  results were lost, was appended to the PREVIOUS assistant turn — signature
  and all — landing after that turn's `tool_use`. It now opens a fresh
  envelope, which the following `mergeConsecutiveRoles` cannot re-weld
  because phase 3 guarantees a user envelope after any `tool_use`. A
  message's own reasoning after its own call stays where it was. When that
  later message is the history's last assistant content, the request now
  ends on it, after the call's result (a late one or a synthesized
  `[pending]`), where the weld ended it on that result; a provider that
  continues a final assistant message, as Anthropic does, continues it. This
  is a content-correctness fix (signed reasoning attributed to the wrong
  turn), not 400-prevention. Live verification, 2026-08-25: replaying a
  real signed `thinking` block from `claude-haiku-4-5-20251001` with the
  block placed after its `tool_use` returned 200, as did the
  correctly-ordered control, so the API accepts the welded shape; the same
  was observed for `claude-sonnet-4-6`, and separately for a real
  `redacted_thinking` block from `claude-haiku-4-5-20251001` (welded 200,
  control 200). The tests covering this change are mock-only — no test in
  the suite makes a provider call.

- Abort detection never reads the message. A cancellation is recognised by provenance first: once the caller's own signal has fired, the request was cancelled, whatever the in-flight error is (`AbortSignal.timeout()` rejects with a `TimeoutError`, and `abort(reason)` with the reason itself), during a retry sleep and in flight alike. Otherwise it is recognised only by type: a `DOMException` whose name is `AbortError`, an `Error` whose `name` is `AbortError`, a membrane `abort` error, or the Anthropic SDK's `APIUserAbortError`. An error whose message merely contained "abort" — a host tool failing with "...aborted...", a provider mentioning idle-connection aborts — used to resolve the whole turn as `AbortedResponse{reason:'user'}`, destroying the real error and telling the caller the human cancelled; it now throws with its classification and raw request intact.
- A request cancelled through the caller's signal with a reason other than an `AbortError` is a cancellation. On the raw-fetch adapters (openai, openai-compatible, openai-completions, openai-responses, openrouter, gemini), `complete()` cancelled by an `AbortSignal.timeout()` deadline, and `complete()` or `stream()` cancelled with `abort(reason)` (agent-framework's `abortInference(reason)` passes its caller's reason, a string, when one is given), used to throw an `unknown` error. `complete()` now rejects with an `abort` MembraneError, and `stream()` returns `AbortedResponse{reason:'user'}`. That holds on `stream()` with `streaming: false` too, which hands the request to `complete()` and used to let its rejection through (an adapter's own deadline gives `AbortedResponse{reason:'timeout'}` there, as on the streaming paths). Once the caller's signal has fired, `complete()` rejects with an `abort` even when the build itself was refused (a formatter not ready, or a normalizer refusal), keeping the refusal as `rawError`, as `stream()` already did.
- `streamYielding()` reports one `aborted` event per cancellation. When the provider call in flight then rejected with its signal's `AbortError`, as `fetch` does, a consumer still reading the stream used to receive a second `aborted` event, and so did one that cancelled between rounds (right after providing tool results, or between resumed rounds). A caller's signal that had already fired when `streamYielding()` was called used to be missed altogether: the provider call went out and the turn ran to the end. It now gives one `aborted` event, with no provider call.
- A retry sleep removes its listener from the caller's signal when it ends, so a long-lived signal no longer gathers one per retry.
- The Anthropic adapter's error boundary no longer treats a plain `Error` whose message is exactly `Request was aborted.` as a cancellation. That was the last place the laundering survived: any caller — a tool, a proxy, a wrapped upstream failure — can produce that exact string, and it was converted into a user cancellation even though nothing about its type said abort. The SSE idle watchdog the check was added for never reached it, since the stream catch throws its own typed timeout first. Such an error now surfaces as an ordinary unclassified error with its message and raw request intact.
- Preserve `TimeoutAbortError` and other classified subtypes through adapter and public error propagation. Request metadata enriches the same error instance when writable, preserving credential/private-field identity and existing request evidence; frozen errors propagate unchanged. Custom adapters report a deadline with `TimeoutAbortError`, rather than expecting prose in a plain `AbortError` to imply a timeout.
- Original PR verification used live testing: an in-flight Anthropic request (`claude-haiku-4-5-20251001`) cancelled through its `AbortController` is still classified `abort` at the adapter boundary, while a plain `Error` carrying the SDK's exact abort text classifies as `unknown`. Mock-only: the `DOMException`, `name`-based and membrane-`abort` shapes, and every non-Anthropic adapter (all of which reach the same typed check through raw `fetch`).

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
  there; legacy `tool_use` blocks without `rawXml` are reconstructed that way.
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

## 0.5.86 — 2026-09-21

### Fixed

- OpenAI Responses subscription mode now sends a stable `session_id` header
  (and matching `prompt_cache_key`): an adapter-lifetime id plus a digest of
  the instructions and first input item, which groups requests by serialized
  head. The ChatGPT backend keys its prompt cache on that header and ignores
  the body key, so every request used to get a fresh random key and a
  byte-stable 170k-token prefix read `cached_tokens: 0` on every call. New
  `sessionId` config pins the base id across restarts; a request's
  `extra.prompt_cache_key` replaces the computed id. `extraHeaders` now
  override built-in headers case-insensitively.

## 0.5.85 — 2026-09-14

### Added

- Allow `AnthropicAdapter` to resolve rotating bearer credentials per request through `credentials` or an `authToken` callback, with one forced refresh after HTTP 401. The shared seam covers complete, streaming, and cache-keepalive requests without freezing a token in the SDK client.
- Surface resolver failures and invalid tokens as authentication errors without allowing SDK connection retries to repeat credential acquisition. Each SDK operation owns its failure/cancellation state, including cache-keepalive sends, so concurrent requests cannot cancel one another.

- Add ChatGPT subscription mode to `OpenAIResponsesAPIAdapter`, with per-request credentials, one refresh after HTTP 401, Fast mode, maintenance-input conversion, and shared Responses streaming and usage normalization. Login and token persistence remain application responsibilities.
- Include the required empty reasoning summary when formatting encrypted-reasoning blocks without a provider-native item, so historical reasoning can be replayed through Responses.
- API-key Responses calls now classify HTTP 403 as authentication failure, other ordinary 400s as invalid requests, and all 5xx responses (including 504) as retryable server failures; honor Retry-After headers; and parse multiline SSE events. Static keys retain their existing header precedence and do not trigger credential refresh.
- Allow subscription maintenance calls to use per-request formatters and retain participant names. Adapter decorators must forward `requiresNativeResponsesInput` alongside `usageCacheConvention`.
- Keep response-body cleanup from blocking credential retries or stream failures when a logging observer retains a cloned body; reject non-string or blank resolver tokens before HTTP.

### Fixed

- OpenAI Images adapter: a previous output carried forward in history as a
  `generated_image` block is now attached to `/v1/images/edits` and referenced
  in the transcript like any other image, instead of being silently dropped
  (Greptile review on #71).

## 0.5.84 — 2026-09-08

### Added

- OpenAI Images adapter (`OpenAIResponsesAdapter`, `/v1/images/generations|edits`):
  opt-in `promptFormat: 'transcript'` flattens the conversation into
  role-delimited `### User` / `### Assistant` turns and references every
  attached image inline as `[Image N]` in the turn it belongs to, so a previous
  generation (an image-only assistant message) reads as the assistant's own
  prior turn instead of vanishing from the prompt. Adds `maxInputImages`
  (clamped to the API cap of 16; transcript keeps the most recent, legacy the
  first) and `transcriptPreamble`. Default `'legacy'` is byte-for-byte unchanged.

## 0.5.83 — 2026-09-06

### Fixed

- OpenAI: `gpt-6-*` (and every later GPT generation) now gets the GPT-5-era
  parameter surface — `max_completion_tokens` instead of `max_tokens`, no
  `temperature`/`top_p`, no `stop`. The adapter matched these by listing
  `gpt-5` prefixes, so `gpt-6-astra` fell through to the legacy parameters and
  every request 400'd at the wire ("Unsupported parameter: 'max_tokens' is not
  supported with this model. Use 'max_completion_tokens' instead."). Detection
  is now by major version (`gpt-<n>` with n ≥ 5); `gpt-4o`/`gpt-4.1` and the
  o-series are unchanged. Adds `gpt-6-astra` default pricing.

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
