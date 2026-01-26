/**
 * Test prefill mode image handling - verify content before/after image
 */

import { Membrane } from './src/index.js';
import { AnthropicAdapter } from './src/providers/anthropic.js';
import { transformToPrefill } from './src/index.js';
import type { NormalizedRequest } from './src/types/index.js';

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error('ANTHROPIC_API_KEY required');
  process.exit(1);
}

const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

// First, let's see what the transform produces
console.log('========================================');
console.log('TEST: Prefill Transform with Image');
console.log('========================================\n');

const request: NormalizedRequest = {
  config: {
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 200,
  },
  system: 'You are helpful.',
  messages: [
    {
      participant: 'Alice',
      content: [{ type: 'text', text: 'Hello everyone!' }],
    },
    {
      participant: 'Bob',
      content: [{ type: 'text', text: 'Hi Alice!' }],
    },
    {
      participant: 'User',
      content: [
        { type: 'text', text: 'What color is this image?' },
        {
          type: 'image',
          source: { type: 'base64', mediaType: 'image/png', data: TINY_PNG_BASE64 },
        },
      ],
    },
    {
      participant: 'Alice',
      content: [{ type: 'text', text: 'Let me look at that.' }],
    },
  ],
};

const result = transformToPrefill(request, {});

console.log('=== TRANSFORMED MESSAGES ===\n');
result.messages.forEach((msg, i) => {
  console.log(`--- Message ${i} [${msg.role}] ---`);
  if (typeof msg.content === 'string') {
    console.log(msg.content);
  } else if (Array.isArray(msg.content)) {
    msg.content.forEach((block: any, j: number) => {
      if (block.type === 'text') {
        console.log(`[text]: ${block.text}`);
      } else if (block.type === 'image') {
        console.log(`[image]: ${block.source.type} ${block.source.media_type}`);
      } else {
        console.log(`[${block.type}]`);
      }
    });
  }
  console.log('');
});

// Check structure
const userMessages = result.messages.filter(m => m.role === 'user');
const assistantMessages = result.messages.filter(m => m.role === 'assistant');

console.log('=== STRUCTURE CHECK ===');
console.log('User messages:', userMessages.length);
console.log('Assistant messages:', assistantMessages.length);

// Image should cause a flush to user turn
const hasImageInUser = userMessages.some(m => {
  if (Array.isArray(m.content)) {
    return m.content.some((b: any) => b.type === 'image');
  }
  return false;
});
console.log('Image in user message:', hasImageInUser ? 'YES' : 'NO');

// Content before image should be in assistant message
const hasAliceBobBefore = assistantMessages.some(m => {
  const content = typeof m.content === 'string' ? m.content : '';
  return content.includes('Alice:') && content.includes('Bob:');
});
console.log('Alice/Bob content before image:', hasAliceBobBefore ? 'YES' : 'NO');

// Content after image should also be handled
const hasAliceAfter = result.messages.some(m => {
  const content = typeof m.content === 'string' ? m.content : '';
  return content.includes('Let me look');
});
console.log('Alice content after image:', hasAliceAfter ? 'YES' : 'NO');

// Now test with actual API
console.log('\n========================================');
console.log('TEST: Actual API Call with Image in Prefill');
console.log('========================================\n');

const adapter = new AnthropicAdapter({ apiKey: API_KEY });
const membrane = new Membrane(adapter, {});

async function testActualAPI() {
  const apiRequest: NormalizedRequest = {
    config: {
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 200,
      temperature: 0,
    },
    system: 'You are helpful. Answer questions about images.',
    messages: [
      {
        participant: 'User',
        content: [
          { type: 'text', text: 'I have a question about an image.' },
        ],
      },
      {
        participant: 'Claude',
        content: [{ type: 'text', text: 'Sure, please share the image.' }],
      },
      {
        participant: 'User',
        content: [
          { type: 'text', text: 'Here is the image:' },
          {
            type: 'image',
            source: { type: 'base64', mediaType: 'image/png', data: TINY_PNG_BASE64 },
          },
          { type: 'text', text: 'What color is it?' },
        ],
      },
    ],
    toolMode: 'xml',  // Force prefill mode
  };

  let response = '';

  console.log('Sending to API...');
  const result = await membrane.stream(apiRequest, {
    onChunk: (chunk, meta) => {
      if (meta.visible) {
        response += chunk;
        process.stdout.write(chunk);
      }
    },
  });

  console.log('\n\n--- Results ---');
  console.log('Response:', response);
  console.log('Image recognized:', response.toLowerCase().includes('red') ? 'YES' : 'MAYBE (check response)');

  return response.trim().length > 0;
}

testActualAPI()
  .then(success => {
    console.log('\n' + (success ? '✓ Test passed' : '✗ Test failed'));
    process.exit(success ? 0 : 1);
  })
  .catch(err => {
    console.error('\n✗ Error:', err);
    process.exit(1);
  });
