# Rotating Anthropic bearer credentials

Long-running applications can supply a resolver instead of a token captured at
startup. `credentials` uses the same contract as the Responses adapter:

```typescript
const adapter = new AnthropicAdapter({
  credentials: async ({ forceRefresh, signal }) => {
    const token = await applicationAuth.getToken({ forceRefresh, signal });
    return { token };
  },
});
```

For callers that only need a bearer token, `authToken` also accepts a callback:

```typescript
const adapter = new AnthropicAdapter({
  authToken: ({ forceRefresh, signal }) => applicationAuth.getToken({ forceRefresh, signal }),
});
```

A zero-argument synchronous or asynchronous callback works too. `credentials`
takes precedence if both options are supplied. Static strings, explicit null,
and existing environment-based authentication retain their existing behavior;
a static environment token cannot refresh itself. Applications must opt in and
supply a credential source that can actually read or refresh a newer token.

The SDK's HTTP boundary uses Membrane's shared resolver seam. It resolves for
each network attempt, including cache-keepalive replay, refreshes once after an
HTTP 401, and never replays an accepted stream in response to an in-stream auth
error. Other SDK retry behavior remains unchanged. The SDK request signal also
bounds waiting on the resolver. Refresh serialization and OAuth exchanges remain
application responsibilities.

Resolver mode always uses bearer auth. It removes API-key headers, including
ones supplied in environment/default/dynamic/resolver headers, and prevents a
stale Authorization header from overriding the resolved token. Ordinary beta
flags and dynamic request headers retain their existing behavior. Keepalive
replays resolve a current token while retaining their existing unstamped
telemetry behavior.

No Anthropic credential file is read by Membrane. This API fixes the frozen
credential limitation reported in issue #69; hosts still need to supply a live
resolver rather than a string captured at startup.

Co-authored by GPT-6 via OpenAI Codex.
