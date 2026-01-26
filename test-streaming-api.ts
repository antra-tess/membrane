/**
 * Test streaming enhancements with real API
 * Run with: ANTHROPIC_API_KEY=... npx tsx test-streaming-api.ts
 */

import { Membrane } from './src/index.js';
import { AnthropicAdapter } from './src/providers/anthropic.js';
import type { ChunkMeta, BlockEvent } from './src/types/streaming.js';
import type { NormalizedRequest, ToolDefinition } from './src/types/index.js';

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error('ANTHROPIC_API_KEY required');
  process.exit(1);
}

const adapter = new AnthropicAdapter({ apiKey: API_KEY });

// Test tool
const calculatorTool: ToolDefinition = {
  name: 'calculator',
  description: 'Perform basic math calculations',
  inputSchema: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: 'Math expression to evaluate' }
    },
    required: ['expression']
  }
};

async function testPrefillMode() {
  console.log('\n========================================');
  console.log('TEST: Prefill Mode (XML Tools)');
  console.log('========================================\n');

  const membrane = new Membrane(adapter, {});

  const request: NormalizedRequest = {
    config: {
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 1024,
      temperature: 0,
    },
    system: 'You are a helpful assistant. Use the calculator tool when asked to do math.',
    messages: [
      {
        participant: 'User',
        content: [{ type: 'text', text: 'What is 15 * 7? Use the calculator.' }]
      }
    ],
    tools: [calculatorTool],
    toolMode: 'xml',  // Force XML/prefill mode
  };

  const chunks: Array<{ text: string; meta: ChunkMeta }> = [];
  const blocks: BlockEvent[] = [];
  let visibleText = '';

  const result = await membrane.stream(request, {
    onChunk: (chunk, meta) => {
      chunks.push({ text: chunk, meta });
      if (meta.visible) {
        visibleText += chunk;
      }
      // Show streaming with type info
      const typeTag = meta.visible ? 'V' : meta.type[0].toUpperCase();
      process.stdout.write(typeTag);
    },
    onBlock: (event) => {
      blocks.push(event);
      console.log('\n  >> Block: ' + event.event + ' - ' + event.block.type);
    },
    onToolCalls: async (calls) => {
      console.log('\n  >> Tool calls: ' + calls.length);
      return calls.map(call => ({
        toolUseId: call.id,
        content: call.name === 'calculator'
          ? String(eval((call.input as any).expression))
          : 'Unknown tool',
      }));
    },
  });

  console.log('\n\n--- Results ---');
  console.log('Total chunks: ' + chunks.length);
  console.log('Block events: ' + blocks.length);
  console.log('Visible text: "' + visibleText.slice(0, 100) + '..."');

  // Verify metadata
  const textChunks = chunks.filter(c => c.meta.type === 'text' && c.meta.visible);
  const toolChunks = chunks.filter(c => c.meta.type === 'tool_call' || c.meta.type === 'tool_result');
  console.log('Text chunks (visible): ' + textChunks.length);
  console.log('Tool chunks (hidden): ' + toolChunks.length);

  // Check block events
  const blockStarts = blocks.filter(b => b.event === 'block_start');
  const blockCompletes = blocks.filter(b => b.event === 'block_complete');
  console.log('Block starts: ' + blockStarts.length);
  console.log('Block completes: ' + blockCompletes.length);

  if ('content' in result) {
    console.log('\nFinal content blocks: ' + result.content.length);
    console.log('Tool calls executed: ' + (result.toolCalls?.length || 0));
  }

  return chunks.length > 0 && blocks.length > 0;
}

async function testChatMode() {
  console.log('\n========================================');
  console.log('TEST: Chat Mode (Native Tools API)');
  console.log('========================================\n');

  const membrane = new Membrane(adapter, {});

  // Native mode requires tools to be defined (otherwise falls back to prefill)
  const dummyTool: ToolDefinition = {
    name: 'get_time',
    description: 'Get the current time',
    inputSchema: { type: 'object', properties: {} }
  };

  const request: NormalizedRequest = {
    config: {
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 1024,
      temperature: 0,
    },
    system: 'You are a helpful assistant. Do not use tools unless explicitly asked.',
    messages: [
      {
        participant: 'User',
        content: [{ type: 'text', text: 'Say hello in exactly 5 words. Do not use any tools.' }]
      }
    ],
    tools: [dummyTool],  // Need tools for native mode
    toolMode: 'native',
  };

  const chunks: Array<{ text: string; meta: ChunkMeta }> = [];
  let visibleText = '';

  console.log('Starting stream (native/chat mode)...');
  const result = await membrane.stream(request, {
    onChunk: (chunk, meta) => {
      chunks.push({ text: chunk, meta });
      if (meta.visible) {
        visibleText += chunk;
        process.stdout.write(chunk);
      }
    },
  });

  console.log('\n\n--- Results ---');
  console.log('Total chunks: ' + chunks.length);
  console.log('Visible text: "' + visibleText + '"');

  // All chunks in chat mode without tools should be visible text
  const allVisible = chunks.every(c => c.meta.visible && c.meta.type === 'text');
  console.log('All chunks visible text: ' + allVisible);

  return chunks.length > 0 && allVisible;
}

async function testSimplePrefill() {
  console.log('\n========================================');
  console.log('TEST: Prefill Mode (no tools)');
  console.log('========================================\n');

  // Prefill mode uses participant-based format
  // Messages become "User: ...\nClaude:" in a single assistant prefill
  const membrane = new Membrane(adapter, {});

  const request: NormalizedRequest = {
    config: {
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 1024,
      temperature: 0,
    },
    system: 'You are a helpful assistant.',
    messages: [
      {
        participant: 'User',
        content: [{ type: 'text', text: 'What is 2+2? Answer in one word.' }]
      }
    ],
    // No toolMode specified = defaults to xml/prefill
  };

  const chunks: Array<{ text: string; meta: ChunkMeta }> = [];
  const blocks: BlockEvent[] = [];
  let visibleText = '';

  console.log('Starting prefill stream...');
  const result = await membrane.stream(request, {
    onChunk: (chunk, meta) => {
      console.log('PREFILL onChunk:', JSON.stringify({ chunk: chunk.slice(0, 50), meta }));
      chunks.push({ text: chunk, meta });
      if (meta.visible) {
        visibleText += chunk;
        process.stdout.write(chunk);
      } else {
        process.stdout.write('[' + meta.type + ']');
      }
    },
    onBlock: (event) => {
      console.log('PREFILL onBlock:', event.event, event.block.type);
      blocks.push(event);
    },
  });

  console.log('\nResult rawAssistantText:', result.rawAssistantText?.slice(0, 100));
  console.log('Result content:', JSON.stringify(result.content).slice(0, 200));

  console.log('\n--- Results ---');
  console.log('Total chunks: ' + chunks.length);
  console.log('Block events: ' + blocks.length);
  console.log('Visible text: "' + visibleText + '"');

  const visibleChunks = chunks.filter(c => c.meta.visible);
  const hiddenChunks = chunks.filter(c => !c.meta.visible);
  console.log('Visible chunks: ' + visibleChunks.length);
  console.log('Hidden chunks: ' + hiddenChunks.length);

  return chunks.length > 0 && visibleChunks.length > 0;
}

async function main() {
  console.log('Testing Streaming Enhancements');
  console.log('Model: claude-haiku-4-5-20251001');

  let passed = 0;
  let failed = 0;

  try {
    if (await testChatMode()) {
      console.log('\n✓ Chat mode test passed');
      passed++;
    } else {
      console.log('\n✗ Chat mode test failed');
      failed++;
    }
  } catch (e) {
    console.error('\n✗ Chat mode test error:', e);
    failed++;
  }

  try {
    if (await testSimplePrefill()) {
      console.log('\n✓ Simple prefill test passed');
      passed++;
    } else {
      console.log('\n✗ Simple prefill test failed');
      failed++;
    }
  } catch (e) {
    console.error('\n✗ Simple prefill test error:', e);
    failed++;
  }

  try {
    if (await testPrefillMode()) {
      console.log('\n✓ Prefill mode with tools test passed');
      passed++;
    } else {
      console.log('\n✗ Prefill mode with tools test failed');
      failed++;
    }
  } catch (e) {
    console.error('\n✗ Prefill mode with tools test error:', e);
    failed++;
  }

  console.log('\n========================================');
  console.log('SUMMARY: ' + passed + ' passed, ' + failed + ' failed');
  console.log('========================================');

  process.exit(failed > 0 ? 1 : 0);
}

main();
