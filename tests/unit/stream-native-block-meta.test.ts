/** Anthropic's SSE stream sends each block as content_block_start, then its deltas, then content_block_stop, per index. */

import { describe, it, expect } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import type {
  NormalizedRequest,
  ProviderAdapter,
  ProviderRequest,
  ProviderResponse,
  StreamCallbacks,
  StreamEvent,
  ContentBlock,
  ChunkMeta,
  BlockEvent,
} from '../../src/types/index.js';

interface ScriptedBlock {
  index: number;
  start: Record<string, unknown>;
  chunks: string[];
  stop: Record<string, unknown>;
}

class ScriptedAdapter implements ProviderAdapter {
  readonly name = 'scripted';
  constructor(private blocks: ScriptedBlock[], private content: ProviderResponse['content']) {}
  supportsModel(): boolean { return true; }
  async complete(): Promise<ProviderResponse> { throw new Error('not used'); }
  async stream(_request: ProviderRequest, callbacks: StreamCallbacks): Promise<ProviderResponse> {
    for (const b of this.blocks) {
      callbacks.onContentBlock?.(b.index, b.start);
      for (const chunk of b.chunks) callbacks.onChunk(chunk);
      callbacks.onContentBlock?.(b.index, b.stop);
    }
    return { content: this.content, stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 10 }, raw: {} };
  }
}

function nativeRequest(): NormalizedRequest {
  return {
    messages: [{ participant: 'User', content: [{ type: 'text', text: 'hi' }] }],
    config: { model: 'test-model', maxTokens: 1000 },
    toolMode: 'native',
    tools: [{ name: 'noop', description: 'does nothing', inputSchema: { type: 'object', properties: {} } }],
  };
}

const THINKING_THEN_TEXT: ScriptedBlock[] = [
  { index: 0, start: { type: 'thinking' }, chunks: ['let me ', 'reason'], stop: { type: 'thinking', thinking: 'let me reason' } },
  { index: 1, start: { type: 'text' }, chunks: ['Answer'], stop: { type: 'text', text: 'Answer' } },
];
const FINAL_CONTENT = [
  { type: 'thinking', thinking: 'let me reason' },
  { type: 'text', text: 'Answer' },
] as unknown as ProviderResponse['content'];

describe('stream() native path: chunk metadata follows the provider block type (#20)', () => {
  it('tags thinking deltas as invisible thinking and text deltas as visible text', async () => {
    const membrane = new Membrane(new ScriptedAdapter(THINKING_THEN_TEXT, FINAL_CONTENT));
    const seen: Array<{ chunk: string; meta: ChunkMeta }> = [];
    await membrane.stream(nativeRequest(), { onChunk: (chunk, meta) => seen.push({ chunk, meta }) });

    expect(seen.map((s) => s.chunk)).toEqual(['let me ', 'reason', 'Answer']);
    expect(seen.slice(0, 2).map((s) => s.meta.type)).toEqual(['thinking', 'thinking']);
    expect(seen.slice(0, 2).every((s) => s.meta.visible === false)).toBe(true);
    expect(seen[2].meta.type).toBe('text');
    expect(seen[2].meta.visible).toBe(true);
    expect(seen.map((s) => s.meta.blockIndex)).toEqual([0, 0, 1]);
  });

  it('emits block_start / block_complete lifecycle through onBlock', async () => {
    const membrane = new Membrane(new ScriptedAdapter(THINKING_THEN_TEXT, FINAL_CONTENT));
    const events: BlockEvent[] = [];
    await membrane.stream(nativeRequest(), { onBlock: (e) => events.push(e) });

    expect(events.map((e) => [e.event, e.index, e.block.type])).toEqual([
      ['block_start', 0, 'thinking'],
      ['block_complete', 0, 'thinking'],
      ['block_start', 1, 'text'],
      ['block_complete', 1, 'text'],
    ]);
    expect(events[1].block.content).toBe('let me reason');
    expect(events[3].block.content).toBe('Answer');
  });

  it('maps tool_use blocks to tool_call with id/name/input on completion', async () => {
    const blocks: ScriptedBlock[] = [
      { index: 0, start: { type: 'tool_use', id: 'tu_1', name: 'noop' }, chunks: [], stop: { type: 'tool_use', id: 'tu_1', name: 'noop', input: { a: 1 } } },
    ];
    const content = [{ type: 'tool_use', id: 'tu_1', name: 'noop', input: { a: 1 } }] as unknown as ProviderResponse['content'];
    const membrane = new Membrane(new ScriptedAdapter(blocks, content));
    const events: BlockEvent[] = [];
    await membrane.stream(nativeRequest(), { onBlock: (e) => events.push(e) });

    expect(events[0]).toMatchObject({ event: 'block_start', index: 0, block: { type: 'tool_call' } });
    expect(events[1]).toMatchObject({ event: 'block_complete', index: 0, block: { type: 'tool_call', toolId: 'tu_1', toolName: 'noop', input: { a: 1 } } });
  });

  it('keeps the deprecated onContentBlockUpdate pass-through working', async () => {
    const membrane = new Membrane(new ScriptedAdapter(THINKING_THEN_TEXT, FINAL_CONTENT));
    const updates: Array<[number, ContentBlock]> = [];
    await membrane.stream(nativeRequest(), { onContentBlockUpdate: (i, b) => updates.push([i, b]) });
    expect(updates.map(([i, b]) => [i, (b as { type: string }).type])).toEqual([
      [0, 'thinking'], [0, 'thinking'], [1, 'text'], [1, 'text'],
    ]);
  });
});

class SingleCallbackAdapter implements ProviderAdapter {
  readonly name = 'single-callback';
  constructor(private chunks: string[], private content: ProviderResponse['content']) {}
  supportsModel(): boolean { return true; }
  async complete(): Promise<ProviderResponse> { throw new Error('not used'); }
  async stream(_request: ProviderRequest, callbacks: StreamCallbacks): Promise<ProviderResponse> {
    for (const chunk of this.chunks) callbacks.onChunk(chunk);
    (this.content as unknown[]).forEach((block, index) => callbacks.onContentBlock?.(index, block));
    return { content: this.content, stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 10 }, raw: {} };
  }
}

const RESPONSES_STYLE_CONTENT = [
  { type: 'thinking', thinking: 'let me reason' },
  { type: 'text', text: 'Answer' },
  { type: 'tool_use', id: 'fc_1', name: 'noop', input: { a: 1 } },
] as unknown as ProviderResponse['content'];

describe('single-callback adapters (OpenAI Responses style) still get a complete block lifecycle', () => {
  it('stream(): every started block is completed, with its finalised payload', async () => {
    const membrane = new Membrane(new SingleCallbackAdapter(['Answer'], RESPONSES_STYLE_CONTENT));
    const events: BlockEvent[] = [];
    await membrane.stream(nativeRequest(), { onBlock: (e) => events.push(e) });

    const starts = events.filter((e) => e.event === 'block_start').map((e) => [e.index, e.block.type]);
    const completes = events.filter((e) => e.event === 'block_complete');
    expect(starts).toEqual([[0, 'thinking'], [1, 'text'], [2, 'tool_call']]);
    expect(completes.map((e) => [e.index, e.block.type])).toEqual([[0, 'thinking'], [1, 'text'], [2, 'tool_call']]);
    expect(completes[0].block.content).toBe('let me reason');
    expect(completes[1].block.content).toBe('Answer');
    expect(completes[2].block).toMatchObject({ toolId: 'fc_1', toolName: 'noop', input: { a: 1 } });
  });

  it('streamYielding(): the same completion is synthesised on the yielding path', async () => {
    const membrane = new Membrane(new SingleCallbackAdapter(['Answer'], RESPONSES_STYLE_CONTENT));
    const events: StreamEvent[] = [];
    for await (const event of membrane.streamYielding(nativeRequest())) events.push(event);

    const blocks = events.filter((e) => e.type === 'block').map((e) => (e as { event: BlockEvent }).event);
    expect(blocks.filter((e) => e.event === 'block_start').length).toBe(3);
    const completes = blocks.filter((e) => e.event === 'block_complete');
    expect(completes.map((e) => [e.index, e.block.type])).toEqual([[0, 'thinking'], [1, 'text'], [2, 'tool_call']]);
    expect(completes[0].block.content).toBe('let me reason');
  });

  it('paired-callback adapters are unaffected: flush is a no-op (no duplicate completions)', async () => {
    const membrane = new Membrane(new ScriptedAdapter(THINKING_THEN_TEXT, FINAL_CONTENT));
    const events: BlockEvent[] = [];
    await membrane.stream(nativeRequest(), { onBlock: (e) => events.push(e) });
    expect(events.filter((e) => e.event === 'block_complete').length).toBe(2);
  });
});
