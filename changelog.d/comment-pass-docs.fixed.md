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
