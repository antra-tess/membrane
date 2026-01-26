/**
 * Integration test for onChunk and onBlock callbacks
 *
 * Run with: ANTHROPIC_API_KEY=sk-... npx tsx scripts/test-callbacks.ts
 */

import { Membrane } from '../src/membrane.js';
import { AnthropicAdapter } from '../src/providers/anthropic.js';
import type { NormalizedRequest, ToolDefinition, BlockEvent, ChunkMeta } from '../src/types/index.js';

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('ANTHROPIC_API_KEY environment variable required');
  process.exit(1);
}

const adapter = new AnthropicAdapter({ apiKey });
const membrane = new Membrane(adapter);

// Define a simple tool
const tools: ToolDefinition[] = [
  {
    name: 'get_weather',
    description: 'Get the current weather for a location',
    inputSchema: {
      type: 'object',
      properties: {
        location: { type: 'string', description: 'City name' },
      },
      required: ['location'],
    },
  },
];

const request: NormalizedRequest = {
  messages: [
    {
      participant: 'User',
      content: [{ type: 'text', text: 'What is the weather in Tokyo? Use the get_weather tool.' }],
    },
    {
      participant: 'Claude',
      content: [],
    },
  ],
  config: {
    model: 'claude-sonnet-4-20250514',
    maxTokens: 1024,
    thinking: { enabled: true },
  },
  tools,
};

console.log('=== Testing onChunk and onBlock callbacks ===\n');

const chunks: { text: string; meta: ChunkMeta }[] = [];
const blocks: BlockEvent[] = [];

async function runTest() {
  try {
    const result = await membrane.stream(request, {
      onChunk: (text, meta) => {
        chunks.push({ text, meta });
        const preview = text.length > 50 ? text.slice(0, 50) + '...' : text;
        const depth = (meta as any).depth ?? 0;
        console.log(`[onChunk] type=${meta.type} visible=${meta.visible} block=${meta.blockIndex} depth=${depth} "${preview.replace(/\n/g, '\\n')}"`);
      },
      onBlock: (event) => {
        blocks.push(event);
        if (event.event === 'block_start') {
          console.log(`[onBlock] START type=${event.block.type} index=${event.index}`);
        } else {
          const block = event.block as any;
          const info = block.toolName ? `tool=${block.toolName}` :
                       block.toolId ? `toolId=${block.toolId}` :
                       block.content ? `content=${String(block.content).slice(0, 30)}...` : '';
          console.log(`[onBlock] COMPLETE type=${event.block.type} index=${event.index} ${info}`);
        }
      },
      onPreToolContent: async (content) => {
        console.log(`[onPreToolContent] "${content.slice(0, 50)}..."`);
      },
      onToolCalls: async (calls) => {
        console.log(`\n[onToolCalls] Received ${calls.length} tool call(s):`);
        for (const call of calls) {
          console.log(`  - ${call.name}(${JSON.stringify(call.input)})`);
        }
        // Return mock results
        return calls.map(call => ({
          toolUseId: call.id,
          content: `Weather in ${(call.input as any).location}: Sunny, 22°C`,
        }));
      },
      onRequest: (req) => {
        console.log(`\n[onRequest] Sending request to API`);
      },
      onResponse: (res) => {
        console.log(`[onResponse] Received response from API\n`);
      },
    });

    console.log('\n=== Results ===\n');
    console.log('Stop reason:', result.stopReason);
    console.log('Content blocks:', result.content.length);
    for (const block of result.content) {
      if (block.type === 'text') {
        console.log(`  [text] ${(block as any).text.slice(0, 100)}...`);
      } else if (block.type === 'thinking') {
        console.log(`  [thinking] ${(block as any).thinking.slice(0, 100)}...`);
      } else {
        console.log(`  [${block.type}]`);
      }
    }

    console.log('\n=== Summary ===\n');
    console.log(`Total chunks: ${chunks.length}`);

    const chunkTypes = new Map<string, number>();
    for (const c of chunks) {
      chunkTypes.set(c.meta.type, (chunkTypes.get(c.meta.type) || 0) + 1);
    }
    console.log('Chunks by type:');
    for (const [type, count] of chunkTypes) {
      console.log(`  ${type}: ${count}`);
    }

    console.log(`\nTotal block events: ${blocks.length}`);
    const blockTypes = new Map<string, number>();
    for (const b of blocks) {
      const key = `${b.event}:${b.block.type}`;
      blockTypes.set(key, (blockTypes.get(key) || 0) + 1);
    }
    console.log('Block events by type:');
    for (const [type, count] of blockTypes) {
      console.log(`  ${type}: ${count}`);
    }

    // Verify expectations
    console.log('\n=== Verification ===\n');

    const hasThinkingChunks = chunks.some(c => c.meta.type === 'thinking');
    const hasTextChunks = chunks.some(c => c.meta.type === 'text');
    const hasToolResultChunks = chunks.some(c => c.meta.type === 'tool_result');

    const hasThinkingBlocks = blocks.some(b => b.block.type === 'thinking');
    const hasToolCallBlocks = blocks.some(b => b.block.type === 'tool_call');
    const hasToolResultBlocks = blocks.some(b => b.block.type === 'tool_result');

    console.log(`Thinking chunks: ${hasThinkingChunks ? '✓' : '✗'}`);
    console.log(`Text chunks: ${hasTextChunks ? '✓' : '✗'}`);
    console.log(`Tool result chunks: ${hasToolResultChunks ? '✓' : '✗'}`);
    console.log(`Thinking block events: ${hasThinkingBlocks ? '✓' : '✗'}`);
    console.log(`Tool call block events: ${hasToolCallBlocks ? '✓' : '✗'}`);
    console.log(`Tool result block events: ${hasToolResultBlocks ? '✓' : '✗'}`);

    const allPassed = hasThinkingChunks && hasTextChunks && hasToolResultChunks &&
                      hasThinkingBlocks && hasToolCallBlocks && hasToolResultBlocks;

    console.log(`\n${allPassed ? '✓ All checks passed!' : '✗ Some checks failed'}`);

  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

runTest();
