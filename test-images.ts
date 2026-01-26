/**
 * Test image handling with streaming
 * Run with: ANTHROPIC_API_KEY=... npx tsx test-images.ts
 */

import { Membrane } from './src/index.js';
import { AnthropicAdapter } from './src/providers/anthropic.js';
import type { ChunkMeta, BlockEvent } from './src/types/streaming.js';
import type { NormalizedRequest } from './src/types/index.js';
import * as fs from 'fs';
import * as path from 'path';

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error('ANTHROPIC_API_KEY required');
  process.exit(1);
}

const adapter = new AnthropicAdapter({ apiKey: API_KEY });
const membrane = new Membrane(adapter, {});

// Small 1x1 PNG for testing (color doesn't matter, just testing image handling)
const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

async function testImageInChat() {
  console.log('\n========================================');
  console.log('TEST: Image in Chat Mode (Native API)');
  console.log('========================================\n');

  const request: NormalizedRequest = {
    config: {
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 200,
      temperature: 0,
    },
    system: 'You are a helpful assistant. Describe images briefly.',
    messages: [
      {
        participant: 'User',
        content: [
          { type: 'text', text: 'What color is this image? Answer in one word.' },
          {
            type: 'image',
            source: {
              type: 'base64',
              mediaType: 'image/png',
              data: TINY_PNG_BASE64,
            },
          },
        ],
      },
    ],
    toolMode: 'native',
  };

  const chunks: Array<{ text: string; meta: ChunkMeta }> = [];
  let visibleText = '';

  console.log('Sending image to API...');
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
  console.log('Total chunks:', chunks.length);
  console.log('Visible text:', visibleText);
  console.log('Content blocks:', result.content.length);

  // Success = got chunks and a response (image was processed)
  const success = chunks.length > 0 && visibleText.trim().length > 0;
  console.log('Image handled:', success ? 'YES' : 'NO');
  return success;
}

async function testImageInPrefill() {
  console.log('\n========================================');
  console.log('TEST: Image in Prefill Mode');
  console.log('========================================\n');

  const request: NormalizedRequest = {
    config: {
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 200,
      temperature: 0,
    },
    system: 'You are a helpful assistant. Describe images briefly.',
    messages: [
      {
        participant: 'User',
        content: [
          { type: 'text', text: 'What color is this tiny image? One word answer.' },
          {
            type: 'image',
            source: {
              type: 'base64',
              mediaType: 'image/png',
              data: TINY_PNG_BASE64,
            },
          },
        ],
      },
    ],
    toolMode: 'xml',  // Prefill mode
  };

  const chunks: Array<{ text: string; meta: ChunkMeta }> = [];
  const blocks: BlockEvent[] = [];
  let visibleText = '';

  console.log('Sending image to API (prefill mode)...');
  const result = await membrane.stream(request, {
    onChunk: (chunk, meta) => {
      chunks.push({ text: chunk, meta });
      if (meta.visible) {
        visibleText += chunk;
        process.stdout.write(chunk);
      }
    },
    onBlock: (event) => {
      blocks.push(event);
    },
  });

  console.log('\n\n--- Results ---');
  console.log('Total chunks:', chunks.length);
  console.log('Block events:', blocks.length);
  console.log('Visible text:', visibleText);

  // Success = got chunks and a response (image was processed)
  const success = chunks.length > 0 && visibleText.trim().length > 0;
  console.log('Image handled:', success ? 'YES' : 'NO');
  return success;
}

async function testMultipleImages() {
  console.log('\n========================================');
  console.log('TEST: Multiple Images in Conversation');
  console.log('========================================\n');

  const request: NormalizedRequest = {
    config: {
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 200,
      temperature: 0,
    },
    system: 'You are helpful. Answer briefly.',
    messages: [
      {
        participant: 'User',
        content: [
          { type: 'text', text: 'I will show you two images. First image:' },
          {
            type: 'image',
            source: { type: 'base64', mediaType: 'image/png', data: TINY_PNG_BASE64 },
          },
          { type: 'text', text: 'Second image:' },
          {
            type: 'image',
            source: { type: 'base64', mediaType: 'image/png', data: TINY_PNG_BASE64 },
          },
          { type: 'text', text: 'How many images did I show you?' },
        ],
      },
    ],
    toolMode: 'native',
  };

  let visibleText = '';

  console.log('Sending multiple images...');
  const result = await membrane.stream(request, {
    onChunk: (chunk, meta) => {
      if (meta.visible) {
        visibleText += chunk;
        process.stdout.write(chunk);
      }
    },
  });

  console.log('\n\n--- Results ---');
  console.log('Response:', visibleText);

  // Success = got a response mentioning "two" or "2"
  const success = visibleText.toLowerCase().includes('two') || visibleText.includes('2');
  console.log('Multiple images recognized:', success ? 'YES' : 'NO');
  return success;
}

async function main() {
  console.log('Testing Image Handling');
  console.log('Model: claude-haiku-4-5-20251001');

  let passed = 0;
  let failed = 0;

  try {
    if (await testImageInChat()) {
      console.log('\n✓ Chat mode image test passed');
      passed++;
    } else {
      console.log('\n✗ Chat mode image test failed');
      failed++;
    }
  } catch (e) {
    console.error('\n✗ Chat mode image test error:', e);
    failed++;
  }

  try {
    if (await testImageInPrefill()) {
      console.log('\n✓ Prefill mode image test passed');
      passed++;
    } else {
      console.log('\n✗ Prefill mode image test failed');
      failed++;
    }
  } catch (e) {
    console.error('\n✗ Prefill mode image test error:', e);
    failed++;
  }

  try {
    if (await testMultipleImages()) {
      console.log('\n✓ Multiple images test passed');
      passed++;
    } else {
      console.log('\n✗ Multiple images test failed');
      failed++;
    }
  } catch (e) {
    console.error('\n✗ Multiple images test error:', e);
    failed++;
  }

  console.log('\n========================================');
  console.log('SUMMARY:', passed, 'passed,', failed, 'failed');
  console.log('========================================');

  process.exit(failed > 0 ? 1 : 0);
}

main();
