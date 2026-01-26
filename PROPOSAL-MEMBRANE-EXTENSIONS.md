# Membrane Extension Proposal

## Overview

Extensions to Membrane's capabilities for broader provider support, blob handling, and multi-format conversations.

---

## 1. Blob Reference Support

### Motivation
Passing large media as base64 through the call stack is memory-inefficient. Blob references enable lazy loading at the last moment (when building the actual API request).

### New Types

```typescript
// types/content.ts

export interface BlobSource {
  type: 'blob';
  blobId: string;
  mediaType: string;  // Known upfront for content-type headers
  sizeBytes?: number; // Optional, for pre-validation
}

export type MediaSource = Base64Source | UrlSource | BlobSource;
```

### Configuration

```typescript
// types/config.ts

export interface BlobLoader {
  /**
   * Load blob data by ID. Returns base64-encoded string.
   * Called lazily when building the actual API request.
   */
  load(blobId: string): Promise<string>;
  
  /**
   * Store blob data, returns blob ID.
   * Used for externalizing large data from responses/logs.
   */
  store(data: string, mediaType: string): Promise<string>;
}

export interface MembraneConfig {
  // ... existing ...
  blobLoader?: BlobLoader;
}
```

### Sync vs Async Question

**Should `blobLoader.load()` be sync or async?**

Arguments for **async**:
- Blob storage may be on disk, network, or database
- Allows streaming/chunked loading for very large files
- More flexible for different storage backends
- Standard pattern for I/O operations

Arguments for **sync**:
- Simpler call sites (no await threading through transform functions)
- Provider adapters are currently sync in some paths
- Could pre-load all blobs before transform (but loses lazy benefit)

**Recommendation**: Async. The complexity is manageable, and it enables:
- Database-backed blob stores
- Remote/distributed storage
- Lazy loading (don't load blobs for messages that get truncated)

The cost is that `transformToPrefill` and provider formatting become async, but they're already async in practice due to image resizing.

---

## 2. Multi-Provider Message Formats

### Current State
Membrane has prefill transform (participant-based log format). Need to add:
- Anthropic messages format (standard API)
- OpenAI messages format
- Gemini messages format
- Gemini prefill format (with `<|eot|>`)

### Transform Pipeline Architecture

**Option A: `formatMode` enum**
```typescript
formatMode: 'prefill' | 'anthropic_messages' | 'openai_messages' | 'gemini_messages' | 'gemini_prefill'
```
- Simple to use
- Rigid - hard to compose behaviors
- Provider logic scattered across switch statements

**Option B: Transform Pipeline**
```typescript
interface TransformPipeline {
  /** Convert NormalizedMessage[] to provider-specific format */
  transform(messages: NormalizedMessage[], options: TransformOptions): ProviderMessages;
  
  /** Build stop sequences for this format */
  buildStopSequences(participants: string[], options: StopOptions): string[];
  
  /** Parse provider response back to normalized blocks */
  parseResponse(response: unknown): ContentBlock[];
}

// Usage
const pipeline = getPipeline('gemini_prefill');
const { messages, stopSequences } = pipeline.transform(request.messages, options);
```
- Composable - can mix and match behaviors
- Clear separation of concerns
- Easier to add new formats
- Each pipeline is self-contained and testable

**Option C: Hybrid - Provider + Mode**
```typescript
interface TransformConfig {
  provider: 'anthropic' | 'openai' | 'gemini';
  mode: 'messages' | 'prefill';
  options?: ProviderSpecificOptions;
}
```
- Provider determines base format (API structure)
- Mode determines conversation style (prefill vs standard)
- Options handle provider-specific quirks

**Recommendation**: Option C (Hybrid). It maps to reality:
- Each provider has its own API format (non-negotiable)
- Prefill vs messages is an orthogonal choice
- Provider-specific options handle edge cases

### Gemini Prefill Specifics

Gemini prefill requires `<|eot|>` (end-of-turn) token after each message:

```typescript
interface GeminiPrefillOptions {
  /** End-of-turn token. Default: '<|eot|>' */
  eotToken?: string;
  
  /** Include eot in stop sequences */
  stopOnEot?: boolean;
}

// Transform output for Gemini prefill:
// "Alice: Hello<|eot|>Bob: Hi there<|eot|>Claude:"
```

Stop sequence handling:
- Gemini may return `<|eot|>` as the stop reason
- Need to strip it from output and recognize as end_turn

---

## 3. Image Generation Support

### Providers
- **Gemini**: gemini via Gemini API
- **OpenAI**: gptimage1/gptimage1.5 via messages api or responses api

### New Content Type

Already exists: `GeneratedImageContent`. Extend with generation metadata:

```typescript
export interface GeneratedImageContent {
  type: 'generated_image';
  data: string;           // Base64 image data
  mimeType: string;
  blobId?: string;        // If externalized to blob storage
  isPreview?: boolean;    // Streaming: preview vs final
  
  // Generation metadata
  generation?: {
    prompt: string;       // The prompt used
    revisedPrompt?: string; // Model's revised prompt (OpenAI returns this)
    model: string;        // imagen-3, dall-e-3, etc.
    size?: string;        // 1024x1024, etc.
    quality?: string;     // standard, hd
  };
}
```

### Streaming Considerations

Image generation during streaming:
1. Model outputs text mentioning it will generate an image
2. Model emits tool_use for image generation (or native image block)
3. Image data streams (possibly as preview → final)
4. Model continues with text after image

Callback additions:
```typescript
interface StreamOptions {
  // ... existing ...
  
  /** Called when image generation starts */
  onImageStart?: (prompt: string) => void;
  
  /** Called with image preview (low-res) */
  onImagePreview?: (image: GeneratedImageContent) => void;
  
  /** Called with final image */
  onImage?: (image: GeneratedImageContent) => void;
}
```

### Blob Integration

Generated images should optionally externalize to blob storage:

```typescript
interface MembraneConfig {
  // ... existing ...
  
  /** Auto-externalize generated images to blob storage */
  externalizeGeneratedImages?: boolean;
}
```

When enabled, `GeneratedImageContent.data` is replaced with `blobId` after generation.

---

## 4. Participant Name Suppression

### Rules

```typescript
export interface ParticipantSuppressionRules {
  /** Skip name for empty/whitespace names. Default: true */
  suppressEmptyNames?: boolean;
  
  /** Skip name for consecutive same-participant turns. Default: false */
  suppressConsecutiveSameParticipant?: boolean;
  
  /** Always suppress these participants */
  alwaysSuppressParticipants?: string[];
  
  /** Custom predicate */
  customSuppression?: (
    message: NormalizedMessage,
    previous: NormalizedMessage | null,
    context: { isConsecutive: boolean; isEmpty: boolean }
  ) => boolean;
}
```

### Application

These rules apply to prefill-style formats where participant names are injected into content. For standard messages format, names go in a separate field and suppression doesn't apply.

---

## 5. Extended Thinking Handling

### Unsigned Thinking Conversion

When thinking blocks lack signatures (e.g., imported from external sources), they cannot be sent as structured thinking to Anthropic.

**Opt-in conversion flag:**
```typescript
interface ThinkingOptions {
  /**
   * Convert unsigned thinking blocks to XML-wrapped text.
   * Use with caution - may cause unexpected behavior if thinking 
   * was expected to be structured.
   * Default: false (unsigned thinking throws an error)
   */
  convertUnsignedThinkingToText?: boolean;
}
```

**Behavior:**
- `false` (default): Unsigned thinking block → Error with clear message
- `true`: Unsigned thinking block → `<thinking>...</thinking>` text block

This makes the conversion explicit and discoverable when debugging.

---

## 6. Debug Data Externalization

### Motivation

Request/response logs contain large embedded media. For long-term storage, externalize to blob storage.

### Utility

```typescript
// utils/debug-sanitizer.ts

export interface SanitizeOptions {
  /** Byte threshold above which to externalize. Default: 10KB */
  blobThreshold?: number;
  
  /** Blob loader for storing externalized data */
  blobLoader: BlobLoader;
  
  /** Paths to always externalize regardless of size */
  alwaysExternalizePaths?: string[];
}

/**
 * Deep-walk object, replacing large base64 strings with blob references.
 * Returns sanitized object suitable for storage.
 */
export async function sanitizeForStorage(
  obj: unknown,
  options: SanitizeOptions
): Promise<unknown>;

/**
 * Restore blob references to inline data.
 * For viewing debug logs.
 */
export async function restoreFromStorage(
  obj: unknown,
  blobLoader: BlobLoader
): Promise<unknown>;
```

### Sanitization Format

```typescript
// Original
{
  content: [{ type: 'image', source: { type: 'base64', data: '...huge...' } }]
}

// Sanitized
{
  content: [{ 
    type: 'image', 
    source: { 
      type: 'base64', 
      data: { __blobRef: 'abc123', originalSize: 1048576, mediaType: 'image/png' }
    } 
  }]
}
```

The `__blobRef` marker is unambiguous and reversible.

---

## 7. Provider Adapter Updates

### Anthropic Adapter
- Already functional
- Add: blob resolution before request
- Add: unsigned thinking validation/conversion

### OpenAI Adapter
- Messages format with roles
- Tool support (function calling)
- Image generation (DALL-E)
- Vision (images in user messages)

### Gemini Adapter
- Messages format (contents array)
- Prefill format with `<|eot|>`
- Image generation (Imagen)
- Multi-modal input
- Thinking/reasoning support (Gemini 2.0)

---

## Implementation Phases

### Phase 1: Core Infrastructure
- Blob source type and loader interface
- Async blob resolution in transforms
- Debug sanitization utility

### Phase 2: Multi-Format Support
- Transform pipeline architecture
- Anthropic messages transform
- OpenAI messages transform
- Gemini messages transform
- Gemini prefill transform (with `<|eot|>`)

### Phase 3: Provider Features
- OpenAI adapter (full)
- Gemini adapter (full)
- Image generation support
- Extended thinking with opt-in unsigned conversion

### Phase 4: Polish
- Participant suppression rules
- Comprehensive tests for each format
- Documentation

---

## Open Questions

1. **Stop sequence normalization**: Should Membrane normalize stop sequences across providers, or expose provider-specific behavior?

2. **Image generation API**: Tool-based (model calls a tool) vs native (model outputs image block directly) - support both?

3. **Thinking signature validation**: Should Membrane validate signatures or trust the provider to reject invalid ones?

4. **Response caching**: Should Membrane have built-in response caching, or leave to consumers?

5. **Rate limiting**: Built-in rate limit handling with backoff, or leave to consumers?
