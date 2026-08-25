# Formatters

Formatters control how conversations are serialized for different LLM providers and models. They handle:

- **Request building**: Converting normalized messages to provider-specific format
- **Response parsing**: Parsing streaming responses and extracting content blocks
- **Tool handling**: Formatting tool definitions and results
- **Stop sequences**: Generating appropriate stop conditions

## Available Formatters

### AnthropicXmlFormatter

The default formatter for Anthropic Claude models. Builds a participant-style
prefill conversation, and can carry tools either natively or as XML.

```typescript
import { AnthropicXmlFormatter } from '@animalabs/membrane';

const formatter = new AnthropicXmlFormatter({
  toolInjectionMode: 'conversation',  // 'conversation' or 'system'
  toolInjectionPosition: 10,          // messages from end
  maxParticipantsForStop: 10,
});
```

**Features:**
- Participant-based message format (Name: content)
- Native tool definitions by default; XML tool syntax
  (<function_calls>, <function_results>) on explicit opt-in
- <thinking> block support for extended thinking
- Prompt caching with cache_control markers (see below)
- Context prefix for simulacrum seeding

## Tool mode

**Tools go through the provider's native tool channel by default.** XML tools
are an explicit opt-in, or the fallback for a formatter that has no native
tool channel at all (`CompletionsFormatter`).

```typescript
await membrane.stream({
  messages,
  tools,
  toolMode: 'xml',   // 'auto' (default) | 'native' | 'xml'
  config: { model: 'claude-haiku-4-5', maxTokens: 1024 },
});
```

Under `'auto'`, the mode follows the formatter's own declared
`supportsNativeTools`: native wherever a tool channel exists.

XML tools ride in an assistant prefill, so an XML-mode request ends the
conversation on an assistant turn. Current Anthropic models refuse that shape
outright — measured live 2026-08-25, `claude-sonnet-4-6`, `claude-opus-4-6/4-7/4-8`,
`claude-sonnet-5` and `claude-fable-5` answer HTTP 400 "This model does not
support assistant message prefill", while `claude-haiku-4-5` and
`claude-sonnet-4-5` accept it. Membrane refuses such a request locally, with a
typed `unsupported` error naming the model, the formatter and the remedy,
instead of shipping a round-trip whose only outcome is that 400. The measured
table lives in `src/registry/model-capabilities.ts`.

That refusal is scoped to formatters that genuinely build an **assistant-role
Messages turn** (`buildsAssistantMessagePrefill`). A text-completions surface
is unaffected: `CompletionsFormatter` reports its whole prompt as
`assistantPrefill`, but it never builds a Messages conversation, so any model
id is free to target it.

Note that `AnthropicXmlFormatter`'s own constructor also takes a `toolMode`
option. That one is read only by `buildMessages` — it decides whether the
formatter emits native tool definitions when membrane has already selected the
prefill request builder. The request-level `toolMode` above is what chooses
between the two request builders, and it is the one callers want.

## Prompt Caching

Anthropic supports prompt caching to reduce costs for repeated prefixes. Membrane provides two ways to control cache breakpoints:

### 1. Explicit cache breakpoints (recommended)

Set `cacheBreakpoint: true` on messages that should be cached:

```typescript
const messages: NormalizedMessage[] = [
  { participant: 'User', content: [...] },
  { participant: 'Claude', content: [...], cacheBreakpoint: true }, // Cache up to here
  { participant: 'User', content: [...] },
  { participant: 'Claude', content: [...], cacheBreakpoint: true }, // Second cache point
  { participant: 'User', content: [...] },
  { participant: 'Claude', content: [...] }, // Current turn
];
```

This gives you full control over where cache boundaries are placed. Anthropic supports up to 4 cache breakpoints.

### 2. Callback-based (for automatic rolling cache)

Use `hasCacheMarker` callback for dynamic cache boundaries:

```typescript
const result = formatter.buildMessages(messages, {
  promptCaching: true,
  hasCacheMarker: (message, index) => {
    // Your logic to determine cache boundaries
    return index === someDynamicIndex;
  },
});
```

### Cache marker behavior

When `promptCaching: true`:
- System prompt automatically gets `cache_control`
- Context prefix (if provided) gets `cache_control`
- Messages with `cacheBreakpoint: true` flush with `cache_control`
- `hasCacheMarker` callback flushes content BEFORE the marked message

The `cacheMarkersApplied` count in `BuildResult` tells you how many markers were applied.

### NativeFormatter

Pass-through formatter for native API usage without prefill.

```typescript
import { NativeFormatter } from '@animalabs/membrane';

const formatter = new NativeFormatter({
  nameFormat: '{name}: ',
});
```

**Features:**
- Direct user/assistant role mapping
- Native API tool calling
- No stop sequences (API handles)
- Simple and multiuser modes

### CompletionsFormatter

Formatter for base/completion models (e.g., /v1/completions endpoint).

```typescript
import { CompletionsFormatter } from '@animalabs/membrane';

const formatter = new CompletionsFormatter({
  eotToken: '<|eot|>',
  nameFormat: '{name}: ',
  messageSeparator: '\n\n',
  maxParticipantsForStop: 10,
});
```

**Features:**
- Single-prompt serialization
- End-of-turn tokens
- Auto-generated stop sequences from participants
- Images stripped (not supported)
- No native tool channel, so `toolMode: 'auto'` resolves to XML here
- Not a Messages conversation: the assistant-prefill capability check does
  not apply, so any model id may target this surface (see Tool mode)

## Usage

### Instance-level formatter

```typescript
import { Membrane, AnthropicXmlFormatter } from '@animalabs/membrane';

const membrane = new Membrane(adapter, {
  formatter: new AnthropicXmlFormatter(),
});
```

### Per-request override

```typescript
import { NativeFormatter } from '@animalabs/membrane';

await membrane.stream({
  formatter: new NativeFormatter(),
  // ...other options
});
```

## Creating Custom Formatters

Implement the PrefillFormatter interface:

```typescript
import type { PrefillFormatter, BuildOptions, BuildResult } from '@animalabs/membrane';

class CustomFormatter implements PrefillFormatter {
  readonly name = 'custom';
  /** Seeds the stream parser with built text (vs native pass-through). */
  readonly usesPrefill = true;
  /** Can buildMessages populate BuildResult.nativeTools? Drives auto tool mode. */
  readonly supportsNativeTools = false;
  /** Does the built request END on a real assistant-role Messages turn? */
  readonly buildsAssistantMessagePrefill = true;

  buildMessages(messages, options): BuildResult {
    // Convert messages to your format
    return {
      messages: [...],
      assistantPrefill: '...',
      stopSequences: [...],
    };
  }

  createStreamParser() {
    // Return a parser for your format
  }

  parseToolCalls(content) {
    // Extract tool calls from content
    return [];
  }

  hasToolUse(content) {
    return false;
  }

  parseContentBlocks(content) {
    return [{ type: 'text', text: content }];
  }

  formatToolResults(results) {
    return JSON.stringify(results);
  }
}
```
