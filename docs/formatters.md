# Formatters

Formatters build provider requests, parse responses, encode tool definitions and results, and supply stop sequences. Membrane selects one active formatter for each call. The tool carrier, parser prefill, and actual transport representation are separate facts.

## Tool mode and defaults

Membrane defaults to native tools when the active formatter declares native support. This applies to `complete()`, `stream()`, and `streamYielding()`, with or without a tool list. With the default `AnthropicXmlFormatter`, resolved native mode builds a real native conversation through `NativeFormatter`; it does not manufacture an assistant prefix or the XML transcript's CLI scaffolding.

The mode is selected in this order:

1. An explicit request `toolMode: 'native'` or `'xml'`.
2. The active formatter's explicit constructor `configuredToolMode`.
3. The formatter's declared native capability.

`'auto'` uses that precedence rather than overriding a configured mode. When tools are declared, the selected formatter must support their carrier. A formatter without native support does not necessarily support XML tools.

To retain the transcript-prefill protocol, select XML explicitly on a compatible transport and model:

```typescript
await membrane.stream({
	messages,
	tools,
	toolMode: 'xml',
	config: { model: 'claude-haiku-4-5', maxTokens: 1024 },
});
```

The native and XML paths intentionally produce different request bytes and cache prefixes. Native mode preserves caller-authored assistant-ended history; it does not append an invented user turn or silently re-role that history to satisfy a provider restriction.

## Available formatters

### AnthropicXmlFormatter

This is Membrane's default formatter. It supports both native tool input and the explicit XML transcript protocol. Native mode uses native role/content blocks, native tool history and thinking, context prefixes, caller stop sequences, and the native media policy. XML mode uses participant-labelled transcript text, `<function_calls>`/`<function_results>`, parser prefill, and an optional literal `<thinking>` prefix.

The following options configure the XML representation:

```typescript
import { AnthropicXmlFormatter } from '@animalabs/membrane';

const formatter = new AnthropicXmlFormatter({
	toolMode: 'xml',
	toolInjectionMode: 'conversation', // or 'system'
	toolInjectionPosition: 10,         // messages from the end
	maxParticipantsForStop: 10,
});
```

Direct `buildMessages()` calls use the constructor's mode unless `BuildOptions.toolMode` supplies one. Membrane resolves the mode once for its selected path and passes it to the build. An explicit constructor mode also participates in Membrane's precedence above.

### NativeFormatter

This formatter maps participants to native user/assistant roles without a manufactured prefill. It supports native API tools, simple two-party or multiuser conversations, context prefixes, and caller-provided stop sequences. Multiuser mode can prefix non-assistant text with a configurable name format:

```typescript
import { NativeFormatter } from '@animalabs/membrane';

const formatter = new NativeFormatter({ nameFormat: '{name}: ' });
```

In simple mode, supply `humanParticipant` and `assistantParticipant`; other participants are rejected. Multiuser mode supports multiple names. Tool-pair normalization and media sanitation run in `buildMessages()`, including on native streaming and yielding paths. Native loop floating-cache placement is a separate post-build operation. Native names use the existing colon-to-double-underscore encoding. Returned calls are matched to declared names so literal double underscores survive. Colliding encoded definitions fail before dispatch.

### CompletionsFormatter

This formatter produces a single-prompt carrier for text-completion use. It supports end-of-turn tokens, configurable name/message separators, participant-derived stop sequences, and image stripping. It encodes neither native nor XML tool definitions, so tool-bearing Membrane requests using it fail with a typed `unsupported` error instead of silently losing the tools.

```typescript
import { CompletionsFormatter } from '@animalabs/membrane';

const formatter = new CompletionsFormatter({
	eotToken: '<|eot|>',
	nameFormat: '{name}: ',
	messageSeparator: '\n\n',
	maxParticipantsForStop: 10,
});
```

A prompt string may seed a parser through `assistantPrefill` without being an assistant-role Messages turn. The actual adapter determines that distinction. `OpenAICompletionsAdapter`, including a renamed instance, uses a prompt endpoint and remains exempt from the Messages-prefill rule. It rejects native `request.tools` that it would discard. For XML tools through this adapter, use an XML-capable formatter and an explicit `providerParams.prompt` carrying the tool description; that caller-owned prompt is preserved. The normal normalized-message serialization does not carry the formatter's injected XML definitions.

### OpenAIResponsesFormatter

The Responses formatter owns its provider-native input-item representation, including opaque reasoning and item identity. Membrane keeps its configured formatter authoritative when the Responses adapter requires that representation. It supports native tools, not XML tool definitions.

## Prefill compatibility

Some Anthropic models reject a Messages request whose final role is assistant. The original contribution measured this on 2026-08-25 for Sonnet 4.6, Opus 4.6/4.7/4.8, Sonnet 5, and Fable 5. The maintainer re-measured the table on 2026-09-14 and confirmed Opus 5 and Fable 5.1 as well. Haiku 4.5 and Sonnet 4.5 accepted prefill; Haiku also accepted prefill with thinking enabled. Mythos entries in the table remain labelled family inferences rather than new measurements. These live observations belong to the original contribution and maintainer review; the correction's tests use mocked transports.

The shared table is `src/registry/model-capabilities.ts`. It recognizes direct and dated IDs, dotted OpenRouter versions, `bedrock:` aliases, Bedrock inference-profile/ARN spellings, and Vertex suffixes. Unknown models retain the legacy capable default.

The Anthropic, Bedrock, OpenRouter, OpenAI Chat, and OpenAI-compatible adapters inspect the final converted model and message tail, after Membrane's `beforeRequest` hook and native parameter overrides. A known incompatible request fails locally with a non-retryable `unsupported` error. The error identifies the model and, for Membrane calls, the selected formatter. Use a native-capable formatter/native mode to avoid a manufactured prefill. If the supplied history itself ends with an assistant turn, provide a genuine user turn or choose a prefill-capable model.

XML streaming runners also declare that their continuation protocol needs assistant prefill. A message adapter can therefore reject an incompatible model before the first provider/tool round even if a custom formatter's first body is user-ended. Each later send is checked again, including plain and image continuations after a model/body override. `complete()` does not declare a future-loop requirement because it does not execute a tool loop.

`ProviderRequestOptions.requestContext` carries `formatterName`, resolved `toolMode`, `toolsDeclared`, and `requiresAssistantPrefill` outside provider JSON and cache receipts. Adapter decorators forward options unchanged. Third-party adapters receive this context and own validation of their final representation; the transport checks described here cover the listed built-ins. A formatter name alone cannot establish transport semantics.

## Prompt caching

Anthropic allows up to four cache-control breakpoints across messages, system content, and tools. A breakpoint on a message covers that message and its preceding prefix.

### Explicit breakpoints

```typescript
const messages: NormalizedMessage[] = [
	{ participant: 'User', content: [...] },
	{ participant: 'Claude', content: [...], cacheBreakpoint: true },
	{ participant: 'User', content: [...] },
	{ participant: 'Claude', content: [...], cacheBreakpoint: true },
	{ participant: 'User', content: [...] },
];
```

### Callback-based breakpoints

A direct formatter build can mark the boundary before a message:

```typescript
const result = formatter.buildMessages(messages, {
	participantMode: 'multiuser',
	assistantParticipant: 'Claude',
	promptCaching: true,
	hasCacheMarker: (_message, index) => index === someDynamicIndex,
});
```

With prompt caching enabled, explicit message breakpoints and context-prefix markers are retained. System/tool fallback markers depend on the selected representation and existing markers; they are not unconditional extra markers. A formatter's optional `cacheMarkersApplied` describes its build-time count. Membrane's reported request count is reconciled with its final marker policy.

For `cacheMarkers: 'membrane-system'`, Membrane applies the complete-request clamp after hooks, retaining the deepest permitted markers. For `cacheMarkers: 'cm-owned'`, it rejects an excess budget instead of displacing caller-owned markers. Native streaming still spends only the remaining budget on floating tool-loop markers and withholds them across prefix-rewriting normalization repairs.

Standalone `NativeFormatter.buildMessages()` checks its complete built budget by default. `BuildOptions.deferCacheBudgetCheck: true` explicitly delegates that check to a later complete-request boundary, as Membrane does; CM-owned builds still assert their budget. Thus native Membrane calls share the final clamp policy while standalone callers keep a usable fail-loud boundary. The shared native build also changes native-stream semantic cache-receipt hashes because its provider-request representation includes the normalized-message metadata used by prompt transports; this metadata is not sent as provider JSON.

## Selecting a formatter

### Instance-level selection

```typescript
import { Membrane, AnthropicXmlFormatter } from '@animalabs/membrane';

const membrane = new Membrane(adapter, {
	formatter: new AnthropicXmlFormatter({ toolMode: 'xml' }),
});
```

### Per-call selection

`complete()` and `stream()` accept a formatter override in their second argument:

```typescript
await membrane.stream(request, { formatter: new NativeFormatter() });
```

Yielding calls use the instance formatter and the request's tool-mode choice. The configured Responses formatter remains authoritative when the transport requires Responses input items.

## Creating custom formatters

Implement `PrefillFormatter` and declare both carrier flags as booleans. Missing declarations in JavaScript produce an explicit diagnostic; absence does not silently select XML. `usesPrefill` describes parser seeding, not an exemption from a transport's prefill restriction.

```typescript
import type { PrefillFormatter, BuildOptions, BuildResult } from '@animalabs/membrane';

class CustomFormatter implements PrefillFormatter {
	readonly name = 'custom';
	readonly usesPrefill = true;
	readonly supportsNativeTools = false;
	readonly supportsXmlTools = true;

	buildMessages(messages, options: BuildOptions): BuildResult {
		// Encode the selected carrier, preserving caller fields and ownership.
		return { messages: [...], assistantPrefill: '...', stopSequences: [...] };
	}

	createStreamParser() {
		// Return a parser for this representation.
	}

	parseToolCalls(content) { return []; }
	hasToolUse(content) { return false; }
	parseContentBlocks(content) { return [{ type: 'text', text: content }]; }
	formatToolResults(results) { return JSON.stringify(results); }
}
```

The unmerged PR's former `buildsAssistantMessagePrefill` flag is replaced by the actual native/XML carrier declarations. A formatter may manufacture no prefill while the caller's history still ends with assistant; conversely a prompt adapter may turn an assistant envelope into ordinary prompt text. Final transport checks and XML-runner context handle those separate cases.
