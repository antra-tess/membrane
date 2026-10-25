# membrane

`@animalabs/membrane` sends LLM requests to many providers through one request and response format. A request is a list of messages from named participants, such as `User`, `Alice` or `Claude`, with a system prompt, tools and generation settings. Membrane turns it into what the provider expects, sends it with retries, and parses the answer, streamed or not, into content blocks, tool calls and usage with an estimated cost.

It sits at the bottom of the Connectome stack. [agent-framework](https://github.com/anima-research/agent-framework), [context-manager](https://github.com/anima-research/context-manager) and [connectome-host](https://github.com/anima-research/connectome-host) all build on it. context-manager compiles an agent's history into membrane's message format, and agent-framework sends each turn through membrane.

## Install

```bash
npm install @animalabs/membrane
```

It needs Node 22.12 or later. Its one runtime dependency is `@anthropic-ai/sdk`.

## Quick start

```ts
import { Membrane, AnthropicAdapter } from '@animalabs/membrane';

// The adapter reads ANTHROPIC_API_KEY unless you pass apiKey or other credentials.
const membrane = new Membrane(new AnthropicAdapter());

const response = await membrane.complete({
  system: 'You are a helpful assistant.',
  messages: [
    { participant: 'User', content: [{ type: 'text', text: 'Hello!' }] },
  ],
  config: { model: 'claude-sonnet-4-5', maxTokens: 1024 },
});

console.log(response.content);    // content blocks, e.g. [{ type: 'text', text: '…' }]
console.log(response.stopReason); // e.g. 'end_turn'
console.log(response.usage);      // input and output tokens
console.log(response.details.usage.estimatedCost); // absent for a model membrane has no prices for
```

The participant named `Claude` is the assistant by default. Set `assistantParticipant` on the request, or in the `Membrane` config, to use another name.

## Streaming and tools

`stream()` takes the same request and returns the same response when the turn ends, or an `AbortedResponse` if it's cancelled, by your signal or a timeout. A provider failure rejects with a `MembraneError`, as it does from `complete()`. `onChunk` receives each chunk as it arrives, with metadata saying which block it belongs to and whether it's visible text rather than thinking or tool content. With `onToolCalls`, membrane runs tool rounds inline: it calls your function with each round's tool calls, sends back the results it returns, and continues until the model answers without calling a tool. The rounds stop after the one at depth `maxToolDepth` (10), counting from 0, and that last round's results come back in `toolResults` instead of going to the model. `complete()` has no tool loop, and returns any tool calls in `response.toolCalls`.

```ts
import { isAbortedResponse } from '@animalabs/membrane';

const controller = new AbortController();
const result = await membrane.stream(
  {
    messages: [
      { participant: 'User', content: [{ type: 'text', text: 'What time is it?' }] },
    ],
    tools: [{
      name: 'get_time',
      description: 'The current time, as an ISO string.',
      inputSchema: { type: 'object', properties: {} },
    }],
    config: { model: 'claude-sonnet-4-5', maxTokens: 1024 },
  },
  {
    onChunk: (text, meta) => { if (meta.visible) process.stdout.write(text); },
    onToolCalls: async (calls) =>
      calls.map((call) => ({ toolUseId: call.id, content: new Date().toISOString() })),
    signal: controller.signal,
  },
);

if (isAbortedResponse(result)) {
  // Cancelled: result.reason says why ('user' when it was your signal),
  // and result.rawAssistantText holds any text that had arrived.
}
```

## Providers

Each provider is an adapter you pass to `new Membrane(adapter, config)`. An adapter reads the environment variables in the third column unless you pass the same settings in its config.

| Adapter | Talks to | Environment |
|---|---|---|
| `AnthropicAdapter` | Anthropic's Messages API. | `ANTHROPIC_API_KEY` |
| `BedrockAdapter` | Anthropic's Claude models on AWS Bedrock. | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, optionally `AWS_SESSION_TOKEN`, and `AWS_REGION` (default `us-west-2`) |
| `OpenAIAdapter` | OpenAI's Chat Completions API. | `OPENAI_API_KEY` |
| `OpenAIResponsesAPIAdapter` | OpenAI's Responses API. | `OPENAI_API_KEY` |
| `OpenAICompatibleAdapter` | Any OpenAI-compatible Chat Completions endpoint, such as Ollama or vLLM. | None: pass `apiKey` if the endpoint needs one |
| `OpenAICompletionsAdapter` | A `/v1/completions` endpoint, for base models. | None: pass `apiKey` if the endpoint needs one |
| `OpenRouterAdapter` | OpenRouter. | `OPENROUTER_API_KEY` |
| `GeminiAdapter` | Google's Gemini API. | `GOOGLE_API_KEY` |
| `OpenAIResponsesAdapter` | OpenAI's Images API, despite its name. | `OPENAI_API_KEY` |
| `MockAdapter` | Nothing: canned or echoed responses, for tests (`createCannedAdapter`, `createEchoAdapter`). | None |

## Formatters

A formatter turns the participants into the provider's message format and parses the reply. `Membrane`'s config takes one as `formatter`.
- `AnthropicXmlFormatter`, the default, supports native tools and an XML transcript mode. In XML mode the conversation becomes one participant-labelled transcript, tool calls use `<function_calls>` and `<function_results>`, and the model continues it as a prefill.
- `NativeFormatter` maps participants to the provider's own user and assistant roles.
- `CompletionsFormatter` makes a single prompt string for completion endpoints.
- `OpenAIResponsesFormatter` builds Responses API input, replaying items imported from that API as they were.

Membrane builds a native request, with native tools, whenever the formatter supports one, as the default formatter does. A request's `toolMode: 'xml'`, or a formatter configured for XML, selects the XML transcript instead. [docs/formatters.md](docs/formatters.md) covers the choice and each formatter's options.

## Other behaviour worth knowing

- **Retries.** Membrane is the one layer that retries: `AnthropicAdapter`'s SDK client makes one attempt at each request a call makes, and only its cache keepalive's background replays keep the SDK's own retries. A provider call that fails with a retryable error before it has delivered anything is sent again, on every entry point and in any round of a tool loop; one that has delivered something isn't, since that would replay what you already have. Each attempt calls your `onRequest`, so a request membrane retries calls it again; a credential resolver's resend after a 401 is part of the attempt it follows. A request to an overloaded provider (529) gets up to `retry.overloaded.maxRetries` attempts, seven by default, or `retry.maxRetries` if that's more. The delay between them doubles from 10 seconds to a cap of 5 minutes, and each wait is drawn at random between half the delay and all of it, or is the provider's retry-after when that's longer. Without a retry-after, that's about five to ten minutes in all. A rate-limited request (429) gets up to five attempts, or `retry.maxRetries` if that's more, and any other retryable failure (a 5xx, a provider's 408, a connection failure) gets `retry.maxRetries` attempts, three by default, with waits of 1 and 2 seconds. A retry-after of up to a minute is waited out, or of up to the schedule's cap where that's longer (a 529's is 5 minutes); a longer one isn't: the error comes to you at once, with the stated wait as `retryAfterMs`. A deadline that runs out on a request already sent isn't retried either: `AnthropicAdapter`'s idle and first-event watchdogs, undici's headers and body timeouts, Bun's fetch timeout, and every timeout `AnthropicAdapter`'s SDK client reports, a connect timeout included, since the SDK reports both the same way. The call ends with a retryable `timeout` for you to retry or not. On the other adapters, on Node, a connect timeout is retried like any connection failure; Bun's fetch timeout doesn't say which stage ran out, so on Bun a stalled connect is left to you too. If a retry layer of your own should be the only one, pass `retry: false` to `complete()`, `stream()` or `streamYielding()`: membrane then retries none of the call's failed requests, whatever the error, and the failure comes to you as it came, with the provider's advice on it (`retryable`, and a stated wait as `retryAfterMs`). Two sends stay: a refusal re-issue you ask for with `refusalRetries` on `complete()`, or on `streamYielding()` in native tool mode, and the one resend with refreshed credentials that an adapter with a credential resolver makes after a 401. A layer of yours that retries can take membrane's decision itself from `@animalabs/membrane/retry`, with its own numbers: `classifyFailure` gives a failure's class, and `retryDecision` whether to send again after so many tries and how long to wait first.
- **Prompt caching.** On Anthropic and Bedrock, requests carry cache markers unless the request sets `promptCaching: false`. A message with `cacheBreakpoint: true` gets one. Anthropic accepts four markers in a request, and membrane drops the shallowest beyond that. A request's `cacheTtl: '1h'` asks Anthropic for the longer cache; Bedrock keeps its own default lifetime. `AnthropicAdapter` also keeps an idle agent's one-hour cache warm. Its `CacheKeepalive`, on by default, replays the last streamed request that carries a one-hour cache marker, with `max_tokens: 0`, once the cache has gone 45 minutes untouched, for up to a day after the last real request. It holds a request only once the provider is known to have started its message, at a stream's `message_start` or once the SDK has a non-streamed reply, so a call that fails before then, such as one refused or never delivered, is never replayed. A replay leaves out the messages after the request's last one-hour marker, apart from what it takes to end where a user turn ends: no one-hour cache entry holds them, so replaying them would only bill them as input, or write them again where a five-minute marker covers them. A request with no user message at or after that marker is replayed whole. Requests with only the five-minute cache, or in a shape that can't be replayed that way, aren't refreshed. So a long-lived process sends these refresh requests while it's idle. `new AnthropicAdapter({ cacheKeepalive: { enabled: false } })` turns it off.
- **System changes.** A message holding only `system_change` blocks changes the tools the model is offered, and its system text, from that point in the conversation on, without editing the request's `tools` or `system`, so the prompt cache before it still holds. `NativeFormatter` and `AnthropicAdapter` send it as a mid-conversation `role: 'system'` message: each of `removeTools` as a tool removal, each of `defineTools` as a tool definition and each `addSystem` value that isn't only whitespace as text, with the inline-tools beta when it changes tools. It goes at the first point at or after its place that the API accepts: after a user turn, a tool-result turn included, and before an assistant turn or at the end. A request carrying one fails with a `MembraneError` whose `systemChangeRefused` is true when no point after its place accepts it, when the formatter or adapter is another, and when the model takes no mid-conversation system message. The first two fail before anything is sent. Through another formatter, a request whose tools it can't carry at all (`tools` as the request's changes leave them) fails first, without the flag, since the same change made in `tools` would meet that refusal too. The same change made to `tools` and `system` doesn't meet this refusal, though a request that ends in an assistant turn can still meet a model's refusal of prefill.
- **Errors.** A provider or transport failure reaches you as a `MembraneError`, whose `type` and `retryable` say what happened, with the raw request attached. An error from your own code that membrane runs beside the call, which a resend of the request can't mend, ends the call without a resend: a hook, a request or stream callback, a receipt consumer, the Anthropic adapter's `dynamicHeaders`, a configured logger's `warn()` or a registry's `getPricing()`. It reaches you as a `MembraneError` with `retryable: false`: the one you threw if it already said `retryable: false`, or else a new one classified from your error as membrane classifies any other, with your error as its `cause` and no HTTP status, provider code or wait of its own. An error of yours named `AbortError` keeps the type `abort`, so membrane treats it as any other abort thrown at the same point. What builds, sends or reads the call keeps its own classification: an adapter and the transport, a credential resolver, a formatter and its parser. If the Responses adapter's `onFastModeFallback` throws, membrane logs the error and the response stands. A request membrane refuses to build fails with its own error type instead of being sent. With `NativeFormatter`, or the default formatter in native mode, a history with unpaired tool blocks is repaired rather than refused: a call without a result gets a `[pending]` result, and a result without a call becomes text.

## Design notes

`docs/` holds the longer notes:
- `formatters.md`: the formatters, tool modes and their defaults.
- `prefill-formatter-architecture.md`: how prefill formatting works.
- `anthropic-credentials.md`: rotating Anthropic bearer credentials.
- `subscription-responses.md`: the ChatGPT subscription Responses transport.

## Development

```bash
npm ci
npm run build
npm test           # vitest
npm run typecheck
```

[CONTRIBUTING.md](CONTRIBUTING.md) covers how changes land, what a pull request should contain, changelog fragments and releases. [CHANGELOG.md](CHANGELOG.md) lists what each release changed.

## License

MIT. See [LICENSE](LICENSE).
