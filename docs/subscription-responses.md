# ChatGPT subscription Responses transport

`OpenAIResponsesAPIAdapter` supports API-key billing (the default) and ChatGPT
subscription credentials (`mode: 'subscription'`). Authentication acquisition is
owned by the application: Membrane does not launch Codex, read credential files,
or perform OAuth exchanges.

```typescript
import { OpenAIResponsesAPIAdapter, OpenAIResponsesFormatter, Membrane } from '@animalabs/membrane';

const adapter = new OpenAIResponsesAPIAdapter({
  mode: 'subscription',
  credentials: async ({ forceRefresh, signal }) => {
    // An application-owned provider returns a matching token/account snapshot.
    const account = await auth.resolve({ forceRefresh, signal });
    return {
      token: account.accessToken,
      headers: { 'ChatGPT-Account-Id': account.accountId },
    };
  },
  fastMode: false,
  onFastModeFallback: tier => console.warn(`Priority service unavailable: ${tier}`),
});
const membrane = new Membrane(adapter, { formatter: new OpenAIResponsesFormatter() });
```

The resolver runs for each outgoing call. An HTTP 401 triggers one additional
resolution with `forceRefresh: true`; the rejected body is closed first. A
second 401, any 403, or an error inside an accepted SSE stream is surfaced to the
caller without authentication replay. Credential resolution uses the same
cancellation/deadline signal as HTTP. Implementations should honor that signal;
Membrane stops waiting even if they do not. Implementations also own refresh
serialization when several callers share rotating credentials. Credentials are
never included in `onRequest` or `rawRequest` (which contain request bodies).

The same `credentials` option works for ordinary Responses API calls and takes
precedence over `apiKey`. Existing static API keys and environment defaults
continue to work. Subscription mode requires an explicit resolver and never
silently uses `OPENAI_API_KEY`.

Subscription mode defaults to `https://chatgpt.com/backend-api/codex` and uses SSE
for both `complete()` and `stream()`. It strips API-only sampling/output limits,
including overrides in `request.extra`. `setFastMode(true/false)` controls
`service_tier: 'priority'` and overrides any `extra.service_tier`. A reported
fallback tier invokes the optional callback once per adapter.

Native Responses items retain their metadata and encrypted reasoning. The
subscription compatibility path also accepts normalized maintenance text,
images, tool calls/results, and encrypted reasoning blocks. API mode retains its
existing verbatim native-input contract. Both modes share output reconstruction,
terminal-event validation, nested SSE error classification, and multiline SSE
parsing. Nonempty terminal output takes precedence over accumulated stream items.

Both modes declare cache-inclusive provider usage. Direct adapter callers see
OpenAI's inclusive `inputTokens`; Membrane converts that to disjoint fresh and
cached buckets exactly once. Applications migrating from CH's old direct adapter
must use Membrane's normalized result or account for this declared convention.

This seam is currently implemented by the Responses adapter. Other providers do
not acquire resolver support merely because the types are exported.

Co-authored by GPT-6 via OpenAI Codex.
