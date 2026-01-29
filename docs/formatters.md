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
- Prompt caching with cache_control markers
- Context prefix for simulacrum seeding

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
