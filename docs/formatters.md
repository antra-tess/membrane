# Formatters

Formatters control how conversations are serialized for different LLM providers and models. They handle:

- **Request building**: Converting normalized messages to provider-specific format
- **Response parsing**: Parsing streaming responses and extracting content blocks
- **Tool handling**: Formatting tool definitions and results
- **Stop sequences**: Generating appropriate stop conditions

## Available Formatters

### AnthropicXmlFormatter

The default formatter for Anthropic Claude models. Uses prefill-based formatting with XML tool syntax.

```typescript
import { AnthropicXmlFormatter } from '@animalabs/membrane';

const formatter = new AnthropicXmlFormatter({
  toolMode: 'xml',                    // 'xml' or 'native'
  toolInjectionMode: 'conversation',  // 'conversation' or 'system'
  toolInjectionPosition: 10,          // messages from end
  maxParticipantsForStop: 10,
});
```

**Features:**
- Participant-based message format (Name: content)
- XML tool syntax (<function_calls>, <function_results>)
- <thinking> block support for extended thinking
- Prompt caching with cache_control markers (see below)
- Context prefix for simulacrum seeding

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

## Usage

### Instance-level formatter

```typescript
import { Membrane, AnthropicXmlFormatter } from '@animalabs/membrane';

const membrane = new Membrane(adapter, {
  formatter: new AnthropicXmlFormatter({ toolMode: 'xml' }),
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
  readonly usesPrefill = true;

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
