# Anthropic stream watchdogs

`AnthropicAdapter` keeps transport activity separate from response generation.
The SDK filters SSE ping events before exposing its stream iterator. The adapter
observes nonempty response-body chunks before that filtering.

The transport idle watchdog detects a connection that stops delivering bytes.
`idleTimeoutMs` defaults to 600000 ms. Without a progress policy, the separate
fixed first-event deadline remains `max(idleTimeoutMs, 600000)`.

Enable the optional response inactivity policy at adapter construction:

```typescript
import { AnthropicAdapter } from '@animalabs/membrane';

const adapter = new AnthropicAdapter({
  progressTimeoutMs: 30 * 60_000,
});
```

`progressTimeoutMs` must be a positive integer up to 2147483647. It is disabled
when omitted. Each stream has its own clock, starting when the call begins.
Nonempty text, thinking, tool argument JSON and signature deltas renew it.
Ping, raw bytes, empty deltas and block metadata do not renew it. A response
that keeps producing data can run longer than the configured window.

With this policy enabled, pre-first-event body activity also renews transport
liveness. A ping-only connection expires through the response inactivity policy.
A connection without incoming bytes still reaches the earlier transport deadline.
Unconfigured callers retain their previous first-event behavior.

Expiry aborts the owned operation and raises a `MembraneError` with
`type: 'timeout'`, `retryable: false` and
`providerErrorCode: 'response_progress_timeout'`. It does not turn partial content
into a completed response. Caller cancellation remains a separate abort.

The error's `rawError.watchdog` contains timestamps for call start, last body
activity, last SDK event and last response progress, plus the progress source,
sequence and configured window. It contains no response payload.

These signals measure observable response generation. They do not establish
useful task progress. Hidden thinking may produce only ping traffic for a long
period. That case remains indistinguishable from missing response progress and
can expire. Summarized thinking can improve visibility but does not guarantee
regular deltas. The nonstreaming `complete()` API does not use this policy.
