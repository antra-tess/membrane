# Changelog

Notable changes to `@animalabs/membrane`, loosely following
[Keep a Changelog](https://keepachangelog.com/). Entries land with the change
that causes them — see [CONTRIBUTING.md](CONTRIBUTING.md#changelog).

Releases up to and including 0.5.75 predate this file; for their contents see
`git log` and the
[releases page](https://github.com/antra-tess/membrane/releases).

## Unreleased

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
