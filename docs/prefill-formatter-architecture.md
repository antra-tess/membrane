# Prefill Formatter Architecture

## Status

**Implemented in v0.4.0:**
- ✅ Phase 1: Core interfaces and implementations
- ✅ Phase 2: Complete membrane integration
  - `formatter.createStreamParser()` for stream parsing
  - `formatter.buildMessages()` for ALL request building (replaces transformToPrefill)
  - Cache control support (`promptCaching` option)
  - Context prefix support (simulacrum seeding)
  - Conversation cache markers (`hasCacheMarker` callback)
  - Additional stop sequences support
  - Max participants for stop configuration
- ✅ Per-request formatter override support (`StreamOptions.formatter`)
- ✅ Unit tests for formatters (54 tests)
- ✅ `transformToPrefill` fully removed (code, exports, and tests deleted)
- ✅ Phase 3 (partial): CompletionsFormatter for base models

**Remaining:**
- Phase 3 (remaining): ChatMLFormatter (Llama-style)
- Phase 4: Full configuration options and documentation

## Goal

Decouple prefill formatting and parsing from membrane core to support multiple formats:
- Anthropic XML (current)
- Llama/ChatML
- Custom formats for base models
- No prefill (native mode)

## Current State

Tightly coupled in `membrane.ts`:
- `IncrementalXmlParser` for XML depth tracking
- `parseToolCalls()` for `<function_calls>` extraction
- `formatToolResults()` for `<function_results>` injection
- Hardcoded stop sequences (`\nHuman:`, `\nUser:`)
- Thinking block handling (`<thinking>`)

## Proposed Architecture

### Core Interface

```typescript
interface PrefillFormatter {
  readonly name: string;

  // ============================================
  // REQUEST BUILDING
  // ============================================

  /**
   * Transform normalized messages into provider-ready format.
   * Returns messages + any assistant prefill content.
   */
  buildMessages(
    messages: NormalizedMessage[],
    options: BuildOptions
  ): {
    messages: ProviderMessage[];
    assistantPrefill?: string;
    stopSequences: string[];
  };

  /**
   * Format tool definitions for this format.
   * Returns undefined if tools should be passed natively.
   */
  formatToolDefinitions?(tools: ToolDefinition[]): string | undefined;

  /**
   * Format tool results for continuation.
   */
  formatToolResults(results: ToolResult[]): string;

  // ============================================
  // RESPONSE PARSING
  // ============================================

  /**
   * Create a stream parser for this format.
   * Parser tracks state across chunks (e.g., XML depth).
   */
  createStreamParser(): StreamParser;

  /**
   * Parse tool calls from accumulated content.
   * Returns empty array if no tool calls detected.
   */
  parseToolCalls(content: string): ToolCall[];

  /**
   * Check if content indicates tool use (for stop reason).
   */
  hasToolUse(content: string): boolean;
}

interface BuildOptions {
  participantMode: 'simple' | 'multiuser';
  assistantParticipant: string;
  humanParticipant?: string;  // for simple mode
  tools?: ToolDefinition[];
  thinking?: { enabled: boolean };
  systemPrompt?: string | ContentBlock[];
}

interface FormatterConfig {
  /** How to handle unsupported media (images, etc.) */
  unsupportedMedia?: 'error' | 'strip';  // default: 'error'

  /** Warn when stripping content */
  warnOnStrip?: boolean;  // default: true
}
```

### Stream Parser Interface

```typescript
interface StreamParser {
  /**
   * Process a chunk of streamed content.
   * Returns parsed events (text, blocks, etc.)
   */
  processChunk(chunk: string): ParseResult;

  /**
   * Flush any buffered content at end of stream.
   */
  flush(): ParseResult;

  /**
   * Get full accumulated content.
   */
  getAccumulated(): string;

  /**
   * Reset parser state.
   */
  reset(): void;

  /**
   * Push content without emitting (for prefill initialization).
   */
  push(content: string): void;

  /**
   * Get current block type being parsed.
   */
  getCurrentBlockType(): BlockType;

  /**
   * Get current block index.
   */
  getBlockIndex(): number;
}

interface ParseResult {
  emissions: Array<TextEmission | BlockEvent>;
}
```

### Built-in Formatters

#### 1. AnthropicXmlFormatter (current behavior)

```typescript
class AnthropicXmlFormatter implements PrefillFormatter {
  constructor(options: {
    toolMode: 'xml' | 'native';
    participantFormat: '{name}:' | custom;
  });
}
```

- Messages: `Human: content\n\nAssistant: content`
- Tools: `<function_calls>` / `<function_results>` XML
- Parser: `IncrementalXmlParser` (existing)
- Stop sequences: Generated from participant names

#### 2. NativeFormatter (no prefill)

```typescript
class NativeFormatter implements PrefillFormatter {
  constructor(options: {
    participantMode: 'simple' | 'multiuser';
    nameFormat?: string;  // for multiuser
  });
}
```

- Messages: Direct user/assistant roles
- Tools: Native API tool calling
- Parser: Pass-through (no special parsing)
- Stop sequences: None (API handles)

#### 3. ChatMLFormatter (Llama, etc.)

```typescript
class ChatMLFormatter implements PrefillFormatter {
  constructor(options: {
    userToken: string;      // e.g., '<|user|>'
    assistantToken: string; // e.g., '<|assistant|>'
    endToken: string;       // e.g., '<|end|>'
    toolFormat?: 'json' | 'xml';
  });
}
```

#### 4. CompletionsFormatter (base models) ✅ Implemented

```typescript
class CompletionsFormatter implements PrefillFormatter {
  constructor(options: {
    eotToken?: string;          // default: '<|eot|>'
    nameFormat?: string;        // default: '{name}: '
    messageSeparator?: string;  // default: '\n\n'
    maxParticipantsForStop?: number;  // default: 10
    warnOnImageStrip?: boolean; // default: true
  });
}
```

- Messages: `Participant: content<eot>` format
- Tools: Not supported (base models)
- Parser: Pass-through (no special parsing)
- Stop sequences: Generated from participant names + EOT token
- Images: Stripped with warning (not supported in completions mode)

## Migration Plan

### Phase 1: Extract Interface

1. Define `PrefillFormatter` and `StreamParser` interfaces
2. Create `AnthropicXmlFormatter` from existing code
3. Keep `membrane.ts` working with formatter instance

### Phase 2: Refactor membrane.ts

1. Replace hardcoded XML logic with formatter calls
2. `streamWithXmlTools` → `streamWithPrefill(formatter)`
3. `streamWithNativeTools` → `streamWithPrefill(NativeFormatter)`
4. Unify the two streaming paths

### Phase 3: Add Formatters

1. `NativeFormatter` for simple pass-through
2. `ChatMLFormatter` for Llama-style models
3. Move `OpenAICompletionsAdapter` serialization to `CompletionsFormatter`

### Phase 4: Configuration

```typescript
// Instance-level default
const membrane = new Membrane(adapter, {
  formatter: new AnthropicXmlFormatter({ toolMode: 'xml' }),
  // or
  formatter: 'anthropic-xml',  // shorthand
  // or
  formatter: null,  // no prefill, native mode
});

// Per-request override
await membrane.stream({
  formatter: new NativeFormatter(),
  // ...
});
```

## File Structure

```
src/
  formatters/
    index.ts              # Exports all formatters
    types.ts              # PrefillFormatter, StreamParser interfaces
    anthropic-xml.ts      # AnthropicXmlFormatter ✅
    native.ts             # NativeFormatter ✅
    completions.ts        # CompletionsFormatter ✅
    chatml.ts             # ChatMLFormatter (TODO)
  utils/
    stream-parser.ts      # IncrementalXmlParser (used by AnthropicXmlFormatter)
```

## Design Decisions

1. **Thinking blocks**: Format-specific.
   - Each formatter handles its own thinking block format
   - Anthropic: `<thinking>` XML tags
   - Others: Their own conventions or not supported

2. **Tool definitions**: Formatter decides, configurable.
   - Formatter chooses: serialize into prompt OR pass to native API
   - Configurable per formatter instance
   - Examples:
     - `AnthropicXmlFormatter({ toolMode: 'xml' })` → XML in prompt
     - `AnthropicXmlFormatter({ toolMode: 'native' })` → native API
     - `NativeFormatter()` → always native API

3. **Media handling**: Crash by default, configurable to ignore.
   - If formatter doesn't support images, throw error by default
   - Option to configure: `{ unsupportedMedia: 'error' | 'strip' }`
   - When 'strip': remove media, optionally warn

4. **Cache control**: Provider-specific, passed through.
   - Formatters that support it (Anthropic) preserve cache_control
   - Others ignore it silently

5. **Stop sequences**: Formatter-generated.
   - Each formatter knows what stop sequences it needs
   - Anthropic: participant-based (`\nHuman:`, `\nAlice:`)
   - ChatML: token-based (`<|end|>`)
   - Native: none (API handles)
