# Responses explicit prompt caching

OpenAI Responses API and Codex subscription callers can opt in per request.
Callers must select `OpenAIResponsesFormatter` to preserve marked message
boundaries reliably, either when constructing Membrane or per call:

```ts
import { Membrane, OpenAIResponsesFormatter } from '@animalabs/membrane';

const membrane = new Membrane(adapter, { formatter: new OpenAIResponsesFormatter() });
await membrane.complete({
  messages: [
    { participant: 'User', content: [{ type: 'text', text: 'Stable context' }], cacheBreakpoint: true },
    { participant: 'User', content: [{ type: 'text', text: 'Changing tail' }] },
  ],
  config: { model: 'gpt-5.6', maxTokens: 1000 },
  responsesPromptCache: { enabled: true, ttl: '12h' },
});
// Alternatively: membrane.complete(request, { formatter: new OpenAIResponsesFormatter() });
```

Set `responsesPromptCache` on the request itself, **not** in
`providerParams` or `extra`. The option has no effect on other adapters.
The generic/default formatter path delegates to
`NativeFormatter`, which merges same-role messages. When the option is on,
it refuses marked histories whose boundaries would be merged or lost rather
than silently writing after changing content; selecting
`OpenAIResponsesFormatter` avoids that refusal and retains the boundaries.

The same option is available on `ProviderRequest` for direct adapter callers.
It is off by default. Omitted or `enabled: false` preserves the previous wire
JSON, including existing `extra` passthrough behavior. No adapter-wide default
is added; an agent recipe can choose the option for each request.

## Marks and item boundaries

Only caller message-level `cacheBreakpoint: true` flags are Responses marks,
including on messages holding imported native items. Block `cache_control`
is **not** a Responses mark: it may have been synthesized by Membrane for
Anthropic. Responses writes and TTL are independent of Anthropic's
`promptCaching`, `cacheMarkers`, and `cacheTtl`. Existing Anthropic marker
validation still applies before the adapter (e.g. five imported block
`cache_control` markers with `cacheMarkers: 'cm-owned'` are refused). Use
`cacheBreakpoint` rather than importing Anthropic marks. Use
`OpenAIResponsesFormatter` to retain normalized message boundaries in both
transport modes.

Provenance travels on the items as reserved internal request-local data,
not in an identity-keyed registry. `beforeRequest` hooks may copy messages
with `{...r, messages: r.messages.map(x=>({...x}))}`, `structuredClone`, or
JSON round-trips without losing marks. The carrier is removed before wire
serialization and excluded from routing hashes, even if a hook disables or
deletes `responsesPromptCache`. Hooks that deliberately
rebuild items without copying their metadata must preserve their marks.
Enable the option on the normalized request **before formatting**, not for
the first time in `beforeRequest`: that provider-request hook runs after
formatting, when original message boundaries may already be lost. A late
enable can set TTL but cannot recover discarded normalized-message marks.
Disabling an initially enabled option in the hook is supported.

The subscription adapter also accepts generic messages. On the opt-in path,
`NativeFormatter` tracks marked message ends independently of Anthropic
caching. Its Anthropic normalizer reflows tool histories and merges same-role
messages: when that would put a marked end inside a merged envelope, move it
past later content, or lose it, the request **rejects with `invalid_request`
before fetch**. Move the mark to a preserved message boundary, disable
explicit caching, or use `OpenAIResponsesFormatter` for histories it supports.
Switching formatters does not make unsupported content such as system changes
supported by Responses. For example, marked User “stable” followed by
unmarked User “volatile” is refused,
not written after “volatile”. This conservative refusal avoids guessing where
to split a repaired generic history. Off-mode normalization remains unchanged.
System and tool-definition cache markers are not explicit input-item writes.

For each marked incoming message, its **last** emitted Responses input item
establishes the stable-prefix boundary. Only message-type items (including
the shorthand role/content form) receive the wire field. If the tail is a
tool/reasoning item, the write falls back to the **latest eligible item at or
before that boundary**, never to later unmarked content. A marked assistant
`[text, tool_use]` therefore writes on its text item, before the call, result,
and volatile continuation. If no eligible item exists, the mark is skipped
and a non-wire `console.warn` diagnostic on **stderr** reports
`[membrane:responses-prompt-cache] skipped marks: N` (an empty marked expansion
reports one skipped mark at formatting time). Multiple marks targeting one
item are deduplicated. The latest three eligible targets are retained; the
implicit request-tail write reserves the fourth slot. Input objects are not
mutated. Anthropic-only cache metadata is removed from the opt-in input.

## Wire fields and TTL

The extensions are **operator-reported and not verified against a live
provider**. Their names, budget, eligibility and TTL grammar are centralized in
`src/providers/responses-prompt-cache.ts`:

- Input item: `prompt_cache_breakpoint: { mode: 'explicit' }`.
- Optional top level: `prompt_cache_options: { ttl: '12h' }`.

TTL accepts a positive integral duration ending in `s`, `m`, `h`, or `d`, such
as `30s`, `5m`, `12h`, or `2d`. Invalid values reject with `invalid_request`
before fetch when enabled, rather than silently changing retention. TTL is
ignored when disabled; when omitted, no options field is generated. No server
maximum is assumed offline. Anthropic's `cacheTtl: '5m' | '1h'` is not widened.
When enabled this option owns the explicit-write budget and TTL field, replacing
raw input breakpoint fields and `extra.prompt_cache_options`; when disabled,
existing passthrough is untouched. `prompt_cache_key` and `session_id` routing
still use the original serialized head, before adding these annotations.

Verification uses mocked API and subscription HTTP requests. No cache-hit rate,
server TTL limits, or acceptance on tool/reasoning items was tested live.
