# Streaming Enhancements for Membrane

## Context

This document summarizes findings from analyzing the ChapterX membrane integration branch (`feature/membrane-integration`) and proposes enhancements to membrane's streaming API to support real-time TTS and other use cases.

## Terminology: "Blocks"

This document uses "block" to refer to **membrane's logical content regions**:

| Term | Meaning |
|------|---------|
| **Membrane block** | Logical content region at the context level: text, thinking, tool_call, tool_result. These are abstract structures, not tied to any wire format. |
| **API content block** | Anthropic's `ContentBlock` in response structure: `{ type: 'text' }`, `{ type: 'tool_use' }`, `{ type: 'thinking' }` |

Membrane blocks are a **higher-level abstraction**. How they're serialized depends on the mode:

- **Prefill mode**: Blocks are rendered as XML tags (`<thinking>`, `<function_calls>`, etc.) in the outgoing request. The LLM continues in this format, and membrane parses the XML back into logical blocks.

- **Chat mode**: Blocks map to native API content blocks. No XML involved.

The streaming enhancements proposed here operate at the **membrane block level** - the callbacks should provide the same logical block information regardless of whether the underlying transport used XML or native API structures.

### Callback Consistency Guarantee

**`onChunk` and `onBlock` must always be called**, even when:
- The underlying API does not support streaming
- The API does not support streaming for a particular block type (e.g., thinking arrives all at once)

In non-streaming cases, the full content is delivered as a single chunk. The callbacks are interleaved (not sequential):

```
# Streaming API (many small chunks)
onBlock({ event: 'block_start', index: 0, block: { type: 'text' } })
onChunk("The ", { type: 'text', visible: true, blockIndex: 0 })
onChunk("answer ", { type: 'text', visible: true, blockIndex: 0 })
onChunk("is 42.", { type: 'text', visible: true, blockIndex: 0 })
onBlock({ event: 'block_complete', index: 0, block: { type: 'text', content: 'The answer is 42.' } })

# Non-streaming API (single chunk = full block)
onBlock({ event: 'block_start', index: 0, block: { type: 'text' } })
onChunk("The answer is 42.", { type: 'text', visible: true, blockIndex: 0 })
onBlock({ event: 'block_complete', index: 0, block: { type: 'text', content: 'The answer is 42.' } })
```

This ensures consumers can rely on a consistent interface without needing to know the underlying API's streaming capabilities.

### XML Tags Are Not Content

XML tags (`<thinking>`, `</thinking>`, `<function_calls>`, etc.) are **wire format artifacts of prefill mode** and should **not** flow through `onChunk`. The membrane abstraction emits only logical content:

- **Prefill mode**: Membrane parses XML internally, emits only inner content via `onChunk`
- **Chat mode**: API provides structured content, membrane emits it via `onChunk`
- **Both modes**: Same logical content, same callbacks, no wire format leaking through

### Block Boundaries and Indices

Content always belongs to a well-defined "current block". Block indices are assigned as boundaries are detected:

1. First token arrives → implicit text block starts (index 0)
2. `<thinking>` detected → block 0 completes, block 1 (thinking) starts
3. `</thinking>` detected → block 1 completes, block 2 (text) starts
4. And so on...

There is never ambiguity about which block a chunk belongs to.

### Partial Tag Buffering

When streaming in prefill mode, membrane buffers potential XML tag starts (e.g., `<t` could be `<thinking>`) until they can be classified. This introduces milliseconds of latency, which is acceptable for TTS use cases. Once classified:
- If it's a membrane tag → suppress (don't emit via `onChunk`)
- If it's not a membrane tag (e.g., `<b>` in text) → emit as visible content

## Current State

### Streaming Callbacks in Membrane

```typescript
interface StreamOptions {
  onChunk?: (chunk: string) => void;              // Raw tokens
  onContentBlockUpdate?: (index, block) => void;  // Block updates
  onToolCalls?: (calls, context) => Promise<ToolResult[]>;
  onPreToolContent?: (content: string) => void;   // Content before tools
  onUsage?: (usage) => void;
  onBlock?: (event: BlockEvent) => void;          // Structured block events
  maxToolDepth?: number;
  toolTimeoutMs?: number;
}
```

### What Works

1. **`onChunk`** - Emits raw tokens immediately as they arrive from the LLM
2. **`onToolCalls`** - Executes tools and returns results for continuation
3. **`onPreToolContent`** - Notifies before tool execution (batched, not streaming)
4. **`IncrementalXmlParser`** - Tracks block depth in prefill mode (parses XML tags). In chat mode, block boundaries come from native API events instead.

### Deprecation: `onContentBlockUpdate`

The `onContentBlockUpdate` callback is superseded by `onBlock` and enriched `onChunk`:
- `onBlock` provides structured block_start/block_complete events
- `onChunk` with metadata provides streaming content with block context

`onContentBlockUpdate` will be deprecated in favor of these more granular callbacks.

### What Doesn't Work

1. **`onBlock`** - Wired up but **always receives empty array**. The parser's `scan()` method never populates block events:
   ```typescript
   private scan(): BlockEvent[] {
     const events: BlockEvent[] = [];
     // ... updates depth counters only ...
     return events;  // Always empty!
   }
   ```

2. **No way to get visible-only tokens** - `onChunk` emits everything including `<thinking>` content and tool XML. For TTS streaming, apps need only the visible/speakable content.

## Problem: Real-Time TTS

For streaming to a TTS server, you need visible tokens with minimal latency:

```
Token: "H"  → emit (visible)
Token: "e"  → emit (visible)
Token: "<"  → BUFFER (might be <thinking>)
Token: "t"  → BUFFER (might be <thinking>)
Token: "h"  → BUFFER (might be <thinking>)
...
Token: ">"  → NOW we know it's <thinking> - suppress until </thinking>
```

Current options:
- `onChunk` - too raw, includes invisible content
- `onBlock` - not implemented, and would be too slow (waits for block boundaries)

## Proposal: Enriched onChunk with Metadata

Instead of separate callbacks, enrich `onChunk` with metadata about which **membrane block** the chunk belongs to:

```typescript
// Which membrane block type this chunk belongs to
type ChunkType = 'text' | 'thinking' | 'tool_call' | 'tool_result';

interface ChunkMeta {
  type: ChunkType;
  visible: boolean;           // Convenience flag for TTS/display filtering
  depth?: number;             // Tool nesting depth
  blockIndex: number;         // Which content block this belongs to
  // For tool_call chunks - what part is streaming
  toolCallPart?: 'name' | 'id' | 'input';
  toolId?: string;            // For tool_call / tool_result chunks
  toolName?: string;          // For tool_call / tool_result chunks
}

// New signature
onChunk?: (chunk: string, meta: ChunkMeta) => void;
```

### Example Stream

Wire format (prefill mode): `"Hello <thinking>let me think</thinking>The answer is 42."`

What membrane emits (abstraction level - XML tags are parsed, not emitted):

```
onBlock({ event: 'block_start', index: 0, block: { type: 'text' } })
onChunk("Hello ", { type: 'text', visible: true, blockIndex: 0 })
onBlock({ event: 'block_complete', index: 0, block: { type: 'text', content: 'Hello ' } })
onBlock({ event: 'block_start', index: 1, block: { type: 'thinking' } })
onChunk("let me think", { type: 'thinking', visible: false, blockIndex: 1 })
onBlock({ event: 'block_complete', index: 1, block: { type: 'thinking', content: 'let me think' } })
onBlock({ event: 'block_start', index: 2, block: { type: 'text' } })
onChunk("The answer is 42.", { type: 'text', visible: true, blockIndex: 2 })
onBlock({ event: 'block_complete', index: 2, block: { type: 'text', content: 'The answer is 42.' } })
```

With tool calls:

```
onBlock({ event: 'block_start', index: 0, block: { type: 'text' } })
onChunk("Let me check.", { type: 'text', visible: true, blockIndex: 0 })
onBlock({ event: 'block_complete', index: 0, block: { type: 'text', content: 'Let me check.' } })
onBlock({ event: 'block_start', index: 1, block: { type: 'tool_call' } })
onChunk("search", { type: 'tool_call', visible: false, blockIndex: 1, toolCallPart: 'name' })
onChunk("tool_123", { type: 'tool_call', visible: false, blockIndex: 1, toolCallPart: 'id' })
onChunk('{"query":', { type: 'tool_call', visible: false, blockIndex: 1, toolCallPart: 'input' })
onChunk('"weather"}', { type: 'tool_call', visible: false, blockIndex: 1, toolCallPart: 'input' })
onBlock({ event: 'block_complete', index: 1, block: { type: 'tool_call', toolName: 'search', toolId: 'tool_123', input: {query: 'weather'} } })
[tool executes]
onBlock({ event: 'block_start', index: 2, block: { type: 'tool_result' } })
onChunk("Results: ...", { type: 'tool_result', visible: false, blockIndex: 2, toolId: 'tool_123' })
onBlock({ event: 'block_complete', index: 2, block: { type: 'tool_result', content: 'Results: ...', toolId: 'tool_123' } })
onBlock({ event: 'block_start', index: 3, block: { type: 'text' } })
onChunk("Found it!", { type: 'text', visible: true, blockIndex: 3 })
onBlock({ event: 'block_complete', index: 3, block: { type: 'text', content: 'Found it!' } })
```

**Note on tool_call blocks:** Tool call internals (name, id, input JSON) are streamed via `onChunk` with `toolCallPart` metadata indicating which part is being streamed. This enables:
- Showing tool name as soon as it's known
- Streaming tool input JSON for debugging/UI
- Building partial JSON parsing if needed

**Note on tool_result blocks:** Tool results have content (the actual output from tool execution), so they emit `onChunk` with the result content.

All XML tags (`<thinking>`, `</thinking>`, `<function_calls>`, `<invoke>`, etc.) are wire format artifacts that membrane parses internally and **never** appear in `onChunk` calls.

### Benefits

1. **TTS apps**: `if (meta.visible) sendToTTS(chunk)`
2. **Debug/logging**: See everything with type annotations
3. **Transcript reconstruction**: Concatenate all chunks in order
4. **Tool results**: Flow through same callback with proper metadata
5. **Single source of truth**: One callback handles everything

## Proposal: Implement onBlock Events

Keep `onBlock` for structural **boundary events only** (no `block_delta` - that's what `onChunk` is for):

```typescript
// Membrane block types (not API ContentBlock)
type MembraneBlockType = 'text' | 'thinking' | 'tool_call' | 'tool_result';

interface MembraneBlock {
  type: MembraneBlockType;
  content?: string;           // Full content (for text, thinking, tool_result)
  toolId?: string;            // For tool_call / tool_result
  toolName?: string;          // For tool_call
  input?: Record<string, unknown>;  // For tool_call (parsed parameters)
}

// Only two event types - no block_delta (onChunk provides streaming content)
type BlockEvent =
  | { event: 'block_start'; index: number; block: { type: MembraneBlockType } }
  | { event: 'block_complete'; index: number; block: MembraneBlock };
```

Note: The current code references `ContentBlock` (API type) but should use a membrane-specific type since these represent logical membrane blocks, not API response structures. The same block types should be emitted regardless of whether the underlying mode is prefill (XML) or chat (native API).

### Why No block_delta?

`block_delta` would be redundant with `onChunk`:
- Both would contain the same text content
- Both would have the same block index/type information
- `onChunk` already provides streaming content with metadata

Instead, the design separates concerns:
- `onChunk` = streaming content (every token)
- `onBlock` = structural boundaries (start/complete only)

### Use Cases for onBlock

1. **UI panels**: Show separate areas for thinking vs response vs tool calls
2. **Block-level processing**: Process complete thinking blocks, complete tool results
3. **Accumulation**: `block_complete` provides full accumulated content without manual tracking

### Relationship Between onChunk and onBlock

- `onChunk(chunk, meta)` - Every token as it streams, with metadata including `blockIndex`
- `onBlock(block_start)` - Signals a new block is starting
- `onBlock(block_complete)` - Signals block is done, includes full accumulated content

They are interleaved:
```
onBlock({ event: 'block_start', index: 0, block: { type: 'text' } })
onChunk("Hello ", { type: 'text', visible: true, blockIndex: 0 })
onChunk("world", { type: 'text', visible: true, blockIndex: 0 })
onBlock({ event: 'block_complete', index: 0, block: { type: 'text', content: 'Hello world' } })
```

## Implementation Plan

### 1. Enhance onChunk with Metadata

**File: `src/membrane.ts`**

In the streaming handler (around line 247-286), add metadata computation:

```typescript
onChunk: (chunk) => {
  const wasInside = parser.isInsideBlock();
  const blockEvents = parser.push(chunk);
  const nowInside = parser.isInsideBlock();

  // Compute metadata using parser state
  const meta: ChunkMeta = {
    type: parser.getCurrentBlockType(),  // New method needed
    visible: !nowInside,
    depth: parser.getToolDepth(),        // New method needed
    blockIndex: parser.getBlockIndex(),  // New method needed
  };

  // Handle partial tag buffering for clean visible chunks
  // (see section below)

  onChunk?.(chunk, meta);
}
```

### 2. Add Partial Tag Buffering (Prefill Mode)

For clean streaming in prefill mode, buffer potential XML tag starts until they can be classified. XML tags are **not emitted** through `onChunk` - they are structural markers that membrane parses internally.

(In chat mode, block boundaries come from native API events, so no XML buffering is needed.)

**File: `src/utils/stream-parser.ts`**

Add methods to the parser:

```typescript
class IncrementalXmlParser {
  private tagBuffer: string = '';
  private blockIndex: number = 0;
  private currentBlockStarted: boolean = false;
  private currentBlockContent: string = '';

  // Known membrane tags for the cantBeMembraneTag heuristic
  private static MEMBRANE_TAG_PREFIXES = [
    '<thinking', '</thinking',
    '<function_calls', '</function_calls',
    '<function_results', '</function_results',
    '<function_calls', '</function_calls',
    '<invoke', '</invoke',
    '<parameter', '</parameter',
  ];

  /**
   * Process chunk and return content portions with metadata.
   * - Buffers partial tags until they can be classified
   * - Emits block_start/block_complete events
   * - Does NOT emit XML tags themselves (they are wire format, not content)
   *
   * Performance note: For large chunks, consider scanning for '<' positions
   * with indexOf rather than char-by-char iteration. The char-by-char approach
   * is shown here for clarity; production code may batch non-tag content.
   */
  processChunk(chunk: string): {
    content: Array<{ text: string; meta: ChunkMeta }>;
    blockEvents: BlockEvent[];
  } {
    const content: Array<{ text: string; meta: ChunkMeta }> = [];
    const blockEvents: BlockEvent[] = [];

    // Optimization: find all '<' positions and process segments between them
    let pos = 0;
    while (pos < chunk.length) {
      if (this.tagBuffer) {
        // Currently buffering a potential tag
        const char = chunk[pos];
        this.tagBuffer += char;
        pos++;

        if (this.isCompleteMembraneTag(this.tagBuffer)) {
          // It's a membrane tag - handle block boundaries, don't emit content
          const events = this.handleMembraneTag(this.tagBuffer);
          blockEvents.push(...events);
          this.tagBuffer = '';
        } else if (this.cantBeMembraneTag(this.tagBuffer)) {
          // Not a membrane tag (e.g., "<b>") - emit as visible content
          this.ensureBlockStarted(blockEvents);
          content.push({
            text: this.tagBuffer,
            meta: this.getCurrentMeta()
          });
          this.currentBlockContent += this.tagBuffer;
          this.tagBuffer = '';
        }
        // else: keep buffering
      } else {
        // Not currently buffering - scan for next '<'
        const nextLt = chunk.indexOf('<', pos);
        if (nextLt === -1) {
          // No more tags in this chunk - emit rest as content
          const text = chunk.slice(pos);
          if (text) {
            this.ensureBlockStarted(blockEvents);
            content.push({ text, meta: this.getCurrentMeta() });
            this.currentBlockContent += text;
          }
          break;
        } else {
          // Emit content before the '<'
          if (nextLt > pos) {
            const text = chunk.slice(pos, nextLt);
            this.ensureBlockStarted(blockEvents);
            content.push({ text, meta: this.getCurrentMeta() });
            this.currentBlockContent += text;
          }
          // Start buffering the tag
          this.tagBuffer = '<';
          pos = nextLt + 1;
        }
      }
    }

    return { content, blockEvents };
  }

  /**
   * Check if buffer cannot possibly be a membrane tag.
   * Returns true if we can definitively say this is NOT a membrane tag.
   *
   * Logic: Check if the buffer is a prefix of any known membrane tag.
   * If it's not a prefix of ANY membrane tag, it can't be one.
   */
  private cantBeMembraneTag(buffer: string): boolean {
    // If we have a complete tag (ends with '>'), check if it matches
    if (buffer.endsWith('>')) {
      return !this.isCompleteMembraneTag(buffer);
    }

    // Check if buffer could still become a membrane tag
    for (const prefix of IncrementalXmlParser.MEMBRANE_TAG_PREFIXES) {
      if (prefix.startsWith(buffer) || buffer.startsWith(prefix)) {
        return false; // Could still be this membrane tag
      }
    }
    return true; // Can't be any membrane tag
  }

  private handleMembraneTag(tag: string): BlockEvent[] {
    const events: BlockEvent[] = [];
    const isClosing = tag.startsWith('</');

    if (tag.includes('thinking')) {
      if (!isClosing) {
        // Complete previous block if any, start thinking block
        if (this.currentBlockStarted) {
          events.push(this.makeBlockComplete());
        }
        this.state.thinkingDepth++;
        events.push(this.makeBlockStart('thinking'));
      } else {
        this.state.thinkingDepth--;
        events.push(this.makeBlockComplete());
      }
    }
    // Similar for function_calls, function_results...

    return events;
  }

  /**
   * Flush any remaining buffer at end of stream.
   * Call this when the stream ends to emit any buffered partial tags as content.
   */
  flush(): { content: Array<{ text: string; meta: ChunkMeta }>; blockEvents: BlockEvent[] } {
    const content: Array<{ text: string; meta: ChunkMeta }> = [];
    const blockEvents: BlockEvent[] = [];

    // If we have a partial tag buffer, emit it as content (it wasn't a complete tag)
    if (this.tagBuffer) {
      this.ensureBlockStarted(blockEvents);
      content.push({ text: this.tagBuffer, meta: this.getCurrentMeta() });
      this.currentBlockContent += this.tagBuffer;
      this.tagBuffer = '';
    }

    // Complete the current block
    if (this.currentBlockStarted) {
      blockEvents.push(this.makeBlockComplete());
    }

    return { content, blockEvents };
  }

  getCurrentBlockType(): ChunkType {
    if (this.state.thinkingDepth > 0) return 'thinking';
    if (this.state.functionCallsDepth > 0) return 'tool_call';
    if (this.state.functionResultsDepth > 0) return 'tool_result';
    return 'text';
  }
}
```

### 3. Implement Block Events

Block events are emitted as part of `processChunk()` (see above). The key points:

- `block_start` fires when:
  - First content token arrives (implicit text block)
  - An opening membrane tag is detected (`<thinking>`, `<function_calls>`)

- `block_complete` fires when:
  - A closing membrane tag is detected (`</thinking>`, `</function_calls>`)
  - End of response (for trailing text block)

**For chat mode**, block events are derived from native API `content_block_start`/`content_block_stop` events instead of XML parsing, but the same `BlockEvent` types are emitted.

### Chat Mode Implementation

In chat mode (native API), the provider emits structured events. Membrane maps these to the same callback interface:

```typescript
// In the native streaming handler:
onContentBlockStart: (index, block) => {
  const membraneType = mapApiTypeToMembraneType(block.type);
  onBlock?.({ event: 'block_start', index, block: { type: membraneType } });
}

onContentBlockDelta: (index, delta) => {
  // Map delta to onChunk with appropriate metadata
  if (delta.type === 'text_delta') {
    onChunk?.(delta.text, { type: 'text', visible: true, blockIndex: index });
  } else if (delta.type === 'thinking_delta') {
    onChunk?.(delta.thinking, { type: 'thinking', visible: false, blockIndex: index });
  } else if (delta.type === 'input_json_delta') {
    onChunk?.(delta.partial_json, {
      type: 'tool_call',
      visible: false,
      blockIndex: index,
      toolCallPart: 'input'
    });
  }
}

onContentBlockStop: (index, block) => {
  onBlock?.({ event: 'block_complete', index, block: mapToMembraneBlock(block) });
}
```

This ensures consumers get identical callbacks regardless of whether the underlying mode is prefill (XML) or chat (native API).

### 4. Emit Tool Results Through onChunk

**File: `src/membrane.ts`**

When injecting tool results, emit the **content** (not XML wrapper) through onChunk:

```typescript
// After tool execution, inject results
for (const result of toolResults) {
  // Emit block events
  onBlock?.({ event: 'block_start', index: blockIndex, block: { type: 'tool_result' } });

  // Emit content through onChunk (not the XML wrapper)
  onChunk?.(result.content, {
    type: 'tool_result',
    visible: false,
    blockIndex,
    toolId: result.toolUseId,
  });

  onBlock?.({ event: 'block_complete', index: blockIndex, block: {
    type: 'tool_result',
    content: result.content,
    toolId: result.toolUseId,
  }});

  blockIndex++;
}

// Also update parser state for continuation
parser.push(formatToolResultsXml(toolResults));
```

## Migration Notes

### Breaking Change

The `onChunk` signature changes from:
```typescript
onChunk?: (chunk: string) => void;
```

To:
```typescript
onChunk?: (chunk: string, meta: ChunkMeta) => void;
```

Existing consumers that don't use `meta` will still work (extra parameter ignored).

### ChapterX Integration

ChapterX's `executeWithMembraneTools` would update to:

```typescript
const onChunk = (chunk: string, meta: ChunkMeta) => {
  currentChunkBuffer += chunk;

  // For TTS integration (future)
  if (meta.visible && ttsEnabled) {
    streamToTTS(chunk);
  }
};
```

## Files to Modify

1. **`src/types/streaming.ts`**
   - Add `ChunkMeta` interface with `toolCallPart` for tool call streaming
   - Add `MembraneBlock` and `MembraneBlockType` types (distinct from API `ContentBlock`)
   - Update `OnChunkCallback` type signature: `(chunk: string, meta: ChunkMeta) => void`
   - Update `BlockEvent` to only have `block_start` and `block_complete` (remove `block_delta`)
   - Remove `BlockDelta` type (no longer needed)
   - Deprecate `OnContentBlockCallback` in favor of `onBlock` + enriched `onChunk`

2. **`src/utils/stream-parser.ts`**
   - Add `processChunk()` method that returns `{ content, blockEvents }`
   - Add partial tag buffering logic with optimized scanning (indexOf for '<')
   - Add `cantBeMembraneTag()` heuristic with known tag prefix list
   - Add `flush()` method for end-of-stream handling
   - Add `getCurrentBlockType()`, `ensureBlockStarted()`, `makeBlockStart()`, `makeBlockComplete()` helpers
   - Track `blockIndex`, `currentBlockStarted`, `currentBlockContent` state
   - Stream tool call internals with `toolCallPart` metadata
   - XML tags are parsed for state changes but NOT emitted as content

3. **`src/membrane.ts`**
   - Use `parser.processChunk()` instead of raw `parser.push()`
   - Emit content via `onChunk(text, meta)`
   - Emit boundary events via `onBlock(event)`
   - Emit tool results through same callback pattern (content only, not XML wrapper)
   - Call `parser.flush()` at end of stream
   - For chat mode (`streamWithNativeTools`): map native API events to same callback interface

## Testing

1. **Visible filtering**: Stream with `<thinking>` blocks, verify `meta.visible` is correct for TTS filtering
2. **Partial tags**: Stream content with `<b>` tags (not membrane tags), verify they're emitted as visible text
3. **XML tags not emitted**: Verify `<thinking>`, `</thinking>`, `<function_calls>`, etc. do NOT appear in onChunk calls
4. **Tool results**: Verify tool result content (not XML wrapper) flows through `onChunk` with correct metadata
5. **Block events**: Verify `block_start` fires at first content/tag detection, `block_complete` fires at closing tag/end
6. **Interleaving**: Verify `block_start` comes before first `onChunk` of that block, `block_complete` comes after last
7. **Content reconstruction**: Concatenate all `onChunk` calls, verify matches logical content (no XML artifacts)
8. **Non-streaming fallback**: Test with non-streaming API, verify same callback pattern (single chunk = full block)
9. **Chat mode parity**: Verify same callbacks fire for chat mode (native API) as prefill mode (XML)
