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

## 0.9.0 — 2026-10-30

### Breaking

- **Code that calls an adapter's own `complete()` or `stream()`:** if the
  call's `signal` has fired by the time sending the request or reading its
  response fails, every adapter that makes requests rejects with a
  `MembraneError` of type `abort`, not retryable, "Request was aborted". Its
  `rawError` holds what the adapter caught, an `Error` as its serialized
  fields and anything else as it is: for `AnthropicAdapter`, what its SDK
  threw, or a credential failure that ended the request first. Where the
  adapter caught a reason that is already a `MembraneError` of type `abort`,
  as every such adapter but `AnthropicAdapter`, whose SDK rejects with an
  error of its own, does when that reason ended the request, it passes that
  error on, as before. A runtime's `fetch` can instead reject a body read
  begun after the signal fired with an `AbortError` of its own (Node
  22.12.0's does). The adapter then builds a new `abort` with that error as
  its `rawError`, where it gave the same `abort` with none before. Before,
  every such adapter but `AnthropicAdapter` typed the abort as it would a
  failure of the request, by the reason's code, name or words: a reason
  coded `ECONNRESET`, or wrapping one as its `cause`, was `network` and
  retryable; a `TimeoutError`, which `AbortSignal.timeout()` gives, was
  `timeout` and retryable; a reason that was itself a `MembraneError` kept
  its own type; a string, a plain object or an `Error` whose words name no
  failure was `unknown`. `AnthropicAdapter` already gave `abort`, with no
  `rawError`. **Migration:** read `abort` for your own cancellation, as
  `Membrane` already gives, and don't retry it. **Unchanged:** the `type`,
  `retryable` and `message` of a call through `Membrane`'s `complete()`, and
  the aborted response, reason `user`, that `stream()` and
  `streamYielding()` give for the caller's own signal. Apart from a reason
  that is already such an abort, the error `complete()` throws now carries
  as its `rawError` what the adapter caught, such as the caller's reason or
  what the Anthropic SDK threw, where it carried the adapter's own error or
  nothing. A deadline of the call's own (`timeoutMs`, `progressTimeoutMs`,
  progress bounds, and `AnthropicAdapter.stream()`'s idle and first-event
  watchdogs) stays a `timeout`, unless the caller's signal has also fired by
  the time the error is handled; then it's an `abort`, as through
  `Membrane`. agent-framework 0.27.0, connectome-host at `b98d9765` and
  context-manager at `f7cd5b67` cope: they reach adapters through
  `Membrane`, and connectome-host's logging adapters, which call the adapter
  beneath them themselves, are the adapters `Membrane` is given, and log
  what that adapter throws before passing it on.

### Added

- `getDefaultModelLimits(modelId)` gives the window and maximum output (`maxContextTokens`, `maxOutputTokens`) that Anthropic's API enforces for a Claude model from 4.5 on, found by its exact id or that id with a snapshot date (`-YYYYMMDD`), and `undefined` for any other id. A bare Claude id gets its row whatever provider it is sent to, and other providers' limits for the same id can differ.

### Changed

- A request that can't reach its host says so in its error's `message`: the
  host it tried (the adapter's base URL's host and port, never its path,
  query or userinfo), what happened in plain words, and the transport code,
  with each address it was met at that isn't the host's. For example, "The
  request to api.anthropic.com failed: the connection was refused
  (ECONNREFUSED at 0.0.0.0:443)." It read "Connection error." through the
  Anthropic adapter, "fetch failed" through the others on Node, and the
  runtime's own text on Bun. It holds for every adapter's `network` and
  `timeout` errors whose causes carry a code, on Node and Bun, and each
  attempt Node makes at a name with several addresses is read. A code without
  plain words follows the error's own text, as in "fetch failed (EPROTO)".
  Unchanged: the text of a failure whose causes carry no code, of a credential
  resolver's own failure, and of a certificate failure typed `unknown`
  (through the fetch-based adapters on Bun); and `type`, `retryable` and
  `rawError`. `networkError()` takes the host's URL as an optional fourth
  argument.
- A `network` or `timeout` failure is never read as an overload by its
  message (`classifyFailure`, `isOverloadedError`), so a host or port that
  reads 529 doesn't move a connection failure onto the overloaded retry
  schedule. A status-less `network` or `timeout` failure whose own text held
  `529` or `overloaded_error` was read as an overload before, and now takes
  the retryable schedule.

### Fixed

- The Anthropic adapter no longer keeps anything of a finished request alive
  through the caller's `AbortSignal` (#212). SDK 0.52 adds an `abort`
  listener to the signal each request is handed and never removes it. With
  an API key and no `timeoutMs`, the adapter handed it the caller's own
  signal, so a caller reusing one signal gained a listener, and a request's
  controller, per `complete()`. With a `credentials` resolver it handed it a
  signal from `AbortSignal.any()`, which, holding that listener, can outlive
  the request: on every runtime measured while a reused caller signal lives,
  and on Node 22.12 even after the caller's signal is gone. Each request
  given a signal now hands the SDK one of its own, which follows the caller's
  and lets go of it when the request settles.

- The Anthropic adapter honours `timeoutMs` as a deadline on each `stream()`
  and `complete()` request, through `createCombinedSignal` as the other
  provider adapters do (#97). It used to be inert there: the SDK's own timeout
  clears once response headers arrive, so a stream that kept sending deltas,
  or a response whose body never finished, had no bound. The deadline
  classifies as the same `TimeoutAbortError` the other adapters' `timeoutMs`
  gives (type `timeout`, not retryable), distinct from the idle watchdog's
  retryable stall timeout.

- `stream()` ran a tool round's `onToolCalls` after the caller's signal had
  fired, in both its XML and native tool loops: a signal that fired while
  `onPreToolContent` ran, or anywhere after the round's text came in and before
  its tools ran, didn't stop them. Such a round now runs none of its tools, and
  the turn ends as the caller's abort already ends it: the aborted response,
  reason `user`, whose `toolCalls` and `toolResults` list only the rounds that
  ran.

## 0.8.0 — 2026-10-26

### Added

- `progressBounds` on `stream()` and `streamYielding()`: bounds, off by default, that end a streamed
  call which stops making progress while its connection stays open. `true` takes `PROGRESS_BOUNDS`:
  60 s from the send to content, or, once a thinking block has started, the later of that and its
  `max_tokens` at 87 tokens a second from its start, and 150 s between provider events once
  content has begun. An object replaces any of the three. They apply on `AnthropicAdapter` and
  `BedrockAdapter`, run beside `progressTimeoutMs`, and end a call as aborted with reason
  `'timeout'`, which membrane doesn't send again. The README's "Progress bounds" says where the
  values come from and what they weren't measured on.
- `@animalabs/membrane/progress-bounds` exports `PROGRESS_BOUNDS`, `ProgressBounds`,
  `resolveProgressBounds` and `trackProgress`, and imports nothing else of membrane's.
- `AbortedResponse` and the `aborted` stream event carry `message`, what ended the call when the
  caller didn't: a deadline's names the bound that ran out, `progressTimeoutMs`'s included.
- **Provider adapters and decorators:** `ProgressSeen` gains `'think'`, which an adapter that
  reports content (`SendReport.reportsContent`) passes for a thinking block's start unless the
  body asks for summarized thinking. `AnthropicAdapter` and `BedrockAdapter` do. With progress
  bounds on, a decorator that forwards `onSend` but drops `onProgress` or its argument has every
  call still running `beforeContentMs` after its send ended.

### Changed

- Inside a `tool_result` on Bedrock, only what the Anthropic adapter
  sends there now goes: a text block's type and text, and an image with a
  base64 or URL source as its type and source. A document, a search
  result, a tool reference, a browser state or an image with a `file`
  source there is now left out and reported, and a `cache_control`, a text
  block's `citations` or an image's `transformations` there no longer
  goes. Bedrock's adapter sent each as it came, so a request whose history
  holds one now goes without it, and its prompt cache is written again
  from that block on. One whose only breakpoints sat inside a
  `tool_result` goes uncached while that block is in history, as on the
  Anthropic adapter today: by our reading, the breakpoint budget still
  counts them, so `NativeFormatter` adds no system breakpoint. membrane
  builds none of them inside a `tool_result`, and MCP's content types
  include none of them.
- Whitespace-only text inside a `tool_result` on Bedrock is now removed as
  the adapter builds the content, and reported as its `tool_result`, as the
  Anthropic adapter does, where the empty-text cleanup removed it after the
  build and reported the text block.

### Fixed

- The Anthropic and Bedrock adapters build each block at the top of a
  message from the Messages API's own fields for its type (text, image,
  document, `tool_use`, `tool_result`, `thinking` and `redacted_thinking`)
  (#161). A field the API doesn't define, which it refuses ("Extra inputs
  are not permitted"), is left behind: MCP's `annotations` and `_meta`,
  membrane's `sourceUrl`, `tokenEstimate` and `rawItem`, a tool call's
  `rawXml`, or a host's own. Before, such a field reached the wire on a
  block the adapter passed on as it came, and since the block stays in
  history, every later request carrying it was refused. That included an
  image's `tokenEstimate` at the top of a message, and a `redacted_thinking`
  block's `tokenEstimate` on both adapters (agent-framework, whose stamp
  that is, leaves it off its requests since anima-research/agent-framework#571).
  A block of another type, such as a server-tool block the API produced,
  still goes as it came (on Bedrock without `cache_control.ttl`, as
  before), and so do the blocks of a passthrough `extra.messages`.
- Inside a `tool_result` on Bedrock, the content is now built as the
  Anthropic adapter already builds it: text as its type and text, an image
  with a base64 or URL source as its type and source, labelled by its bytes
  or sent as the placeholder, and any other block left out and reported.
  Before, Bedrock's adapter kept every field on each block there, so an MCP
  text block's `annotations` or an image's `sourceUrl` got every later
  request refused (#161).
- A document in membrane's form now goes with `media_type`, and its
  `filename` as its `title`, as `toAnthropicContent` sends it, where a
  request built directly sent `mediaType` and was refused (#161).
- An error `tool_result`, which the API takes with text only and never
  without content, now goes as the API takes it, on both adapters and from
  `toAnthropicContent`: an image there goes as a note saying it wasn't
  shown (or as the placeholder, when its data is no image the API accepts,
  as before), and one that would go with no content carries a note saying
  it carries no content this request can show. Before, Bedrock's adapter
  sent each block there, Anthropic's sent an image there, and an error
  result left empty went out empty, and the API refused each.
- A block that isn't an object, such as a `null`, at the top of a message
  or inside a `tool_result`'s content, is now left out and reported, on
  both adapters. Before, both adapters threw building a request with one at
  the top of a message, and inside a `tool_result` Anthropic's adapter threw
  and Bedrock's sent it and the API refused it.

- Published docs that said something the code doesn't do now say what it does. The code is unchanged:
  - **Retry** (`@animalabs/membrane/retry`): an overloaded failure whose settings have no overloaded
    schedule is retried on the `retryable` schedule, without jitter (`RetrySettings`, `delayFor`,
    `retryDecision`). `RetrySchedule`'s formula is the un-jittered step, not the wait itself.
    `MEMBRANE_RETRY_SETTINGS`' schedules stay frozen in a spread copy, so a change replaces whole
    schedules.
  - **Errors:** a `TimeoutAbortError` also comes from the progress deadline. `terminalQuota` marks
    only a quota that no retry within a call, or a backoff, can outlast: one with no allocation, or a
    daily one.
  - **Streams and responses:** `TokensEvent` also carries an XML tool loop's tool results. A
    deadline of the call's own ends a stream as `aborted` with reason `'timeout'` (`stream()`
    returns an `AbortedResponse`), whether retries are on or off. A per-request `formatter` doesn't
    replace a Responses formatter on the Responses adapter. `CompleteOptions.refusalRetries` no
    longer says a discarded attempt leaves no trace: its response still reaches `onResponse`.
    `onBlock` names every block type it reports.
    `complete()` can make more than one provider call. `discardedAttempts` is read on
    `details.usage`; on `complete()` the top-level `usage` is the same object, its counts the
    surviving attempt's.
  - **Requests:** `temperature` isn't clamped; the provider's range applies. A thinking config
    strips a custom `top_p` only below 0.95. `promptCaching: false` still sends a `cache_control`
    a content block carries. With one free marker slot, `floatingCacheMarker` can't keep the
    previous round's cache entry across a round wider than the provider's ~20-block backward
    search. `contextPrefix` is marked for caching only when membrane places the markers. In an XML
    tool loop, the first tool result with images the request can send has them sent as images.
  - **Context management:** truncation to the hard limits keeps at least the newest message and
    doesn't split a tool call from its result where it can avoid it, so a limit can still be
    exceeded, as `residualOverflow` reports. The module places at most 3 cache points.
    `cachedStartMessageId` is unset after a new conversation or branch switch until the next roll.
  - **Keepalive:** requests that share model, system prompt and tools share one lineage whatever
    their lane, and the one recorded later replaces the other's snapshot (`cacheLineageKey`).
    `maxIneffective` counts pokes that read nothing from the cache as well as those that wrote, and
    `cacheKeepaliveIneligibleReason` also skips a request with no one-hour marker. A keepalive
    replay resends the headers its request was recorded with and doesn't call `dynamicHeaders`.
  - **Adapters:** on `BedrockAdapter`, `region` reads `AWS_REGION` before its default,
    `anthropicVersion` is the `anthropic_version` body field, a gateway `baseURL` still needs a
    non-empty `secretAccessKey`, and `reportsContentAlterations` covers unsigned thinking and
    sourceless media too. `MockAdapter` answers from its queue, then its generator, then its echo,
    then its default. `OpenAIAdapter`'s `baseURL` doc no longer gives Azure advice that doesn't
    work, and `toOpenAIContent` returns a content string or null. A blank `reasoning_content`
    loses to a substantive alias. `OpenAICompletionsAdapter`'s `assistantName` ends the prompt and
    gets no stop sequence; it doesn't identify messages. The Images adapter's
    `allowImageEditing` counts only base64 and generated images, `maxInputImages` is clamped to
    [1, 16], and its usage reports input and output tokens with no cache counts. The Responses API
    adapter's `onFastModeFallback` fires only for a request that asked for the priority tier.
  - **Formatters:** `unsupportedMedia` governs documents (and audio in `AnthropicXmlFormatter`), and
    `CompletionsFormatter` always strips them; an image in a format the API doesn't take becomes a
    text placeholder either way. Not every normalizer repair emits a `NormalizeEvent`, and a
    non-zero count isn't always a producer's bug. A parsed `string` parameter loses one layout
    newline after its opening tag and one before its closing tag.
    `normalizeToolPairs` joins consecutive same-role messages. `AnthropicXmlFormatterConfig`'s
    `toolMode: 'xml'` puts the definitions where `toolInjectionMode` says.

## 0.7.2 — 2026-10-26

### Added

- **`ProviderRequestOptions.onSend`** (`SendReport`: `maxTokens`, `reportsContent`) and an argument to **`onProgress`** (`ProgressSeen`: `'content'`). `AnthropicAdapter` and `BedrockAdapter` report the `max_tokens` their body carries, and on `stream()` which events are content. A decorator forwards `onSend` with the other options, and `onProgress` with its argument. Membrane itself passes no `onSend` and reads no `onProgress` argument, so these reach only code that calls an adapter directly.
- **`BedrockAdapter`'s stream** carries a refusal's `stop_details` on its final message, its raw response, when a `message_delta` carried them, which AWS's page doesn't show, so they may never come. An exception or error event inside a Bedrock stream now keeps the provider's error on the error's raw error, as `error`, as an Anthropic SDK error keeps its body.

- **`ProviderResponse.refusalCategory`**, optional: the provider's category for a refusal, such as `'cyber'`. An adapter sets it when the provider stopped with `refusal` and named a category, and membrane announces it on a refusal re-issue's `RetryingEvent.category`. `AnthropicAdapter` sets it from `stop_details.category`. A custom adapter sets it to have its category announced, and a decorator that builds a new provider response, rather than passing on the one it got, carries it.

### Changed

- The Anthropic adapter's list of models whose `temperature`, `top_p` and `top_k` it strips now
  names each model by its id. An entry matches that id, or that id followed by anything that
  doesn't continue its version (a digit, or a hyphen and one or two digits, does), such as a dated
  snapshot. Before, an entry such as `claude-sonnet-5` matched every id that began with it. Every
  model the old entries covered is still listed: Fable 5.1 and Sonnet 5.5 on measurements (on
  2026-10-23, with no thinking config, each refused `temperature` 0.2 and `top_k` 40 with a 400,
  and Fable 5.1 a `top_p` of 0.9, which Sonnet 5.5 refused on 2026-10-19), and Mythos 5.1 because
  the Fable and Mythos family always thinks, and with thinking on the API takes no custom
  `temperature` or `top_k`. A model released later that an old entry would have covered, such as
  `claude-opus-5-6`, gets a caller's sampling parameters passed through rather than stripped until
  a release lists it, and if it refuses them, the API's 400 says so.

### Fixed

- **Cache keepalive: a lineage's touch counts from the request's send, where the cache's clock starts (follow-up to #164).** Since #164 the keepalive records a request once the provider has begun answering it, at `message_start` or once a non-streamed answer arrives, and it stamped the lineage's touch then. So a call that waited minutes for its first event, or a `complete()` whose answer took minutes (in the opt-in `complete` lane), had its first refresh fall due that much later against a TTL that started at the send, toward the edge where a refresh writes instead of reading. The adapter now passes each attempt's send time to `CacheKeepalive.record()`, whose new optional `sentAt` sets the touch, and the 24-hour window unless the lineage already has a later real call (left out, both count from now). A refresh stamps its touch at its own send rather than its return. `getStatus()`'s `idleMs` and `realIdleMs`, and a `refreshed` event's `idleMs`, now include that wait. `record()`'s doc and the keepalive's header now say the provider has *processed* the prefix, not cached it: a prefix under the model's minimum cacheable length is processed and not cached, and the refresh's self-check drops its lineage.

- The Anthropic adapter strips `temperature`, `top_k` and `top_p` for Claude Opus 5 and Opus 5.5
  (`claude-opus-5` and `claude-opus-5-5`, with their dated snapshots), as it does for the other
  models that refuse them. With no thinking config, both refused `temperature` 0.2, `top_k` 40 and
  `top_p` 0.9 with a 400 ("… is deprecated for this model"), so a caller's sampling setting
  failed the whole request. As for the other listed models, every `top_p` is stripped, with a
  thinking config or without one: 0.99 too, which both accept with no thinking config, and a
  `top_p` of 0.95 or more under thinking, which the adapter used to pass.

- **A refusal re-issue's `RetryingEvent.category` now carries the refused attempt's category through `AnthropicAdapter`.** Membrane read the category from `raw.response.stop_details` on the adapter's response, a shape no built-in adapter's raw response has: `AnthropicAdapter`'s raw carries `stop_details` at its top level. So the event never had a category for a real Anthropic refusal. The adapter now reports it in the new `ProviderResponse.refusalCategory` (under Added): Anthropic's `stop_details.category`, such as `'cyber'`, set on `stream()` and `complete()` when the provider stopped with `refusal` and the category is a non-empty string. Membrane reads that field for the event, and no longer reads the adapter's raw response for it. A custom adapter whose raw response carried the category at `response.stop_details`, the one shape that was read, sets `refusalCategory` to keep it on the event. `BedrockAdapter` now sets the field too, from the `stop_details` AWS documents on a non-streamed body, and on its stream when a refusal's `message_delta` carries them, which AWS's page doesn't show, so there they may never come. Its refusal re-issues carry their category whenever it's read. The other built-in adapters set none, so their retrying events still have no category.

## 0.7.1 — 2026-10-22

### Added

- `AnthropicAdapter` keeps what it needs to report a response to Anthropic,
  on `ProviderResponse` and on its `raw` response: `responseId` / `raw.id`,
  the message id, and `requestId` / `raw.request_id`, the `request-id`
  response header, on `stream()` and `complete()`. Before, the stream path
  kept neither, and `complete()`'s raw response lost the request id when
  serialized (the SDK attaches it non-enumerably). The stream path's `raw`
  also carries `provider_events`: `message_start` (the event, its message
  without `content`), `message_delta`, and `unhandled`, the first 20 events
  or deltas the adapter doesn't read or doesn't apply, with
  `unhandled_omitted` counting the rest; each kept event is cut to 4,096
  JSON characters. A field the API adds to `message_start` or
  `message_delta`, a delta type the adapter doesn't read, and a
  `content_block_stop` carrying more than its type and index are now visible
  where they used to be dropped. A new event type isn't: the SDK
  (`@anthropic-ai/sdk` 0.52) yields only the event types it knows. Block
  content stays in `content`, though an event kept in `unhandled`, such as a
  `citations_delta`, keeps the payload it carried. `ProviderResponse` gains
  optional `responseId` and `requestId` for any adapter to fill.

- Membrane's retry decision is its own entry, `@animalabs/membrane/retry`,
  for a layer that retries provider calls itself after passing
  `retry: false`. `classifyFailure` names a failure's class (overloaded, rate
  limited, other retryable, a deadline that ran out on a sent request, or
  final). `retryDecision` says whether to retry after a number of tries and
  how long to wait, or hands back a stated wait past its schedule's ceiling.
  `delayFor` gives one wait and its un-jittered step, for a caller that holds
  rather than gives up. Each takes a path's own settings, a schedule per
  class. `membraneRetrySettings(config)` gives membrane's for a retry config,
  and `MEMBRANE_RETRY_SETTINGS` its default. A retry after attempt n (the
  tries made so far) waits `firstDelayMs × multiplier^(n − 1)`, up to
  `maxDelayMs`, and only an overloaded failure's wait is jittered. It fails
  closed: an attempt must be a whole number from 1, and a wait that isn't a
  finite number ends the retries (`delayFor` throws a `RangeError` for
  either). A wait can be longer than one `setTimeout`
  holds, so sleep it in chunks, as membrane does. The entry loads no
  provider SDK. Membrane's own retries now go through it, and for
  every error membrane's adapters build they decide as before.

### Fixed

- **Anthropic and Bedrock: a thinking block with no signature is left out of the request, and reported (#191).** Another provider's reasoning, such as Gemini's thought parts (#190) or an OpenAI-compatible reasoning channel, comes back from history as a `thinking` block with no signature. Anthropic's Messages API refuses that block, and refuses an empty or made-up signature too, so a conversation that moved to an Anthropic model after such a turn failed with a 400 until the turn left its history. `AnthropicAdapter` and `BedrockAdapter` now leave the block out and call `onContentAltered` for it, and `toAnthropicContent()` leaves it out too. An assistant turn whose only block it was is dropped, as a turn of whitespace text is, and a system change goes where it would with that turn gone. So a final assistant turn whose only block it was is refused before sending, as an emptied final turn is. When a system change comes after the last user turn, it ends the request instead, and the turn is dropped. Signed and signature-only thinking blocks are sent as before.

- A round the provider ends with a literal `stop_reason: end_turn` while its
  content holds complete client tool calls now runs as a
  `tool_use` round on both native tool loops (`stream()` with `onToolCalls`,
  and `streamYielding()`), and `complete()` returns it as a `tool_use` stop.
  Before, every native loop gated execution on `tool_use` alone, so the
  calls never ran and the turn ended as if finished, with nothing logged;
  production Anthropic responses had this shape on 2026-10-19. A call is
  complete when its block stopped and its input parsed to an object (no
  `unparseableInput`); a round holding an incomplete call runs nothing, as
  before. A length, refusal, stop-sequence or pause stop never qualifies,
  nor does a provider token membrane doesn't map, nor a round with no
  provider stop token at all (an adapter that reports none, or an
  OpenAI-family server that sends no `finish_reason`): those run nothing, as
  before. Each occurrence warns
  once, through the configured `logger` when one is set, with the model, the
  tool names and the message and request ids, and is recorded in the new
  `details.anomalies` (`ToolUseWithEndTurnAnomaly`: `kind:
  'tool_use_with_end_turn'`, `round`, `providerStopReason`, `toolNames`,
  `toolUseIds`, `treatedAsToolUse`, `model`, `messageId`, `requestId`),
  which keeps the round's own stop token. `details.stop` describes the
  response's final round. The Anthropic and Bedrock stream adapters now hold
  block events to the API's order: a start while no block is open, at the
  next index (in Bedrock a start above it leaves the slot it skips empty,
  which fails the call as a lost block, as before, and a later start in that
  slot now breaks order instead of filling it), then that block's deltas, a
  tool call's being only its arguments, and its stop. The first event out of
  that order (such as a block left open when the next one starts, a late
  stop or delta, a second start for an index, or a text delta in a tool
  call) means the stream can't vouch for which call any arguments belong to:
  no later block event is applied, a block still open is finalized as cut
  off, and every `tool_use` block in the response is marked
  (`unparseableInput`; one not already marked also gets `input` `{}`), so
  the gate runs none of them on an `end_turn` round, and on a `tool_use`
  round the caller gets them marked. Each adapter warns once, and the
  Anthropic adapter keeps those events in `raw.provider_events.unhandled`.
  Bedrock now stops reading at `message_delta`, as the Anthropic adapter
  does, so a call still open there is marked as cut off in both, and nothing
  after it is read: before, a later block event was applied, a second
  `message_delta` set the stop reason again, and an error event failed the
  call. In the Anthropic adapter the marking leaves server tool calls as
  they streamed, since they ran on the API's side: one that stopped keeps
  its input. Bedrock's response carries no server tool blocks, as before.
  Citations are the exception to "not applied": the SDK appends each one to
  the `citations` array a text block's start carried, which the adapter's
  block shares, so one still lands there when the start carried an array. A
  stream that ends with a block open, as a `max_tokens` cut does, is in
  order, as before.

- `GeminiAdapter` keeps the model's reasoning out of its answer. Gemini
  returns reasoning as text parts flagged `thought: true`, and the adapter read
  every part's text as answer text, so a request that asked for them
  (`thinkingConfig.includeThoughts`, e.g. through `providerParams`) had the
  model's reasoning joined onto the front of its reply
  with no separator, streamed through `onChunk` as visible text, and in
  `rawAssistantText`. On `complete()` and `stream()`, thought parts now
  become one `thinking` block, placed before the answer, and are not streamed
  through `onChunk`, as `OpenAICompatibleAdapter` treats its reasoning channel
  (the Anthropic adapter, by contrast, streams thinking chunks). A response of
  only thought parts has no text block. An image model's interim thought
  images, flagged the same way, are no longer among the answer's images.
  `fromGeminiParts()` keeps part order:
  each thought part with text becomes its own `thinking` block where it fell,
  as each text part is its own `text` block. `toGeminiParts()` sends only text
  and tool calls: a `thinking` or `redacted_thinking` block, as
  `convertMessages` drops them, or an image, which it doesn't convert, used to
  become a text part reading "[object Object]". Thinking blocks in prior
  assistant turns are still not sent back to Gemini. A response without
  thought parts is unchanged.
  - Not round-tripped: Gemini's `thoughtSignature`, which may ride any part,
    is not captured.

- `hooks.onError` is asked after a retry's wait is decided, so a change it
  makes to `error.retryAfterMs` no longer changes the wait. Its documented
  contract, `'retry'` or `'abort'`, is unchanged.
- A failure typed `rate_limit` that is also overloaded (a 529, or no status
  and `529` or `overloaded_error` in its message), which only another
  adapter's error can be, gets the overloaded attempt count, seven by
  default, or with `overloaded.maxRetries: 0` the base count, where it got
  the rate limit's five.
- A provider's stated wait is read as a number: one that isn't a number
  counts as none, where it gave a wait that ran at once.

## 0.7.0 — 2026-10-22

### Breaking

- **Callers without a retry layer of their own:** `retry.maxRetries` now
  defaults to 3 (it was 0). A 5xx, a provider's 408 or a connection failure
  before anything was delivered gets three attempts on the base schedule, with
  waits of 1 and 2 seconds, on every adapter. On `AnthropicAdapter` those three
  attempts were already made, inside its SDK client, and are now membrane's,
  counted in `details.timing.attempts` and cancellable; on the other adapters
  it was one attempt.
  - **Migration:** none, to keep a call working. `retry: { maxRetries: 1 }`
    keeps one attempt for these errors, and `retry: false` on a call turns off
    every retry the `retry` config schedules for it.
  - **Siblings:** connectome-host builds the `Membrane` its agents use, and
    its `main` depends on `^0.5.87`, which admits no 0.6.x. agent-framework
    and context-manager build none: their calls run on the `Membrane` their
    host passes in, so the host's range decides, whatever their own
    (`^0.5.87` and `^0.6.0` on their `main`s).
  - **Unchanged:** what a call whose first attempt succeeds sends and returns.
    A call that has delivered anything isn't retried after a failure.
- **Callers with a retry layer of their own,** such as a framework that
  retries its turns under a policy of its own: pass `retry: false` on each
  call. Otherwise membrane's schedules run inside each of your attempts, up to
  seven attempts at a 529 over five to ten minutes, and a stated wait of up to
  a minute is spent inside membrane, out of your layer's sight. That includes
  `streamYielding()`, which didn't retry before, and a 529 after a refusal
  re-issue, which gets a whole schedule again.
  - **Migration:** `retry: false` on `complete()`, `stream()` or
    `streamYielding()`. A failure then reaches you after one attempt, as it
    came, with `retryable` and any stated wait on `retryAfterMs`. Two sends
    stay: a refusal re-issue you ask for with `refusalRetries`, and a
    credential resolver's one resend after a 401. If your layer takes over
    capacity errors, give a 529 a schedule of its own: membrane's overloaded
    schedule waits a capacity storm out for minutes, and a few retries
    seconds apart end the call inside it.
  - **Siblings:** agent-framework retries its turns so, and context-manager's
    compression lane has a backoff of its own that also paces on a stated
    wait. connectome-host's subagent module restarts a failed subagent run,
    twice by default, 5 and then 10 seconds apart (after a 30-second cooldown
    first, for a rate limit), when its failure reads as a timeout, a network or
    server error, an overload, or a rate limit; that restart sits above
    agent-framework's attempts. None of the three passes `retry: false` on a
    call today. agent-framework and context-manager call through the
    `Membrane` their host passes in, and connectome-host, which builds it,
    depends on `^0.5.87` on its `main`, which admits no 0.6.x.
  - **Unchanged:** the error your layer receives, and how it is classified.
- **`hooks.onError` users:** it is now asked before each retry on
  `streamYielding()` too, and on every entry point its `attempt` counts the
  attempts at the failing request since its last refusal re-issue, the count
  the retry budget reads. It used to count every pass of the whole call,
  refusal re-issues included, so after a re-issue it now starts again from 1.
  - **Migration:** a hook that told the call's passes apart by `attempt`
    counts them itself.
  - **Siblings:** none of the three sets `hooks.onError`.
  - **Unchanged:** returning `'abort'` ends the call with the error.
- **`AnthropicAdapter` callers who relied on its SDK client's retries of a
  connect timeout:** a connect timeout now reaches you after one attempt, as
  a retryable `timeout`, where the SDK made three. The SDK reports a
  connect timeout the same way as a timeout on a request already sent, which
  membrane doesn't spend another deadline on.
  - **Migration:** retry a `timeout` yourself where a stalled connect is likely.
  - **Siblings:** connectome-host, which builds the `Membrane` the other two
    call through, depends on `^0.5.87`, which admits no 0.6.x.
  - **Unchanged:** on the other adapters, on Node, a connect timeout is
    retried like any connection failure.
- **Callers who relied on the 429 floor's five attempts:** an error whose
  stated wait (`retry-after`) is longer than a minute, or than its schedule's
  `maxRetryDelayMs` where that's longer, now reaches you at once, with the
  stated wait on `retryAfterMs`. Before, membrane waited only its own cap and
  sent the call again inside the window the provider had named, and
  `AnthropicAdapter`'s SDK client sent it again after its own short backoff. A
  stated wait of up to a minute is waited out, as the SDK waited out one under
  a minute, though the base schedule's own backoff stops at 30 seconds.
  - **Migration:** pace on `retryAfterMs`, or raise `retry.maxRetryDelayMs`
    to have longer stated waits waited out.
  - **Siblings:** connectome-host, which builds the `Membrane` the other two
    call through, depends on `^0.5.87`, which admits no 0.6.x.
  - **Unchanged:** a 429 that states no wait still gets five attempts.
- **Callers who build the `retry` config:** a field that isn't a finite number
  of at least 0 is now refused when the `Membrane` is constructed, with a
  `RangeError` naming the field (a `TypeError` for a value that isn't a
  number). A field given as `undefined` takes its default. Before, an explicit
  `undefined` replaced the default. As `maxRetries`, `undefined` and `NaN`
  meant no retries at all, a 429's and a 529's included. −1 and `null` meant
  none for other errors, as 0 does, while a 429 and a 529 kept their own
  schedules. `Infinity` meant retrying without end while the error lasted,
  and a numeric string was read as its number.
  - **Migration:** pass a finite number of at least 0, or leave the field out.
    A caller that passed `Infinity` to keep retrying chooses a bound, and one
    that passed `undefined` or `NaN` to turn every retry off passes
    `retry: false` on its calls.
  - **Siblings:** connectome-host, which builds the `Membrane` its agents use,
    already refuses a recipe's `agent.retry` by the same rule, so no recipe it
    loads today is refused here.
  - **Unchanged:** a config whose fields are finite numbers of at least 0, or
    absent.

- **TypeScript consumers:** `ContentBlock` gains `SystemChangeContent` (`type: 'system_change'`), and
  `ProviderMessage.role` gains `'system'`. Code that reads a property only some members declare, or that
  checks a switch over either for exhaustiveness, fails to type-check until it handles the new member.
  The type change itself changes nothing at run time.

### Added

- A per-call `retry` option on `complete()`, `stream()` and
  `streamYielding()`. With `false`, membrane retries none of the call's failed
  requests, whatever the error and whatever the `retry` config says: the 429
  floor and the `overloaded` schedule are off too. The failure reaches the
  caller as it came, with the provider's advice on it (`retryable`, and a
  stated wait on `retryAfterMs`), and `hooks.onError`, which is asked before
  each retry, isn't asked. It's for a caller whose own layer retries, such as
  an agent framework that retries its turns under a policy of its own and
  keeps a provider's stated waits. Two sends stay: a refusal re-issue, which
  a `complete()` call, or a `streamYielding()` call in native tool mode, asks
  for with `refusalRetries`, and the one resend with refreshed credentials
  that an adapter with a credential resolver makes after an HTTP 401. The
  default keeps membrane's retries.

- System changes: a message holding only `system_change` blocks (`SystemChangeContent`, with
  `removeTools`, `defineTools` and `addSystem`) changes the tools the model is offered and its system
  text from that point on, without editing `tools` or `system`, so the prompt cache before it holds.
  `NativeFormatter` and `AnthropicAdapter` send it as a mid-conversation `role: 'system'` message at the
  first point the API accepts, with the inline-tools beta when it changes tools. A request carrying one
  fails with `MembraneError.systemChangeRefused` set when no point after its place accepts it or the
  formatter or adapter is another, before anything is sent, and when the model takes no mid-conversation
  system message; a formatter that can't carry the request's tools at all refuses first, unflagged. A tool a change defines comes back under its own name when the model calls it. New
  optional members: `ProviderAdapter.sendsSystemChanges` (a decorator must forward it, or requests
  through it are refused) and `PrefillFormatter.rendersSystemChanges`.

- `thinking.display` takes `'updates'` (Anthropic beta `thinking-display-updates-2026-08-18`). On
  Fable 5 / 5.1, Mythos 5.1, Opus 5.5 and Sonnet 5.5 the notes the model writes between tool calls
  come back as signed `thinking` blocks before the `tool_use` they introduce, and under the default
  `'omitted'` their text is empty. With `'updates'` their text comes back, as a summary of each note,
  while reasoning stays hidden; any thinking block with non-empty text is such a note. `AnthropicAdapter`
  (header) and `BedrockAdapter` (`anthropic_beta`) add the beta whenever the body they send asks for
  `'updates'`, a thinking config passed through `extra` included. Fable and Mythos models, which get
  no thinking config for a display alone, get `{ type: 'adaptive', display: 'updates' }` for this
  one. New exports from `providers/anthropic`: `THINKING_DISPLAY_UPDATES_BETA` and
  `sendsDisplayUpdates`.
  - **Unchanged:** requests that don't set `'updates'`, including `'summarized'` or `'omitted'` alone
    on a Fable or Mythos model, which still send no thinking config.

### Changed

- Membrane is now the one layer that retries. `AnthropicAdapter`'s SDK client
  makes one attempt at each request membrane makes. Its own retries are off:
  two by default, inside each of membrane's attempts, on a 408, 409, 429 or
  5xx response and on a connection failure. So with `retry: false` membrane
  retries none of a call's failed requests: a failure reaches the caller
  after one attempt at the request that failed, inside which a credential
  resolver may resend once after a 401. A completed response's
  `details.timing.attempts` and `retryDelaysMs` count every attempt and every
  wait, none of them hidden inside the SDK. The keepalive's replays keep the
  SDK's default.
- What the SDK retried before delivery, membrane now retries on every adapter
  and entry point (see Breaking for the new default of `retry.maxRetries`). A
  409, which the SDK also retried, stays non-retryable unless the API's
  `x-should-retry` says otherwise: Anthropic's Messages API doesn't document
  it. With `overloaded.maxRetries: 0`, a 529 follows the base policy on every
  path; before, it wasn't retried on the streaming paths.
- A deadline that runs out on a request already sent isn't retried. The call
  still ends with a retryable `timeout`, which the caller may retry, but
  membrane doesn't spend another full deadline on it. That covers
  `AnthropicAdapter`'s idle and first-event watchdogs, the runtime's own
  fetch deadlines on the other adapters (undici's headers and body timeouts,
  300 s each by default; Bun's fetch timeout), and every timeout
  `AnthropicAdapter`'s SDK client reports, a connect timeout included (see
  Breaking). On the other adapters, on Node, a connect timeout
  (`UND_ERR_CONNECT_TIMEOUT`, `ETIMEDOUT`) is retried like any connection
  failure. Bun's fetch timeout doesn't say which stage ran out, so on Bun a
  stalled connect is left to the caller too.
- `AnthropicAdapter` reads the API's `x-should-retry` (it decides whether the
  error is retryable) and `retry-after-ms` (before `retry-after`), as the SDK
  did.

- The stripped-image note, which membrane writes in place of an image it
  can't send, now says so when the image came without its data, with no
  base64 data in its source or on the block (#139). Before, it gave the
  reason it gives for data that isn't an accepted image: "[system: an image
  that belongs here was NOT shown to you — its data is not a JPEG, PNG, GIF
  or WebP image, the formats this request can carry. You are not seeing this
  image. If it matters, ask for it in one of those formats.]", with the label
  the image came with after the formats where it had one, and the warning
  `[membrane] image block stripped: its data is not a JPEG, PNG, GIF or WebP
  image`. After: "[system: an image that belongs here was NOT shown to you —
  it came without its data. You are not seeing this image.]", with the
  warning `[membrane] image block stripped: no data`. Data that isn't an
  accepted image keeps the formats note. An image in MCP's form with empty
  data, or none, gets the new note wherever the same image in membrane's form
  does, at the top of a message as inside a `tool_result` (see Fixed). The
  Responses formatter's own note for a `tool_result` image it can't carry is
  unchanged. The first request after upgrading carries the new text where a
  history holds such an image under the formats note and membrane writes the
  note again, so a provider's prompt cache misses from that note on, once. An
  xml tool loop's result stored with its raw text replays the note its turn
  wrote.
- In an xml tool loop's results, an image at a URL a provider would fetch
  gets a note that says so and gives the link, where it got the formats note
  above (#139). After: "[system: an image that belongs here was NOT shown to
  you — it came as a link (https://…), which tool results here can't carry.
  You are not seeing this image.]", with the warning
  `[membrane] image block stripped: a URL source, which the XML tool path can't carry`.
  Only an http or https link is repeated, cut at 2,048 characters between
  code points; for any other URL, or one holding half a surrogate pair, which
  the API refuses in a request's JSON, the note leaves out the parenthesis. A
  URL source that also carries data is such an image too: the split that
  sends a result's images sent that data as an image, where the native path
  reads the image at its URL. A split round stored before this change, whose
  result held one, replays without that image; when it was the only image
  the split sent, the round's report says the message was altered, and
  otherwise nothing says so.
- In an xml tool loop's results, an image in a `data:` URL is decided by its
  bytes, as the native path decides it, where it got the formats note above
  (#139): the split sends an accepted one, the results without a split give
  its `[Image: …]` note, and any other gets the note its bytes call for. A
  split round stored before this change, whose result held one beside an
  image the split sent, replays with it sent too, beside the formats note
  that turn wrote, and nothing reports it.
- A stored tool result that xml tool mode re-renders without its raw text
  keeps an image with a URL source, and gives it the note the live results
  give: the link note, or for a `data:` URL, what its bytes call for (#139).
  Before, it left the image out with no note. The first request after
  upgrading carries that note where a history holds such a result, so a
  provider's prompt cache misses from there on, once.

### Fixed

- `streamYielding()` now retries a provider call that fails with a retryable
  error before it has delivered anything, on the native and XML paths: the
  `overloaded` schedule for a 529, the base schedule for the rest, with a
  five-attempt floor for a 429. Before, it had no retry at all, and the first
  529 ended the turn (#118). A call that has delivered anything is still not
  retried, since that would replay what the caller already has.
- `stream()` and `streamYielding()` retry such a call in any round of a tool
  loop. `stream()` used to retry only until anything had been emitted, so a
  529 on the call after a tool round ended the turn. The retry now happens
  inside each provider call, so the `beforeRequest` hook and the cache wire
  receipt run once for the round, as they do for `streamYielding()`'s refusal
  re-issue, and a cancellation during a later round's wait returns an
  `AbortedResponse` with what the earlier rounds delivered. A completed
  response's `details.timing.attempts` counts every attempt, retries included,
  and `streamYielding()`'s and `complete()`'s now carry
  `details.timing.retryDelaysMs` too, listing the waits, as `stream()`'s does.
- A retry wait longer than about 24.8 days (2^31 − 1 ms), which a stated wait
  or a backoff can be under a very large `retry.maxRetryDelayMs`, is waited in
  full. It fired after 1 ms, so the call was sent again at once, for a stated
  wait inside the window the provider had named.
- On `complete()`, a refusal re-issue (`refusalRetries`) no longer spends the
  retry budget for transport errors: after a re-issue, a 529 or 429 gets the
  whole schedule again, as it does on the streaming paths.

- Media in MCP's form, `{ type: 'image', data, mimeType }` with no `source`,
  is now carried as the same media in membrane's form is,
  `{ type, source: { type: 'base64', data, mediaType } }`, for an image,
  document, audio clip or video (#139). An image converts whatever its data
  and label, and is then read as any image is: a request that sends an image
  decides it by its data's header, and one with data that is missing or empty
  gets the note that it came without its data wherever the same image in
  membrane's form gets it (see Changed). A document, audio clip or video
  converts only with data that isn't empty and a `mimeType` that
  isn't empty. A media block with neither `data` nor `mimeType` isn't MCP's
  form and stays as it came; `toAnthropicContent` and `transformToChat` leave
  out such an image, where they threw a TypeError. Membrane converts MCP's
  form wherever it takes content: the messages of `complete()`, `stream()`
  and `streamYielding()`, rebuilt each round of a native tool loop; the
  messages a caller hands `AnthropicXmlFormatter`, `NativeFormatter` or
  `OpenAIResponsesFormatter` directly; the request built directly by each
  adapter that reads membrane's content blocks, `AnthropicAdapter`,
  `BedrockAdapter`, `OpenAIAdapter`, `OpenAICompatibleAdapter`,
  `OpenRouterAdapter`, `GeminiAdapter`, the image adapter
  `OpenAIResponsesAdapter`, and `OpenAIResponsesAPIAdapter` in subscription
  mode; and the exported `toAnthropicContent` and `transformToChat`. An xml
  tool loop's results, which `formatToolResults` and the split that sends a
  result's images render each round, already read an image in MCP's form by
  its data.
  The block keeps its other fields, apart from MCP's `annotations` and
  `_meta`, which no request carries. The caller's messages and the executor's
  results stay as they were, and a round's report names what it would for the
  same media in membrane's form. Inside a `tool_result`, the anthropic-xml and
  native formatters already read such an image by its data, and send it as
  before, and the Responses formatter now sends it, where it gave its note
  that the request couldn't carry it. Before:
  - at the top of a message, the anthropic-xml formatter in either tool mode,
    the native formatter and the Responses formatter threw a TypeError on
    such an image, and the anthropic-xml formatter in native tool mode and
    the native formatter on such audio;
  - `AnthropicAdapter`'s request built directly threw on one in a
    `tool_result`, and sent one at the top of a message as it was, with no
    source, which the API refuses;
  - `BedrockAdapter`'s request built directly sent one as it was, at the top
    of a message and in a `tool_result`, which the API refuses;
  - the requests built directly by `OpenAIAdapter`, `OpenAICompatibleAdapter`,
    `OpenRouterAdapter` and `GeminiAdapter` left such an image at the top of
    a message out, with no note and no report, `OpenAIResponsesAdapter`
    attached none to an image edit, and the one `OpenAIResponsesAPIAdapter`
    built in subscription mode left it out and reported its message altered,
    and gave one in a `tool_result` the note for an image it can't carry;
  - `toAnthropicContent` threw a TypeError on such an image, at the top of
    the turn and in a `tool_result`, and on such a document at the top, and
    `transformToChat` threw one on such an image at the top of a message.
- A document, audio clip or video in MCP's form that doesn't convert, with
  no `data`, empty `data` or no `mimeType`, is a source membrane's request
  builds can't represent, as a URL image is where they have no branch for
  one: at the top of a message they leave it out with no note and report its
  message altered (#139). Before, the native formatter, and the anthropic-xml
  formatter in native tool mode, threw a TypeError on such audio there, and
  the requests `AnthropicAdapter` and `BedrockAdapter` built directly sent it
  as it was, with no source, which the API refuses. A document, or audio in
  xml tool mode, still meets `unsupportedMedia` at the top of a message, as
  in membrane's form. `toAnthropicContent` leaves out such a document, where
  it threw a TypeError, and gives such audio or video the error it gives
  audio or video in membrane's form. Inside a `tool_result` the xml renderers
  leave it out, and the native formatter passes it on, which the Anthropic
  adapter leaves out as it does any block it has no tool-result form for, as
  before; `BedrockAdapter`'s request built directly now leaves it out there
  too and reports the result, where it sent it as it was. A message the
  Anthropic or Bedrock adapter's direct build leaves with no block is
  dropped, as the build drops any message it leaves empty, and where dropping
  it would change the request's final role, the build refuses.
- An image in a base64 `data:` URL whose payload escapes characters, such as
  its padding as `%3D`, is percent-decoded before its bytes are read, as the
  fetch spec's `data:` URL processor decodes it, wherever membrane reads a
  `data:` URL image (#153). Before, `AnthropicAdapter`'s request sent the
  escaped text as the image's base64 data, which isn't base64, and the OpenAI,
  OpenAI-compatible and OpenRouter requests sent the URL with its escapes.

- XML tool instructions no longer mark a parameter `nullable="true"` when
  its type admits null but an `enum` or `const` beside that type leaves null
  out (#150). Before, a type list naming null, or OpenAPI's `nullable: true`,
  marked the parameter whatever else the schema said, so
  `{type: ["string", "null"], enum: ["a", "b"]}` told the model it could send
  a null the schema doesn't accept. This also applies where such a type sits
  behind a `$ref`, in an `anyOf`, `oneOf` or `allOf` branch, or in a root
  alternative, and where the keyword beside the type that leaves null out is
  a combinator or a `$ref`. A parameter stays marked where null survives the
  combination: in at least one branch of an `anyOf` or `oneOf`, or in every
  branch of an `allOf`. The parse is unchanged, so a written `null` for such
  a parameter still follows the type. In the same instructions a null enum
  member now prints as `null` (`enum="a,b,null"`); before, it printed as an
  empty item (`enum="a,b,"`).

- Streamed tool calls whose `tool_calls` entries carry no `index` (absent or
  `null`), as some OpenAI-compatible servers are reported to send them, are
  no longer merged into one call (#159). The OpenAI, OpenAI-compatible and
  OpenRouter adapters put every such entry in the call at index 0, so a
  second call's id and name replaced the first's and their arguments ran
  together. Now an entry with no `index` never takes an index's slot. It
  joins the call that already has its id, or failing that the call the last
  entry went to, unless it carries a name and a new id while that call has an
  id; then it starts a new call. Calls without an index come after those with
  one, in the order they started. Entries with an `index` go to their slots
  as before. In a slot, a piece continues the latest call there that has its
  id, or else the last call there. One that carries the id of a call that
  began without an index, when no call in the slot has it, moves that call
  into its slot, unless it names another tool.
- On the same three adapters, with or without an `index`, a piece that names
  a tool other than its call's starts a call of its own, and a call keeps the
  first id a piece gives it. A later piece's name and id replaced the call's,
  so two calls of different tools that a server put in one slot, or gave one
  id, came back as one call under the later name and id, with their arguments
  run together. They now come back as two calls, each with its own arguments.
  An entry that carries no id, name or arguments is dropped, with or without
  an `index`; one with an `index` opened an empty call. A stream that gives
  each call its own `index` and sends each call's id and name once, with no
  two calls under one id, comes back as before.
- Every streamed tool call in a response comes back under an id of its own,
  on the same three adapters. A call with no id comes back as `call_<n>`,
  from `call_1`, and one whose id an earlier call in the response already has
  as `<id>_<n>`, from `<id>_2`, and a `[membrane]` warning names each. A call
  with no id came back with `''`, which no tool result can answer: the
  adapters send it back as `""` or as no `tool_call_id` at all. Two calls
  under one id, as these adapters returned for two calls in their own slots
  that a server gave one id or none, made the native formatter's tool-pair
  check refuse the turn that held them.
- Four kinds of stream that came back as one call now come back as several:
  one call whose every piece repeats its name and changes its id, as one call
  per such piece; one whose first piece has no `index` and whose later pieces
  carry index 0 without its id, as two; one call that a later piece renames
  midway through its arguments, as two whose halves don't parse; and a piece
  that carries one call's id and names another call's tool, as a call of its
  own, so that tool comes back twice. In the first kind, a first piece with
  no arguments becomes an extra call with `{}`, and in the last, the other
  call comes back with `{}` when it has no arguments of its own. As before,
  these adapters merge two calls of the same tool sent with no ids or with
  their names before their ids, distinct calls of one tool given the same id
  or put in one slot, and a call whose first piece has its id but no name
  into the call before it. When the earlier call's arguments are empty, the
  merged call parses, and in the last case it runs the earlier call's tool
  with the later call's arguments.

- **Gemini adapter: a tool's schema is sent as JSON Schema (#185).** `GeminiAdapter` sent each tool's `inputSchema` as the function declaration's `parameters`, which Google's API reference describes as a `Schema` reflecting OpenAPI 3.0.3. The adapter now sends the schema unchanged as `parametersJsonSchema`, which the reference describes as JSON Schema, on `complete()` and `stream()` alike. Through Google's Code Assist endpoint, a `parameters` schema with a type array such as `["string", "null"]`, or with `$schema`, `$defs`, `$ref` or `const`, was refused, failing the whole `generateContent` call. The public API wasn't run. A tool with no schema still gets `{ type: "object", properties: {} }`.
  - Every tool declaration's bytes change, so the first request after upgrading doesn't read a prompt cache written before it.
  - A schema that uses OpenAPI's `nullable: true` is sent as written. Through Code Assist, Gemini accepted it under `parametersJsonSchema`, but whether it still lets such a field take null there hasn't been shown. JSON Schema's own spelling, a type array with `"null"`, is the one this field defines.

- **`AnthropicAdapter` keeps a default `anthropic-beta` header as the SDK sends it** when it adds a
  beta of its own for one request, reading `defaultHeaders` as the SDK's `buildHeaders` does. It used
  to read only a string: a default given as an array was dropped, so the request went out with the
  adapter's beta alone; of entries rows, only the first string row was kept; and of keys differing
  only in case, the first with a string was kept, where for the SDK a later key that carries a value
  replaces it, and a later `null` clears it.

- `blockBinding`'s doc no longer implies that a request that sends no
  thinking config holds no thinking that binds. On 2026-10-19 Claude Opus 5.5
  and 5, Sonnet 5.5 and 5, and Haiku 5.5 each returned a signed thinking block
  to a request with no thinking config, and the thinking of Opus 5.5, Sonnet
  5.5 and Haiku 5.5 binds: on an account that enforces the binding, a reply
  from them replayed after its tool list changed was refused with a 400 when
  the request carried no thinking config. The doc now says so, and that a
  caller who wants the controls on such a model, in a request that doesn't
  end in an assistant prefill, sets `blockBinding` and asks for adaptive
  thinking (`enabled: true`, `type: 'adaptive'`, and `display: 'omitted'`, so
  the block comes back signature only, as it did with no config), which those
  three accepted with the binding in place of no config. As with any thinking
  config other than `disabled`, the Anthropic adapter then sends none of the
  caller's `temperature` or `topK`, and no `topP` below 0.95; the Bedrock
  adapter sends `temperature` 1 and the caller's `topK`. The doc also says
  that Fable and Mythos carry the binding when an enabled budget can't fit, as
  they do with thinking disabled, and `RoundReport.thinking`'s doc now says
  the provider's report comes back when the request carries the binding. What
  membrane sends is unchanged.

- An error from the caller's own code that membrane runs beside a call is no
  longer resent (#160). That code is the `beforeRequest`, `afterResponse`,
  `onError` and `onNormalize` hooks, `onRequest`, `onResponse` and
  `stream()`'s callbacks, a request's `onCacheWireReceipt`, the Anthropic
  adapter's `dynamicHeaders`, the configured logger's `warn()` and a
  registry's `getPricing()`, and a resend of the request can't mend it. The
  call now ends at once with a `MembraneError` whose `retryable` is `false`:
  the caller's own if it already said so, or else a new one classified from
  its error as before, with that error as its `cause` and no `httpStatus`,
  `providerErrorCode` or `retryAfterMs`, since no response to this call
  stands behind them, nor a wrapped `MembraneError`'s `rawError` or
  `rawRequest`, which would be another call's. What builds, sends or reads
  the call keeps its classification: an adapter and the transport, a
  credential resolver, a formatter and its parser. Before:
  - An error that read like a rate limit made `complete()` send the request
    up to five times when it came from `onResponse`, `afterResponse`, the
    logger or the registry, paying again for a response that had already
    arrived.
  - Thrown before the send, it made `complete()` and `stream()` run the hook
    or callback again on each attempt.
  - Thrown after `stream()` had emitted, it ended the call but still said
    `retryable: true`, unless the adapter's stream handler caught it (see
    the entry on stream callbacks), and what the `onError` hook threw left
    as it was. Either way, a caller's policy could resend the request.
- **`AbortError`:** an error the caller's code throws named `AbortError`
  keeps the type `abort`, so membrane treats it as any other abort thrown at
  the same point, as it did before.
- **`streamYielding()` consumers:** an error the caller's code throws, such
  as a `beforeRequest` hook's or an `onCacheWireReceipt` consumer's, now
  reaches the `error` event as that `MembraneError`, where it used to be the
  caller's own error. The caller's error is its `cause`, unless it was a
  `MembraneError` that already said `retryable: false` and arrives as itself.
- **Responses adapter, subscription mode:** an `onFastModeFallback` that
  throws is now logged with `console.warn`, and the response stands. Its
  error used to trigger a second request, which didn't call it again, so the
  error was lost.

- Claude Haiku 5.5 (`claude-haiku-5-5`) is listed as refusing an assistant
  prefill, so a build that ends in one for it fails in membrane, with the
  typed error that names native tool mode, rather than at the API. The
  Messages API answered such a request with a 400, with no thinking config
  and with an adaptive or an enabled one: "This model does not support
  assistant message prefill. The conversation must end with a user message."
- The default pricing table gives Claude Opus 5.5, Sonnet 5.5, Fable 5.1,
  Mythos 5.1, Mythos 5 and Haiku 5.5 the rates Anthropic's price page lists
  on 2026-10-19. Opus 5.5, Sonnet 5.5 and Fable 5.1 had matched their
  family's shorter prefix and taken its rate: Opus 5.5 $5/$25, $6.25 for a
  5-minute write and $0.50 for a cache hit, where the page gives $4/$20, $5
  and $0.20; Sonnet 5.5's hits $0.20 for $0.10; Fable 5.1's $1 for $0.25.
  Mythos 5 and 5.1 and Haiku 5.5 had no rate. So where no `ModelRegistry`
  supplies pricing, a response's `usage.estimatedCost` falls for Opus 5.5
  and for those cache hits, and Haiku 5.5, Mythos 5 and Mythos 5.1 responses
  carry a cost instead of the unpriced warning. Haiku 5.5 takes its rate for
  prompts up to 100,000 tokens, since the table has no field for the higher
  rate above that, so a longer prompt is priced low. Every Anthropic row the
  page lists is dated 2026-10-19, which callers see as `pricingAsOf`.

- The Anthropic adapter leaves `temperature`, `top_p` and `top_k` out of a
  request to Claude Haiku 5.5 (`claude-haiku-5-5`), as it already does for
  the other models that refuse them. With no thinking config, the Messages
  API refused `temperature` 0.2, `top_k` 40, and `top_p` 0.9 and 0.95 with
  a 400 ("`temperature` is deprecated for this model", and likewise for the
  others). A `top_p` of 0.99, which Haiku 5.5 accepted, is left out too, as
  for the other listed models.

- **Responses API function tools now always state `strict`.** Every function
  tool the `openai-responses-api` adapter converts, in API-key and
  subscription modes, carries a boolean `strict`: an omitted or `null` value
  is sent as `false`, and an explicit `true` or `false` is kept. Previously
  `strict` was left out unless the caller set it, which handed validation to
  the provider's default; strict validation treats every property as one the
  model must send, so optional parameters of plain JSON Schema tools could
  reach the model as required. With `strict: false`, the model's arguments
  are no longer constrained to the schema as it generates them (`required`,
  `enum` and `type` included), so a tool's handler validates them as plain
  JSON Schema, as Chat Completions tools already were. This applies to flat
  Responses functions, nested Chat-style `{ type: 'function', function }`
  tools (whose `strict` is read from the function, or from the wrapper when
  the function's is omitted or `null`) and tools built from
  `inputSchema`/`input_schema`/`parameters`, whether they came as
  `request.tools` or as a `providerParams.tools` override of them. A
  `strict` that is not a boolean, `null` or absent (such as the string
  `'true'`, `1` or an object) used to be forwarded to the provider as given,
  or dropped where a Chat-style tool wrote it beside `function`; it is now
  refused with an `invalid_request` error naming the tool, before any request
  is sent.
  - **What changes on the wire:** a function tool that lacked a boolean
    `strict` now carries `strict: false`, or, for a Chat-style tool whose
    wrapper carries a boolean `strict`, which used to be dropped, that
    boolean. So the serialized tools change, and a prompt prefix cached
    before the upgrade that includes them no longer matches. A
    `providerParams.tools` entry in a membrane or Chat shape is now
    converted to a flat Responses tool, so its bytes change too; it wasn't a
    valid Responses tool before.
  - **Unchanged:** non-function tools, and container tools such as a
    Responses namespace tool, pass through as the caller wrote them, member
    functions included. Flat Responses functions that already carried a
    boolean `strict` serialize as before. The Chat Completions and
    openai-compatible adapters are unchanged.
  - Thanks to `@HO-git`, whose #105 found the same bug and verified it live.

- XML tool instructions no longer print an `enum` list the model can't split
  exactly (#176). Where any of a parameter's values holds `"`, `,`, a control
  character (a line break or a tab among them), a line or paragraph
  separator or a lone surrogate, or is empty, or has whitespace at either
  end, the parameter's line shows no `enum` at all, and keeps its type and
  description. Every other list prints as before, unescaped, since the
  parser doesn't decode entities in a value the model writes.
  `toolDefinitionForPrompt` still returns every value.

- XML tool instructions now list a parameter's values from more of its
  schema, where before they listed only an `enum` on the first node that
  declares the parameter. An enum behind a `$ref`, as pydantic writes an
  `Enum` field, an `anyOf` of an enum and `{type: "null"}`, as pydantic and
  zod write a nullable enum, enums in `anyOf`, `oneOf` or `allOf` branches,
  enums across root alternatives, and a `const` now render as
  `enum="..."`. Values are listed in schema order, each once, and null only
  where the parameter is marked `nullable="true"`. A nested `oneOf` lists
  only the values exactly one of its branches admits. No list comes from a
  union where a branch, or a root alternative that declares the parameter,
  also takes values outside it, and none is shown where a `$ref` cycles or
  doesn't resolve, or where a listed value is an object or an array. Where
  these rules differ from the first declaring node's own `enum`, the list
  shown before changes: another declaring node can narrow it, values of
  kinds the schema's types exclude are left out, and an empty list renders
  no `enum` attribute. `toolDefinitionForPrompt` returns this list in
  `enum`, each value as a string, as its type says.

- **In the native tool loop, the floating cache marker's second mark goes on the message before the assistant turn that made the round's calls.** With an assistant-role message injected with a round's results, it used to go on the round's assistant turn, the third message from the end, so the provider's ~20-block backward search had to cross that turn's blocks to reach the previous request's cache entry. It now goes on the previous request's last message.
  - **When the previous request itself ended with an assistant message,** that message joins the new assistant turn, and the mark goes on the message before the turn. The previous request didn't mark that message, so only the newest mark's search reaches its cache entry. When another assistant-role message is injected with the results, the mark used to go on the turn the previous request's last message joined.
  - **Otherwise,** through `NativeFormatter`, the mark is where it was: with nothing injected, or a user-role message.

- `gemini` reads a `null` `blockReason` as no block, and a candidate whose
  content and finish reason are `null` or absent as no candidate, on both
  paths. Gemini's API speaks proto3's JSON mapping, where a `null` field is
  unset.
  - A non-streamed response with no candidates and a `null` `blockReason` was
    a `refusal`. It's now an empty `end_turn`.
  - A stream whose frames give only a `null` `blockReason` was a `refusal`. It
    now fails as a stream with nothing in it does, with membrane's retryable
    error for a stream that ended before a terminal event, so membrane can
    send the request again.
  - A later stream frame with a `null` `blockReason` replaced the reason an
    earlier frame gave, so the stop carried no provider reason. The earlier
    reason now stands, and the stop's provider reason carries it.
  - Beside a blocked prompt, a candidate with no data failed a stream as one
    cut short where its content or finish reason was `null`, and read as an
    empty `end_turn` in a non-streamed response. It's now a `refusal` on both
    paths, with the block's reason as the provider reason, as a block with no
    candidates is. A candidate with content or a finish reason still wins over
    a block, as before.

- The Anthropic adapter's cache keepalive now holds a request only once the
  provider is known to have started its message: at `message_start` in a
  stream, and once the SDK has the response in `complete()`. It recorded
  each request before sending it, so a request the provider refused for what
  its prefix holds, such as a prompt longer than the model's context, was
  the one replayed, and its replays were refused too. Three refresh failures
  in a row turn the keepalive off for every lineage for the rest of the
  adapter's life, so one refused request could leave every lineage's next
  call after an idle hour writing its prefix again. A call that failed
  before its message started, such as one never delivered, also took the
  place of the request the provider had cached, and the day ran from it: its
  first replay paid to write whatever of it, up to its one-hour marker, the
  provider hadn't cached, which the next real call would otherwise have
  written. Now a call that fails before its message starts leaves its
  lineage's earlier snapshot, and the day measured from it, as they were.
  One cost: a call no longer marks its lineage touched until its message
  starts, so a refresh can fall due while the call waits for its first event
  and replay the earlier snapshot, once per 45 minutes of that wait. In
  `complete()`, where the keepalive is opt-in, the wait is the whole call. A
  refresh's effect on a lineage now stays with the snapshot it replayed.
  While a replay was out, a real call could record a newer request for its
  lineage, which a second ineffective refresh in a row then dropped, and a
  tick could go on to replay a snapshot that a real call had replaced, or
  that had been dropped, since the tick began. A failed refresh still counts
  toward the breaker, which stops the keepalive for every lineage.

- The Anthropic adapter's cache keepalive now replays a request only through
  its last one-hour cache marker and the end of the user turn at or after it,
  so that a refresh doesn't split a tool call's results or end on an assistant
  message unless the request did. A request with no user message at or after
  that marker is replayed whole. It replayed the whole request every time, and
  whatever followed the last one-hour marker was billed as input on every
  refresh, or written again where a five-minute marker covered it, though no
  cache entry the refresh kept warm held it. Under `cacheMarkers: 'cm-owned'`,
  membrane places no marker on a tool loop's rounds, so a tool-using turn's
  last request carries its rounds after the last marker, and after such a
  turn each refresh paid for them again, every 45 minutes by default for up to
  a day. A refresh now reads the same cache entries without that cost. A
  five-minute marker in what's left out goes with it: each refresh wrote its
  expired entry again, and after two such refreshes the lineage was dropped.

- **A native tool call's `block_complete` event carries the tool's name as the caller gave it.** For
  a tool whose name has a colon, the event carried the escaped wire name (`srv__get_weather` for
  `srv:get_weather`), unlike the returned content and tool calls.

- `openai-completions` and `gemini` read a `null` finish reason as no reason,
  a plain `end_turn`, as `openai`, `openai-compatible` and `openrouter`
  already did. They returned the `null` as their stop reason, and membrane's
  log line for an unmapped stop reason read its `length`, so the first
  non-streamed `complete()` in a process that met one failed with a
  `MembraneError`, "Cannot read properties of null (reading 'length')".
  Each stream reads a finish reason only when it's truthy, so a `null` or
  empty one is none there and never reached the mapper. A non-streamed
  response's empty finish reason is still passed on as an unmapped stop
  reason, as in the other three.
- Membrane's log line for an unmapped stop reason can't fail the call. An
  adapter can return a stop reason outside its type, passing on a server's
  value or written in JavaScript, and one the line couldn't print, such as
  `null`, `undefined` or a bigint, failed the first call that met it. The
  line now prints a number, `null` or `undefined` by its value and anything
  else but a string by its kind, such as `object (not a string)`. Such a
  stop reason still normalizes to `end_turn`. It's logged once by what the
  line prints, so an object an adapter returns fresh on every response is
  logged once.
- The line, and the one printed once 64 reasons are logged, say that
  `details.stop.providerReason` carries the adapter's `providerStopReason`
  if that's a non-empty string, else the stop reason if it's one. They said
  it carried any stop reason the adapter gave without a
  `providerStopReason`. `ProviderResponse.providerStopReason`'s doc says
  the same now.

- A stream callback's error is no longer swallowed (#117). The OpenAI,
  OpenAI-compatible, OpenAI completions and OpenRouter adapters ignored an
  error thrown by `onChunk` (or, on OpenRouter, `onContentBlock`), and the
  Bedrock adapter logged it as a malformed event and skipped it, so the stream
  finished as if nothing had happened. Now the error fails the stream through
  the adapter's error boundary, as it already did on the Anthropic, Gemini and
  Responses API adapters. The provider's response body is cancelled rather
  than left unread, on Gemini too. The error is typed by `classifyError` like
  any other, a plain `Error` by its message: most are `unknown`, while one
  whose code reads as a network failure, such as `EPIPE` from a callback
  writing to a closed pipe, is typed `network`. Called on an adapter directly,
  such an error is retryable; through `Membrane` it isn't, as no error from
  the caller's code is (see the entry on the caller's code). With stop
  sequences, text held back for a possible stop isn't handed to a callback
  that has thrown.
- What these adapters can't read is still dropped. A data line that isn't
  JSON, or whose JSON isn't an object (`null`, a number, a string, an array),
  drops its frame, on Gemini and the Responses API too, where `data: null`
  failed the stream. A frame whose JSON isn't an object no longer renews the
  progress deadline (`progressTimeoutMs`), and a Bedrock event that decodes to
  such JSON doesn't either. In 0.6.0 every SSE data frame that parsed renewed
  it, and so did every Bedrock event that decoded, other than a `ping` and one
  that decoded to `null`. On the OpenAI, OpenAI-compatible and OpenRouter
  adapters, a `tool_calls` that isn't an array drops its tool calls, and an
  entry that isn't an object, or whose `index` isn't an array index (an
  integer from 0 to 2^32 - 2, or its decimal string with no leading zero)
  and isn't absent or `null`, drops that entry; the rest of the frame is
  read. The calls placed are gathered in index order, so a first call at index
  1, or one after a dropped entry, no longer fails the response. A number
  entry used to become an empty tool call. On Bedrock, an event that doesn't
  decode, or decodes to `null`, is skipped with a warning, as before, and so
  is a block start or stop whose index or block can't be placed. When a
  skipped block start leaves the message without a block before later ones,
  the call fails as a retryable `network` error naming that block. Where the
  start's index named no slot, or its block was `null`, the call failed with a
  `TypeError`; where its block was another value that isn't an object, it
  returned the message without that block. An event that carries no `bytes`
  (the field missing or empty), which was skipped silently, and one that
  decodes to other JSON that isn't an object, which was read as nothing, are
  now skipped with the warning too.
- **Provider adapters:** `onProgress`'s doc now says a streaming adapter calls
  it for an SSE data frame only when the frame parses to a JSON object, and
  for an event-stream message only when it decodes to one. A custom adapter
  that follows 0.6.0's wording, each SSE data frame that parses and each
  decoded event-stream message, still renews the progress deadline on a frame
  or message whose JSON is `null`, a number, a string or an array. To match
  the built-in adapters, drop such a frame or message before calling
  `onProgress`.

- A cancelled `streamYielding()` stream now ends at its `aborted` event, as
  `cancel()`'s documentation says: no event of any kind follows it. A loop
  that resumed because a wait had already resolved, from results passed to
  `provideToolResults()` just before the cancel or a provider response that
  crossed the abort, could deliver `block`, `tokens`, `usage`, `tool-calls`
  or a late `complete` after it. Its next tool wait is now refused at once, so
  the loop finishes instead of waiting for results that will never come. A
  round whose response arrives after the cancel isn't reported, its usage
  included. A `cancel()` that comes after the stream has queued its own
  `complete`, `error` or `aborted` adds no event, and that event stays the
  stream's last.

- A cancelled `streamYielding()` turn keeps what it had (#142). Its `aborted`
  event, from `cancel()` or from the caller's `AbortSignal`, now carries
  `partialContent`, `rawAssistantText`, `toolCalls` and `toolResults`, built
  the way a provider or deadline abort's event builds them. Before, it carried
  none of them. A round whose tools were still running shows its calls with no
  results. So does a round whose results were passed to `provideToolResults()`
  just before the cancel, since the turn hadn't recorded them yet.

## 0.6.0 — 2026-10-18

### Breaking

- **Anyone running membrane on a Node before 22.12:** membrane now declares `engines.node` `>=22.12.0`, where it declared `>=20.0.0`, and CI tests at Node 22.12.0 exactly, at 24 and at the newest Node, where it tested the newest 20.x and 24. Node 20 reached end of life on 2026-04-30. npm warns when it installs membrane on an older Node, and refuses only with `engine-strict` set. Nothing in membrane's code changes with this; older Node versions are simply no longer tested.
  - **Migration:** run Node 22.12 or later.
  - **Siblings:** no released sibling's range admits this release: context-manager 0.14.1 depends on `^0.5.69`, and agent-framework 0.22.1 and connectome-host 0.10.2 on `^0.5.87`, so their installs keep getting 0.5.x. A sibling takes on this floor when it raises its range.
  - **Unchanged:** membrane's API, its output, and what it sends to providers.

### Added

- Add `progressTimeoutMs` to `stream()`, `streamYielding()` and `complete()` options: a per-provider-call deadline that only progress renews (default off; a value that isn't a positive number of milliseconds leaves it off too). Every parsed provider event renews it: an SDK event, an SSE data frame that parses, a decoded Bedrock event. SSE comments, Anthropic and Bedrock `ping`s and raw body bytes don't. So a connection that stays up while the model sends nothing still ends, on every adapter, at a deadline the caller sets per call. Each provider call gets its own deadline, refusal re-issues included, and time between calls, such as tool execution or the yielding tool wait, never counts. It bounds the wait for the first event too, and silence is measured on the monotonic clock, so a step of the system clock moves no expiry. A stretch with no parsed event counts as no progress whatever the model is doing: reasoning a provider doesn't stream, while it sends only keepalives, can expire the deadline, so set it above the longest such stretch you expect. Anthropic models whose thinking streams with `display: "omitted"` send no deltas while they think, which can last minutes. A call that streams no events reports no progress before its response, so the deadline bounds it as a whole: `complete()` on most adapters, and `OpenAIResponsesAdapter` (the Images API) even from `stream()`. `OpenAIResponsesAPIAdapter` in subscription mode answers `complete()` by streaming, so there its events renew the deadline. On expiry the call aborts as a `TimeoutAbortError`: `stream()` returns `AbortedResponse{ reason: 'timeout' }`, `streamYielding()` emits `aborted` with reason `'timeout'`, and `complete()` throws. Its message names the deadline and says when the call began, how many provider events it had and when the last came, for example `No provider progress within 1800000ms: the call began at 2026-10-14T12:00:00.000Z, provider events: 412, the last at 2026-10-14T12:04:10.250Z`. With the option unset, adapters receive the same options as before.
- **Provider adapters and decorators:** `ProviderRequestOptions` gains `onProgress`. A streaming adapter calls `options.onProgress?.()` once per parsed provider event, never for keepalives, comments or raw bytes; the built-in streaming adapters and `MockAdapter` do. A decorator must forward `onProgress` with the other options. An adapter or decorator that never calls it turns `progressTimeoutMs` into a total deadline for its calls. The deadline aborts the call's signal with the same mark as `timeoutMs`, so an adapter that maps `isDeadlineAbort` to `deadlineTimeoutError` needs no new error path. The Anthropic adapter now does that mapping for its caller's signal on both `stream()` and `complete()`.

- Yielding streams report each provider round that stands. The `usage`
  event carries `round` (`RoundReport`) with the round's index, mapped stop
  reason and own usage, and `altered`: the consumer messages that round's
  request did not carry verbatim. Messages are addressed by
  `NormalizedRequest.messages` index, and injected messages as
  `[batch, index]` into the array as supplied, for every batch still
  retained; tool blocks stripped from an injected message make it altered.
  `fidelity` is `unknown` whenever an empty list would prove nothing: an
  uninstrumented formatter or adapter, an image opt-in shedding replaced, a
  `beforeRequest` hook that changed either of its arguments (the provider
  request by replacement or in place, or the normalized request in place;
  an in-place change keeps every later round `unknown` too), or an adapter
  alteration that could not be attributed. Otherwise it is `established`.
  `injectedBatch` gives the newest batch and how many of its supplied
  positions the round accounts for: all of them on the native path, none on
  the XML prefill path. With established fidelity, each was carried
  verbatim unless `altered` names it, as it names a message whose tool
  blocks were stripped even when nothing else of it was sent.
  `ToolContext.supportsInjectedMessages` says which path applies.
- **Formatters and provider adapters:** `PrefillFormatter.reportsAlterations`
  and `ProviderAdapter.reportsContentAlterations` declare that a path reports
  what it does not carry verbatim. Formatters record alterations in
  `BuildOptions.fidelity`. Adapters call the new
  `ProviderRequestOptions.onContentAltered`, which decorators must forward,
  along with the capability. All built-in formatters, and the Anthropic,
  Bedrock, Responses API and mock adapters, declare it; an undeclared path
  makes rounds `unknown`.
- **Raw forms:** where a path sends a provider-native raw form in place of
  the fields it stands in for (on the OpenAI Responses formatter, a block's
  `rawItem` and a message's `openaiResponsesItems`; in the Responses API
  adapter, a `redacted_thinking` block's reasoning `rawItem`; on the XML
  prefill path, `rawXml`), that raw form is what the round carries. The
  block or message counts as carried verbatim when its raw form is, and the
  fields it stands in for are not compared with it, so a consumer that edits
  content under a raw form must drop or replace the raw form, or the edit
  doesn't reach the provider. Blocks whose items share a type and id are one
  item, sent once, and a block whose item differs under the same key isn't
  carried. A zero-width carrier (`''` text holding an object `rawItem`) that
  a path leaves out, as every built-in path but the Responses formatter does,
  alters its message.
- **Provider adapters:** `ProviderRequestOptions.onContentAltered(block?)`
  takes the request's own block when one block was altered, and membrane
  attributes it to the message that block came from. Declaring adapters
  report through the final body, passthrough parameters and cleanup
  included. Anthropic and Bedrock now report whitespace-only text removed by
  their empty-text cleanup (an exactly empty `''` block is still no loss) and
  a passthrough `messages` that replaces the built messages. Anthropic also
  reports nested tool-result blocks with no Anthropic form; Bedrock passes
  them through. The Responses API adapter reports what its input
  normalization leaves out or changes, naming the block, and a failed tool
  result, since a `function_call_output` has no error flag; the Responses
  formatter reports such a result too.
- `normalizeToolPairs` tells a caller that follows blocks by identity which
  ones it rewrote as new objects: `NormalizeOptions.onBlockRewritten` hears a
  `tool_result` rewritten as text, an orphan or a duplicate. NativeFormatter
  uses it to attribute those occurrences.
- `ProviderResponse.unreportedUsage` names the required counts
  (`inputTokens`, `outputTokens`) a provider did not report. Their 0 in
  `usage` stays for accounting, and round reports leave them out. Every
  built-in adapter that can lack a count names it (the mock always reports
  both). A round report's `usage` (`RoundUsage`) carries token counts only,
  never accounting's `estimatedCost`, in membrane's one convention:
  `inputTokens` excludes the cached span, reads and writes, restated for a
  cache-inclusive provider. An adapter whose cache convention is `'unknown'`
  passes its counts through as the provider gave them.

- `thinking.blockBinding` asks the API what to do with a signed thinking
  block the request sends back when the conversation before it has changed
  since it was minted: `{ prefixMismatchBehavior: 'drop_block' }` removes the
  failing blocks and the request proceeds, and `'error'` fails it with a 400.
  The Anthropic and Bedrock adapters send it as `thinking.block_binding`, with
  the `thinking-binding-controls-2026-08-01` beta, inside the thinking config
  membrane builds: enabled thinking whose budget fits, adaptive thinking, or
  a Fable or Mythos model, whose thinking config is otherwise left out.
  Fable 5 and 5.1 accepted it on 2026-10-10, and with `display` beside it
  on 2026-10-12 (that config carries `display` when it's set). Mythos
  hasn't been tried, and that family has refused thinking configs with a
  400 before, so setting it for a Mythos model may fail every request;
  Bedrock's acceptance of the beta hasn't been tried either. A request with
  no thinking config carries no binding: thinking disabled (Fable and Mythos
  think whatever `enabled` says, so they carry it whenever it's asked for), a
  budget that can't fit under `maxTokens`, or a request the XML or
  completions formatter builds to end in an assistant prefill.
  A `thinking` object passed through `providerParams` replaces membrane's,
  binding included. Unset, nothing is sent, and the account's default
  applies.
- Yielding streams report what the provider did with that thinking:
  `RoundReport.thinking` lists the blocks it dropped (`dropped`) and the
  ones that failed a binding check but were shown anyway, where the check
  isn't enforced (`mismatchAllowed`, read from the API's
  `thinking_mismatch_allowed` entries, which we haven't seen live). Each
  entry gives the provider's reason and its `messages.{i}.content.{j}`
  path, which indexes the request as sent, after membrane's merges and
  injections; where membrane can say, the entry also gives the consumer's
  own coordinates: the message it came from (`message`, `injected` as
  `[batch, index]`, or `round` for an earlier round of the stream) and the
  block's index in it. `ProviderResponse.inputTransformations` carries the
  provider's own report, and a streamed response's raw form now includes
  `input_transformations`.

### Changed

- `estimatedCost` is now omitted, with the one-time unpriced-model warning,
  for `gemini-2.5-flash-image`, `gemini-2.5-flash-preview-tts`,
  `gemini-2.5-pro-preview-tts` and `gemini-2.5-flash-native-audio-*`. A text
  model's row matched them by prefix and priced their image, speech or audio
  output at its text rate, below what Google charges for it. The new rows leave
  `gemini-3.8-flash-tts`, `gemini-3.8-flash-lite-tts` and
  `gemini-3.1-flash-lite-image` unpriced. A `ModelRegistry` can still price
  any of them.

- Two of the notes membrane writes in place of media it doesn't send now say that the model isn't seeing it, so a note isn't read as the content. In XML tool mode, a tool result's image that isn't sent as an image reads "[Image: image/png, ~12KB, not shown to you]" (in a split turn, the images sent at the split are shown, and later results' images read the note), and so does an image, document, audio or video in a result the normalizer turned into text. A tool-result image the OpenAI Responses input can't carry now says, as membrane's stripped-image note does, that an image was there and isn't seen: "[system: an image in this tool result was NOT shown to you. This request couldn't carry it, so you are not seeing it.]". Other notes, such as "[Image omitted]" past the Responses input-image cap, are unchanged. The first request after upgrading carries the new text wherever membrane renders one of these notes, so a provider's prompt cache misses from the first such note on, once. A results block stored with its raw XML replays as it was stored.

- **Build:** membrane is now built and typechecked with TypeScript 7 (`^7.0.2`), the native compiler, in place of 5.9. Built from the same source, the published JavaScript is byte-identical; the declaration files that differ do so only in the quote style of string-literal types (`'wire-request'` for `"wire-request"`); and the source maps that differ do so only in their `mappings`. A git or clone install runs the `prepare` build, which now needs TypeScript 7's compiler binary. That ships as optional packages for twenty OS/CPU pairs, so on another platform, or with optional dependencies omitted, the build fails, where 5.9's JavaScript compiler ran wherever Node does. A registry install runs no compiler.

### Fixed

- The built-in pricing table now prices Gemini's current models (#121).
  `gemini-4-argon`, `gemini-3.8-flash`, `gemini-3.6-flash`,
  `gemini-3.1-pro-preview`, `gemini-3.1-flash-lite` and
  `gemini-3-flash-preview` had no row, so their `estimatedCost` was omitted.
  A rate Google publishes with the date it changes is kept with that date, and
  the estimate follows the date a call is priced on, with no membrane upgrade:
  `gemini-4-argon` is priced at 2/10 per million tokens through November 30,
  2026 and 4/20 from December 1, and the 3.6 and 3.8 Flash models at 0.75/3.75
  through December 31, 2026 and 1.50/7.50 from January 1, 2027. Google names
  no time zone, so each change is taken to start at midnight US Pacific time.
- `gemini-3.5-flash` and `gemini-3.7-flash`, whose requests Google now routes
  to `gemini-3.6-flash` and `gemini-3.8-flash`, are priced at those models'
  rates. `gemini-3.5-flash` was priced at 1.50/9, its rate before it was
  deprecated.

- **Usage accounting:** the cache hit ratio now counts cache writes as part of the prompt. `details.cache.hitRatio` is cache reads over fresh input, cache writes and cache reads together, where it left the writes out, so on Anthropic and Bedrock calls that write cache it drops to its true value: 100 fresh, 5,000 written and 5,000 read is 49.5%, where it was reported as 98%. Cost is unchanged for those adapters, which price each count at its own rate. The docs that gave the total prompt as `inputTokens + cacheReadTokens` now give `inputTokens + cacheCreationTokens + cacheReadTokens`.
  - A `cache-inclusive` adapter's input count is now read as holding every cached token, written as well as read, and membrane subtracts both. No built-in inclusive adapter reports cache writes. For one that does, `inputTokens` drops by its writes, and they are priced once, at the model's write rate, instead of at that rate and the input rate both; a model without a write rate leaves them unpriced, as it does reads without a read rate.
  - OpenRouter resolves a response that reports Anthropic's `cache_creation_input_tokens` as `cache-excluded`, as it already did one reporting `cache_read_input_tokens`, so Anthropic's writes are never subtracted from `prompt_tokens`. The only counts this moves are those of a response that reports Anthropic's write field and OpenAI's `prompt_tokens_details.cached_tokens` above zero, without Anthropic's read field: its cached reads are no longer subtracted from `prompt_tokens`.
  - An adapter whose convention is `unknown` now warns once when it reports cache writes, as it did when it reported cache reads, since its writes now enter the total prompt and the hit ratio.

- `openrouter`, `openai`, `openai-compatible` and `openai-completions` fail the
  call when the provider reports an error inside an HTTP 200, streamed or not
  (#136): an `error` object, at the top level or on the first choice,
  whatever the finish reason, or a first choice that ends with
  `finish_reason: "error"`.
  - A response whose first choice ends with `finish_reason: "error"` was an
    `end_turn` holding the partial text, with the token disclosed as
    `details.stop.providerReason` and logged once. It now throws. An `error`
    object on that choice classifies the error, as a top-level one does; that
    is how OpenRouter documents a non-streaming generation that failed
    partway. With no `error` object at all, it is a `MembraneError` of type
    `server`, retryable, with `httpStatus` 500, as OpenRouter's documented
    mid-stream `server_error` is. `complete()` retries it when `maxRetries`
    allows another attempt, as it does any retryable error, and a retry layer
    above membrane that reads `retryable` will send the request again too.
  - A non-streaming 200 whose body is only an `error` object threw
    `Cannot read properties of undefined (reading '0')`, typed `unknown` and
    not retryable. It now throws the error a stream frame carrying that
    object gives, classified from its code or status. OpenRouter's documented
    `server_error` is a retryable server error, so `complete()` retries it
    when `maxRetries` allows another attempt.
  - A non-streaming 200 with an `error` object beside its choices returned
    the choices' content, and a stream chunk with an `error` object on its
    choice was read as an ordinary chunk. Both now throw, as a chunk with a
    top-level `error` object already did.
  - A stream chunk with a top-level `error` object, OpenRouter's documented
    mid-stream failure, already threw, classified by that object, and still
    does.

- XML tool mode reads OpenAPI 3.0's `nullable: true` beside a parameter's
  `type` as it reads a type list naming `null` (#143). Before,
  `{type: "string", nullable: true}` read as a plain string. A written
  `null` reached the tool as the text `"null"`, and the tool instructions
  didn't mark the parameter `nullable="true"`. For any other type the null
  arrived, with a warning that it wasn't the declared type. Only
  `nullable: true` itself counts, and only beside a `type`. Membrane doesn't
  consult a sibling `enum` or `const`, as for any `type`.
- The tool instructions now mark `nullable="true"` on a declaration membrane
  can read but can't give one type, when it admits null. Examples are a type
  list such as `["string", "number", "null"]`, `nullable: true` beside such
  a list, and an `anyOf` of several types with a null branch. Such a
  parameter still parses by the legacy guess, which already read a written
  `null` as null.
- The first request after upgrading carries the changed instructions for
  every tool with such a parameter, so a provider's prompt cache misses from
  those instructions on, once.

- A `stopReason` that membrane doesn't map (one other than `end_turn`,
  `max_tokens`, `stop_sequence`, `tool_use`, `pause_turn` and `refusal`),
  returned by an adapter without `providerStopReason`, is now kept as
  `details.stop.providerReason` (#154), also when membrane then ends the
  response at a stop sequence it finds itself. Membrane still normalizes the
  token to `end_turn` and logs it once, but the token was dropped, so a
  custom adapter's `stopReason: 'error'` read as a clean end of turn to a
  caller that checks `providerReason`. When the adapter gives a
  `providerStopReason`, `providerReason` still carries that, and a
  `stopReason` membrane maps, returned alone, still leaves `providerReason`
  unset.
  - A `providerStopReason` that isn't a non-empty string, such as `null` or
    `''`, now counts as none: the field is a string, omitted when no reason
    was reported. It was reported as `providerReason` as it came, so where a
    built-in adapter passes on a server's empty stop token, `providerReason`
    is now unset. An empty or non-string `stopReason` isn't carried either.
  - Otherwise the built-in adapters' responses don't change: they return
    `providerStopReason` beside any token membrane doesn't map.

- Anthropic server-tool blocks (`server_tool_use`, `web_search_tool_result`
  and the other blocks the API returns for a tool it runs itself, and
  `container_upload` for a file it puts in the code-execution container) go
  back to the Anthropic API in their place in the turn. The native tool
  loops and `fromAnthropicContent` kept each on a zero-width `rawItem`
  carrier, but NativeFormatter, which the native tool loops build through,
  and the exported `toAnthropicContent` dropped the carrier as empty text.
  So a replayed web-search turn lost its search results. With signed
  thinking in the turn, claude-sonnet-4-6 refused it in a live check:
  "`thinking` or `redacted_thinking` blocks in the latest assistant message
  cannot be modified". claude-haiku-5-5 accepted it and ran the search
  again. Each now sends the block itself, as a copy without any
  `cache_control` stored on it or its carrier. A block stored as itself, as
  a seeded history can hold it, goes back the same way. NativeFormatter
  sends it only in the assistant's own turns, the native tool loops'
  requests included: another participant's message, sent as a user turn,
  still leaves it out. `toAnthropicContent` sends it when given
  `{ role: 'assistant' }`, and otherwise leaves it out, as it always left
  out a carrier.
- Except where the API refuses a block in its turn. A server call goes only
  with its result after it in the turn, and a result only with its call
  before it: the API refuses either alone, so a lone one is left out of its
  turn and its message is reported altered. The request's final assistant
  message keeps its lone calls, since a paused turn (`pause_turn`) resumes
  there; `toAnthropicContent` takes `lastMessage` for that turn. The API
  takes each id once per turn, so the first call of an id pairs with the
  first result after it, and a second call with that id, or a second result
  for it, is left out too. A call whose `id`, or a result whose
  `tool_use_id`, isn't a string is left out of every turn, the final one
  included. A turn left with nothing is dropped. `container_upload`, which
  the API refuses in any assistant turn, is always left out.
- Membrane sends these blocks back only through `AnthropicAdapter`. Live
  checks on claude-haiku-4-5 had the Anthropic API accept each type sent
  back beside its partner, with or without a cache marker on it, except
  `container_upload`; the MCP connector's pair was checked through
  `count_tokens` only, and code execution's success results were built from
  the SDK's types. It leaves them out of every other provider's requests,
  Bedrock's included, in the build itself, before it places cache markers
  and merges turns, so those requests are what they were before: a provider
  adapter declares `replaysAnthropicServerBlocks`, and NativeFormatter takes
  `anthropicServerBlocks`, off by default. Whether Bedrock accepts them is
  unknown, and a refusal there would fail every request carrying the
  conversation. In XML tool mode the turn is text, so these blocks still
  aren't sent there.
- Anthropic API requests for a stored history with such a turn change from
  that turn on: a prompt-cache prefix written before upgrading that reaches
  past the turn no longer matches, and the search results are input tokens on
  every later request. A turn stored through `complete()` before this release
  has no carrier to send, so a model that refuses it with signed thinking
  still refuses it: an upgrade can't restore what was never kept.
- A caller that builds a request with NativeFormatter itself for the
  Anthropic API passes `anthropicServerBlocks: true`, or what it builds
  leaves out the server blocks that inference sends. A host's token count is
  the usual such caller, connectome-host's `buildCountTokensPayload` among
  them: without the option its count runs low from a server-tool turn on.
- Streaming: a server tool's call (`server_tool_use`, `mcp_tool_use`) kept
  the empty `input` of its `content_block_start`, because only a `tool_use`
  assembled its `input_json_delta` fragments. It now holds the input the
  model wrote. Fragments that don't parse to an object, and a call cut off
  mid-input, leave the start's `input: {}` with the text in
  `unparseableInput`, and a warning names the block; whitespace alone is no
  input. Either call goes back as stored, `{}` without the marker, wherever
  the pairing rule keeps it: a stopped call with its result after it, or a
  lone call in the request's final message. A cut-off call has no result
  after it, so only the final message keeps it.
- `complete()` keeps a provider block it has no normalized form for (an
  Anthropic server-tool block, or an opaque Responses item such as a
  compaction) on a zero-width carrier, as the native tool loops do, instead
  of dropping it, and an XML closing tag it restores goes on the last text
  block that isn't a carrier. It still keeps no `rawItem` on the text and
  thinking blocks it normalizes, which the native tool loops do keep.
  `fromAnthropicContent` carries a server-tool block without the
  unknown-type warning.
- Request shapes for other wires leave a server-tool block out, bare or on
  its carrier. The OpenAI Responses formatter no longer replays one as an
  input item, the Responses input normalization no longer passes one through
  as a message part or an empty text part, and the XML and completions
  formatters, the OpenAI, OpenAI-compatible, OpenRouter and OpenAI
  completions adapters, and the exported `toOpenAIMessages`,
  `toOpenRouterMessages`, `toOpenAIContent` and `toGeminiParts`, no longer
  write a zero-width carrier as an empty text part or line, and neither does
  the exported `extractText`. `toOpenAIContent` still answers `''` for a
  turn whose only text blocks are carriers.

- Anthropic streaming idle watchdog now treats received Web response-body bytes, including SSE `ping` keepalives the SDK filters out, as transport activity after the first SDK event. The default idle deadline remains 600000 ms; the fixed first-event deadline is unchanged. SDK-supported bodies without `pipeThrough` pass through unchanged and retain event-based idle checks. Stream setup failures now clean up the watchdog and caller abort listener. This change adds no total-duration or generation-progress deadline; a stream with continuous body activity can remain open indefinitely.

- `timeoutMs` past 2³¹−1 ms (about 24.8 days), `Infinity` included, no longer times a request out after about 1 ms. Node runs a timer whose delay is longer than that after 1 ms, so deadlines are now armed in steps within the limit: a long one fires on time, and `Infinity` never fires. `progressTimeoutMs` follows the same rule.

- Two more refusals of the account or its credential are typed `auth`, as a
  low credit balance and reached usage limits already were: "This
  organization has been disabled." and "This credential is only authorized
  for use with Claude Code and cannot be used for other API requests."
  Anthropic sends both as a 400. Typed `invalid_request` before, they read
  to callers as something wrong with the request, which no change to the
  request fixes. The text is matched in any provider's own error message,
  as the other two are, so another provider's 400 or 422 that says one of
  these is `auth` too.

- `gemini`: a response whose cached count exceeds its prompt count is read as
  cache-excluded, so membrane counts its cached span beside its prompt. The
  usage check now also accepts a `totalTokenCount` that includes that span,
  the total membrane counts, besides the total of Google's formula, so such a
  response no longer logs "usageMetadata does not reconcile" on every call.
  None of the published responses cited for the cache-inclusive reading
  shows this case; the one-time warning that the response is read as
  cache-excluded still says when it is met. A total that
  matches neither sum still logs, and names both. The warning's closing
  sentence, that some billed tokens are in another usageMetadata field, now
  appears only when the total exceeds every sum it names.

- `gemini` reads `usageMetadata.toolUsePromptTokenCount`, the prompt tokens
  Gemini's built-in tools add, into `inputTokens`, and counts it in the check
  against `totalTokenCount`. A response that reported the field logged
  "usageMetadata does not reconcile" every time, and its tool-use tokens were
  left out of usage and the cost estimate, though Google bills code
  execution's, URL context's and file search's as input (#120). Grounding,
  with Google Search or Google Maps, is billed per query or per grounded
  prompt, which membrane doesn't price, and for text models Google doesn't say
  whether grounding's retrieved context is counted in this field or charged as
  input. If it is counted and not charged, a grounded response's input is
  overstated.

- `openai-compatible` now sends OpenAI's own parameter surface when the model
  is one of OpenAI's reasoning-generation models (GPT-5 and later, o-series),
  e.g. with `baseURL` pointed at `https://api.openai.com/v1`: `max_completion_tokens`
  instead of `max_tokens`, and no custom `temperature`/`top_p` or unsupported
  `stop`. Previously every request for those models failed with "Unsupported
  parameter: 'max_tokens' is not supported with this model". Model detection is
  shared with the `openai` adapter; all other model ids keep the legacy
  parameters.

- A `tool_use` block's `input` is now always a plain object, as
  `ToolUseContent` types it. When a model's arguments aren't a JSON object,
  `input` is `{}` and `unparseableInput` keeps what came, as the Anthropic
  adapter already did for a call its stream left unfinished.
  - The OpenAI, OpenAI-compatible, OpenAI Responses and OpenRouter adapters
    stored whatever `JSON.parse` returned, so a model's arguments of `null`,
    a number, a string or an array became `input` as they were. Arguments
    that didn't parse became `{}` with nothing to tell them from a call with
    no arguments. Both are now `{}` with `unparseableInput`. In a
    non-streamed response, an `arguments` field that isn't text at all,
    which these wires' specs don't allow, is read as a value, as Gemini's
    `args` are, and a `null` field is a call with no arguments.
  - The Anthropic and Bedrock stream assemblies kept a parse that wasn't an
    object; Bedrock also kept `{}` silently for arguments that didn't parse.
    Both now mark them. Bedrock now also marks a call the stream left open
    (no `content_block_stop`, as when `max_tokens` cuts it), as the Anthropic
    adapter does: `input` stays what `content_block_start` carried, and
    `unparseableInput` holds whatever arguments arrived, `""` when none did.
    Before, it parsed what had arrived as if the call had finished, and
    kept `{}` unmarked when that didn't parse or nothing had arrived.
  - Gemini copied `functionCall.args` into `input` unchecked. `input` is now
    `{}` when the call carries no args, or `null` ones (unset, in Gemini's
    proto3 JSON), and a value that isn't an object is kept, as JSON, in
    `unparseableInput`. The exported `fromAnthropicContent` and Bedrock's
    non-streamed response follow the same rule for the `input` the provider
    sent, where `null` is a value that isn't an object.
  - `Membrane.complete` and `Membrane.stream` give every `tool_use` in the
    content they hand on an object `input`, whatever an adapter gave: an
    `input` that isn't an object reaches the caller as `{}`, with
    `unparseableInput` holding it as JSON unless the adapter marked the block
    already. `Membrane.complete` now carries an adapter's
    `unparseableInput`, as streamed responses already did, and its
    `toolCalls` get the same object `input`. The streaming block events
    (`block_complete`, and the deprecated `onContentBlockUpdate`) still
    report a tool call as the adapter streamed it, with no marker.
  - `ToolCall` has `unparseableInput` too, set from the call's block, so an
    executor can answer a marked call with an error result instead of
    running it with `{}`. It's on the calls `stream()` hands `onToolCalls`,
    the yielding stream's `tool-calls` event and `complete()`'s `toolCalls`.
  - A call with empty arguments, or arguments that are only JSON
    whitespace, is `{}`, unmarked.
  - The warning for arguments that aren't an object, which the Anthropic
    and Bedrock stream assemblies now log too for a call that finished, no
    longer includes the parse error, whose message quotes the arguments. A
    call the stream left open is marked without a warning; the response's
    stop reason says why.

- **Stream labels and block events at a stop:** when a prefill loop found a stop sequence inside a provider chunk, the text before it went out as one chunk, labelled with the block the parser was in after the whole chunk. So the end of a `<thinking>` block that closed in that chunk, or of a tool call before its `</function_calls>` stop, went out as visible text to `stream()`'s `onChunk` and to `streamYielding()`'s `tokens` events. Now the parser takes only the text before the stop, and each piece goes out labelled by its own block, as on a chunk with no stop. Where the provider sends no typed blocks, each piece carries its block's index from the parser, and the parser's block events for that chunk (`onBlock`, and `streamYielding()`'s `block` events) go out too; they were dropped before. Such a round now ends as one the provider stopped: its block in progress gets the `block_complete` it never got, the text the parser held back at its end (a possible tag's start, such as a trailing `<`) goes out, and block indices go on through the turn instead of starting again at 0. A tool call before such a stop goes out as it does at a provider's stop: the parser's `tool_call` block for the call's text, then the parsed call's. There, the held-back text now goes out at the end of every round; the stream dropped it, though the content kept it. Where the provider sends typed blocks, each piece carries the index of the provider's block, as on other chunks there, a thinking block's text keeps the provider's label, and the stream carries the provider's block events, not the parser's; what the parser held back at a round's end isn't streamed, as before. When a stop turns out to sit inside a block the model opened, its text went out with `blockIndex: 0` and a type read after it, so a `</function_calls>` stop put back, as with no `onToolCalls`, went out as visible text. Where the provider sends no typed blocks, it now goes back through the parser: no block is in progress after the round's end, so text starts a new block of the same type, which goes on into the next round, and a closing tag goes out as neither text nor a block event. Where it sends typed blocks, the stop still goes out as one piece with `blockIndex: 0`, now labelled with the block it sits in, so a closing tag goes out as part of the block it closes, not as visible text. A stop split across two chunks is unchanged: its first part goes out before the stop is found, the round's block in progress never completes, and block indices start again at 0. The response's content is unchanged, except where a stop is now put back and the turn goes on, as the next item says.
- **A closing tag with no block in progress:** when the stream parser read a `</thinking>`, `</function_calls>` or `</function_results>` with no block in progress, it sent a `block_complete` for a block that never started and, where nothing was open, took that tag's depth below 0. It now sends no block event, and depths stop at 0. With thinking on, the model's `</thinking>` right after the `<thinking>` a tool round adds was one such tag. A depth below 0 also hid a block the model opened after such a tag, where no block was open before it, so a stop the provider applied inside that block ended the turn; that stop is now put back and the turn goes on, as it already did for a stop the loop found. So where that stop lands, the response now holds the rest of the turn instead of ending there, and the turn makes the continuation calls a stop the loop finds already makes. A block the model opens that only brings back a depth the prefill left open still reads as nothing opened, as before.

- Gemini's usage is read as cache-inclusive: `promptTokenCount` counts the cached span `cachedContentTokenCount` reports. That is Google's UsageMetadata definition, stated for explicit cached content, where Google's caching cookbook shows it (a total of prompt + thoughts + candidates, with the cached span inside the prompt), and one published chat fits it for the implicit hits membrane meets too: in googleapis/python-genai#2064, `promptTokenCount` grows steadily through a chat while `cachedContentTokenCount` drops to 0 and comes back. So in Membrane's responses `inputTokens` is now the fresh input on a Gemini cache hit, as it is for every provider whose cache convention is known (an adapter that declares `unknown` passes its counts through, except for a response that carries its own convention, as OpenRouter's do when they report a cache read), and a hit is counted once by the cache-hit ratio, by cost and by any consumer summing input, cache reads and cache writes. A response whose cached count exceeds its prompt count can't include it, so that response is read as cache-excluded instead, with a one-time warning. Since Gemini now declares a convention, the one-time warning about an adapter that declares `unknown` no longer fires for it.
  - **What callers see:** on a Gemini cache hit, `inputTokens` falls by the cached span, and the estimated cost falls with it: the cached span is priced once, at the model's cache-read rate. A pricing row without a cache-read rate leaves that span unpriced, as cache reads are for every provider, where it used to ride in `inputTokens` at the input rate; every priced Gemini row in the default table has one. Usage recorded before the upgrade keeps the old reading, so a sum across the upgrade steps down.
  - **Unchanged:** a direct `GeminiAdapter` caller still gets `promptTokenCount` in `inputTokens`, beside `toolUsePromptTokenCount` where a response reports it, with `usageCacheConvention: 'cache-inclusive'` declaring how to read it. A response whose cached count exceeds its prompt count carries `cacheConvention: 'cache-excluded'` for that response. A response without a cache read is unchanged.

- The native formatter sends no system block for an empty system prompt. With
  the default `membrane-system` cache markers and no message breakpoint, it
  had wrapped `''` as a cache-marked empty text block, which the API doesn't
  cache. Empty text blocks in a system array are dropped the same way before
  the fallback marker goes on the last block, and an array left empty sends
  no system block.

- OpenAI chat completions, the OpenAI Responses API and Gemini now keep a
  provider-reported cache-read count of 0 as `cacheReadTokens: 0`. Before,
  a reported 0 was dropped to `undefined`, indistinguishable from a provider
  that reported nothing. An unreported count is still absent. Gemini's
  `usageMetadata` follows proto3 JSON, which omits zero counts, so when it is
  present a missing `cachedContentTokenCount` is a reported 0, as a missing
  `candidatesTokenCount` is; only a response without `usageMetadata` leaves
  the count unreported.
- Turn totals (the usage `complete()` and `stream()` return, the `usage`
  event's `usage`, and `onUsage`) and a refused attempt's record
  (`details.usage.discardedAttempts`) carry a cache-read or cache-creation
  count, and thinking tokens, once any round reported it, a 0 included, as
  each round's own entry in `perRound` does. Before, a count was added only
  when it was positive, so a reported 0 was lost there too. A count no round
  reported is still absent. This changes values a caller reads without
  `round`: where a provider reports 0, the totals now carry the 0.

- Image data that its destination doesn't accept now becomes the visible text
  placeholder wherever membrane converts it for a request, whatever type it is
  labelled with. Data whose bytes matched no format used to keep its label, so
  a text file labelled `image/png` went to the provider as an image, and the
  API refused that request and every later one that carried it in history. The
  decision recognizes each format by its header and takes the destination's
  formats: JPEG, PNG, GIF and WebP by default, Gemini's PNG, JPEG, WebP, HEIC
  and HEIF (so a GIF sent to Gemini now becomes the placeholder), and the
  Images adapter's PNG, WebP and JPEG. The request builders still send only
  the four default formats, so HEIC and HEIF reach Gemini only from a direct
  adapter call or a hook-replaced request. Tool results in native tool
  requests, every adapter (called directly or through a builder), the XML
  tool-result notes, the XML replay of a split image round, and the OpenAI
  Responses formatter and transport now check it, and the Images adapter
  leaves such data unattached. A `data:` URL
  takes the same decision. A native `input_image` part becomes the placeholder
  when its data holds no accepted image, and otherwise replays verbatim, its
  label included. A remote URL goes out as it is, and so does a caller's
  whole-payload override (`extra.messages`, `extra.contents`). An XML tool
  loop whose result's only image became the placeholder no longer sends an
  empty image turn. The placeholder now names the formats the request can
  carry and the label the data had, quoted. Its new text also replaces the
  text an image of an unsupported type already got, so after upgrading,
  requests from a context that holds one change from that point, and its
  prompt cache is written again from there once. An image whose header shows
  an accepted format is sent as before, labelled by its header;
  `toAnthropicContent` now labels a generated image that way too, and an image
  with no label now goes under its header's type, where the OpenAI-family
  adapters sent `image/png` and Gemini `image/jpeg`.
- An MCP-shaped image in a tool result (`{ type: 'image', data, mimeType }`)
  is now decided by its data. The native builder gave every such image the
  placeholder, and the XML builder failed on one, so an accepted one now
  reaches the model as an image wherever its request carries tool-result
  images. A context that holds such images sends larger requests from the
  first one after upgrading, and its prompt cache is written again from there
  once.

- In XML mode under `cacheMarkers: 'cm-owned'`, the formatter no longer marks the last block of an unmarked system array, as it already didn't for a system string or in native mode, and as `cm-owned` promises. That marker took a fifth slot beside a caller's four message breakpoints, and the build then threw "cache_control limit exceeded: 5 markers". At three or fewer breakpoints, an XML request with an unmarked system array now carries one marker fewer: a `cm-owned` caller that wants its system prompt marked marks a system block itself, as with the native formatter.

- In XML tool mode, a round whose tool result carries an image sends the image in a user turn of its own, and the response used to keep only the result's text, so a later request built from it showed no image and no sign of one. Now the result whose images were sent keeps what the tool returned, images included, in its block and in the response's tool results, and its block marks where the results block split (`rawXmlImagesAt`). The XML replay sends the block split there, with those images, as the turn did, so the model keeps seeing them on later turns, as in native tool mode. Later requests therefore carry those images until something removes them. A response stored before this fix has no mark, so it replays without the images, as it did.
  - When the replay can't split a marked block (its mark no longer falls where a result closes, or no image it holds can be sent), it sends the raw text whole, and if the result still holds an image, the round report counts the message altered.
  - Results of two rounds with the same text, stored next to each other, as a host that keeps results apart from their calls stores them, replay as two blocks, each with the images its round sent. They used to replay as one block, which left the second round's block out. The calls of two such rounds replay as two blocks too.
- In XML tool mode, a round whose results hold images, none of which the API accepts (such as `image/bmp`), no longer splits the turn. It sent an empty user turn, which the Messages API is expected to refuse; the results now go in as text, with the note that names the refused media type where each image was.

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
- OpenAI, OpenRouter, OpenAI-compatible and Gemini adapters no longer send inline image data inside tool results as base64 text. Their tool-result wire is text only, so tool_result content was JSON-stringified whole and an image's payload reached the model as prompt text (a 300KB screenshot became ~400KB of input on every request while it stayed in history). This already happened on `stream()` with native tools and on `complete()` for snake_case `media_type` images; preserving camelCase tool-result images above would have extended it to every `complete()` history. Blocks carrying inline image data (`image` with a base64 source or MCP-style `data`, `generated_image`) are now replaced by a constant placeholder telling the model the image was not shown. URL-source images, image-typed tool data without a payload, strings, non-array content and arrays without inline images serialize byte-identically. Histories that already carried such base64 text change bytes once (and shrink). Verified with mocked transports; native image parts on these wires are not attempted.
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
