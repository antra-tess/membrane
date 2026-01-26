/**
 * Test thinking in prefill mode with actual API
 * Run with: ANTHROPIC_API_KEY=... npx tsx test-prefill-thinking.ts
 */

import { Membrane } from './src/index.js';
import { AnthropicAdapter } from './src/providers/anthropic.js';
import { transformToPrefill } from './src/index.js';
import type { NormalizedRequest } from './src/types/index.js';
import type { ChunkMeta, BlockEvent } from './src/types/streaming.js';

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error('ANTHROPIC_API_KEY required');
  process.exit(1);
}

const adapter = new AnthropicAdapter({ apiKey: API_KEY });
const membrane = new Membrane(adapter, {});

// ============================================================================
// Test 1: Transform check - verify thinking tag is in prefill
// ============================================================================

console.log('========================================');
console.log('TEST 1: Transform with prefillThinking');
console.log('========================================\n');

const request1: NormalizedRequest = {
  config: {
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 500,
  },
  system: 'You are a helpful assistant. Think through problems step by step.',
  messages: [
    {
      participant: 'User',
      content: [{ type: 'text', text: 'What is 15 + 27?' }],
    },
  ],
  toolMode: 'xml',
};

const transformed = transformToPrefill(request1, { prefillThinking: true });

console.log('=== TRANSFORMED MESSAGES ===\n');
transformed.messages.forEach((msg, i) => {
  console.log('--- Message ' + i + ' [' + msg.role + '] ---');
  if (typeof msg.content === 'string') {
    console.log(msg.content);
  } else if (Array.isArray(msg.content)) {
    msg.content.forEach((block: any) => {
      if (block.type === 'text') {
        console.log('[text]: ' + block.text);
      }
    });
  }
  console.log('');
});

const lastAssistant = transformed.messages.filter(m => m.role === 'assistant').pop();
const lastContent = typeof lastAssistant?.content === 'string' ? lastAssistant.content : '';
console.log('Last assistant ends with <thinking>:', lastContent.includes('<thinking>') ? 'YES' : 'NO');
console.log('');

// ============================================================================
// Test 2: Actual API call with thinking in prefill
// ============================================================================

console.log('========================================');
console.log('TEST 2: API call with prefillThinking');
console.log('========================================\n');

async function testThinkingAPI() {
  const request: NormalizedRequest = {
    config: {
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 500,
      temperature: 0,
    },
    system: 'You are a helpful assistant. Always think through problems step by step inside <thinking> tags before answering.',
    messages: [
      {
        participant: 'User',
        content: [{ type: 'text', text: 'What is 15 + 27? Show your thinking.' }],
      },
    ],
    toolMode: 'xml',
  };

  const chunks: Array<{ text: string; meta: ChunkMeta }> = [];
  const blocks: BlockEvent[] = [];
  let fullText = '';
  let visibleText = '';
  let thinkingText = '';

  console.log('Sending to API...\n');
  console.log('=== RAW CHUNKS ===\n');

  const result = await membrane.stream(request, {
    onChunk: (chunk, meta) => {
      chunks.push({ text: chunk, meta });
      fullText += chunk;

      // Show chunk with metadata
      const typeLabel = meta.type.padEnd(10);
      const visLabel = meta.visible ? 'vis' : 'hid';
      console.log('[' + typeLabel + ' ' + visLabel + ' blk' + meta.blockIndex + '] "' + chunk.replace(/\n/g, '\\n') + '"');

      if (meta.visible) {
        visibleText += chunk;
      }
      if (meta.type === 'thinking') {
        thinkingText += chunk;
      }
    },
    onBlock: (event) => {
      blocks.push(event);
      console.log('\n>>> BLOCK EVENT: ' + event.event + ' - type: ' + event.block.type + '\n');
    },
  });

  console.log('\n=== RESULTS ===\n');
  console.log('Total chunks:', chunks.length);
  console.log('Block events:', blocks.length);
  console.log('');

  console.log('--- Block Event Summary ---');
  blocks.forEach((b, i) => {
    if (b.event === 'block_start') {
      console.log('  ' + i + ': block_start type=' + b.block.type);
    } else {
      console.log('  ' + i + ': block_complete type=' + b.block.type + ' content=' + (b.block.content || '').substring(0, 50) + '...');
    }
  });
  console.log('');

  console.log('--- Chunk Type Summary ---');
  const typeCounts: Record<string, number> = {};
  chunks.forEach(c => {
    typeCounts[c.meta.type] = (typeCounts[c.meta.type] || 0) + 1;
  });
  Object.entries(typeCounts).forEach(([type, count]) => {
    console.log('  ' + type + ': ' + count + ' chunks');
  });
  console.log('');

  console.log('--- Full Text ---');
  console.log(fullText);
  console.log('');

  console.log('--- Visible Text Only ---');
  console.log(visibleText);
  console.log('');

  console.log('--- Thinking Text Only ---');
  console.log(thinkingText || '(none captured)');
  console.log('');

  // Checks
  const hasThinkingBlock = blocks.some(b => b.block.type === 'thinking');
  const hasThinkingChunks = chunks.some(c => c.meta.type === 'thinking');
  const thinkingIsHidden = chunks.filter(c => c.meta.type === 'thinking').every(c => !c.meta.visible);

  console.log('=== CHECKS ===');
  console.log('Has thinking block events:', hasThinkingBlock ? 'YES' : 'NO');
  console.log('Has thinking chunks:', hasThinkingChunks ? 'YES' : 'NO');
  console.log('Thinking chunks hidden:', thinkingIsHidden ? 'YES' : 'N/A');
  console.log('Response has answer:', fullText.includes('42') ? 'YES' : 'NO');

  return hasThinkingChunks || fullText.includes('thinking');
}

// ============================================================================
// Test 3: Without prefillThinking - model may or may not think
// ============================================================================

async function testWithoutPrefillThinking() {
  console.log('\n========================================');
  console.log('TEST 3: API call WITHOUT prefillThinking');
  console.log('========================================\n');

  const request: NormalizedRequest = {
    config: {
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 500,
      temperature: 0,
    },
    system: 'You are helpful.',
    messages: [
      {
        participant: 'User',
        content: [{ type: 'text', text: 'What is 15 + 27?' }],
      },
    ],
    toolMode: 'xml',
  };

  const chunks: Array<{ text: string; meta: ChunkMeta }> = [];
  let fullText = '';

  console.log('Sending to API (no thinking prefill)...\n');

  await membrane.stream(request, {
    onChunk: (chunk, meta) => {
      chunks.push({ text: chunk, meta });
      fullText += chunk;
      process.stdout.write(chunk);
    },
  });

  console.log('\n\n--- Results ---');
  console.log('Total chunks:', chunks.length);
  console.log('Has thinking chunks:', chunks.some(c => c.meta.type === 'thinking') ? 'YES' : 'NO');
  console.log('Full response:', fullText);
}

// Run tests
(async () => {
  try {
    const test2Pass = await testThinkingAPI();
    await testWithoutPrefillThinking();

    console.log('\n========================================');
    console.log('SUMMARY');
    console.log('========================================');
    console.log('Thinking detection:', test2Pass ? 'WORKING' : 'POTENTIALLY BROKEN');
  } catch (err) {
    console.error('\nError:', err);
    process.exit(1);
  }
})();
