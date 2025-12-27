/**
 * Prefill transform features test
 * Run with: npx tsx test/prefill-features.test.ts
 */

import { transformToPrefill, getToolInstructions } from '../src/index.js';
import type { NormalizedMessage, NormalizedRequest, ToolDefinition } from '../src/types/index.js';

// Test helpers
let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`  FAIL: ${message}`);
    failed++;
  } else {
    console.log(`  PASS: ${message}`);
    passed++;
  }
}

function createMessage(
  participant: string, 
  text: string, 
  options?: { cacheControl?: boolean; image?: boolean }
): NormalizedMessage {
  const content: any[] = [{ type: 'text', text }];
  
  if (options?.image) {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        mediaType: 'image/png',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      },
    });
  }
  
  return {
    participant,
    content,
    metadata: options?.cacheControl ? { cacheControl: { type: 'ephemeral' } } : undefined,
  };
}

const sampleTools: ToolDefinition[] = [
  {
    name: 'search',
    description: 'Search for information',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    },
  },
];

// ============================================================================
// Test 1: Tool Injection Mode - System
// ============================================================================

console.log('\n--- Test 1: Tool Injection Mode - System ---');

const request1: NormalizedRequest = {
  messages: [
    createMessage('User', 'Hello'),
    createMessage('Claude', ''),
  ],
  system: 'You are helpful.',
  tools: sampleTools,
  config: { model: 'claude-3-5-sonnet-20241022', maxTokens: 1000 },
};

const result1 = transformToPrefill(request1, { toolInjectionMode: 'system' });

// System should contain tool definitions
const systemText1 = result1.system;
assert(systemText1.includes('<available_tools>'), 'System should have tools when mode is system');
assert(systemText1.includes('search'), 'System should contain tool name');

// Conversation should NOT have tools as separate user message
const userToolMsg1 = result1.messages.filter(m => 
  m.role === 'user' && 
  typeof m.content === 'string' && 
  m.content.includes('<functions>')
);
assert(userToolMsg1.length === 0, 'Conversation should not have tool user message in system mode');

// ============================================================================
// Test 2: Tool Injection Mode - Conversation
// ============================================================================

console.log('\n--- Test 2: Tool Injection Mode - Conversation ---');

const request2: NormalizedRequest = {
  messages: [
    createMessage('User', 'Message 1'),
    createMessage('Claude', 'Response 1'),
    createMessage('User', 'Message 2'),
    createMessage('Claude', 'Response 2'),
    createMessage('User', 'Message 3'),
    createMessage('Claude', 'Response 3'),
    createMessage('User', 'Message 4'),
    createMessage('Claude', 'Response 4'),
    createMessage('User', 'Message 5'),
    createMessage('Claude', 'Response 5'),
    createMessage('User', 'Message 6'),
    createMessage('Claude', 'Response 6'),
    createMessage('User', 'Final question'),
    createMessage('Claude', ''),
  ],
  system: 'You are helpful.',
  tools: sampleTools,
  config: { model: 'claude-3-5-sonnet-20241022', maxTokens: 1000 },
};

const result2 = transformToPrefill(request2, { 
  toolInjectionMode: 'conversation',
  toolInjectionPosition: 5,
});

// System should NOT contain tool definitions
assert(!result2.system.includes('<available_tools>'), 'System should not have tools in conversation mode');

// Conversation should have tools as user message
const userToolMsg2 = result2.messages.filter(m => 
  m.role === 'user' && 
  typeof m.content === 'string' && 
  m.content.includes('<functions>')
);
assert(userToolMsg2.length === 1, 'Conversation should have exactly one tool user message');

// ============================================================================
// Test 3: Tool Injection Mode - None
// ============================================================================

console.log('\n--- Test 3: Tool Injection Mode - None ---');

const result3 = transformToPrefill(request1, { toolInjectionMode: 'none' });

assert(!result3.system.includes('<available_tools>'), 'System should not have tools in none mode');

const hasAnyTools = result3.messages.some(m => {
  if (typeof m.content === 'string') {
    return m.content.includes('<functions>') || m.content.includes('<available_tools>');
  }
  return false;
});
assert(!hasAnyTools, 'No tools should be injected in none mode');

// ============================================================================
// Test 4: getToolInstructions utility
// ============================================================================

console.log('\n--- Test 4: getToolInstructions utility ---');

const instructions = getToolInstructions(sampleTools);
assert(instructions.includes('<functions>'), 'Instructions should have functions wrapper');
assert(instructions.includes('search'), 'Instructions should contain tool name');
assert(instructions.includes('function_calls'), 'Instructions should have usage example');

// ============================================================================
// Test 5: Image Flushing
// ============================================================================

console.log('\n--- Test 5: Image Flushing ---');

const requestWithImage: NormalizedRequest = {
  messages: [
    createMessage('User', 'Hello'),
    createMessage('Claude', 'Hi there!'),
    createMessage('User', 'Look at this image', { image: true }),
    createMessage('Claude', 'Nice image!'),
    createMessage('User', 'Thanks'),
    createMessage('Claude', ''),
  ],
  system: 'You are helpful.',
  config: { model: 'claude-3-5-sonnet-20241022', maxTokens: 1000 },
};

const resultImage = transformToPrefill(requestWithImage, { promptCaching: false });

// Find user message with image
const userMsgWithImage = resultImage.messages.find(m => {
  if (m.role === 'user' && Array.isArray(m.content)) {
    return m.content.some((b: any) => b.type === 'image');
  }
  return false;
});

assert(userMsgWithImage !== undefined, 'Image should be in a user message');
assert(userMsgWithImage?.role === 'user', 'Image message should have user role');

// The image message should also have the participant text
if (Array.isArray(userMsgWithImage?.content)) {
  const textBlock = userMsgWithImage.content.find((b: any) => b.type === 'text');
  assert(
    textBlock && (textBlock as any).text.includes('User:'),
    'Image user message should include participant prefix'
  );
}

// ============================================================================
// Test 6: Message Delimiter
// ============================================================================

console.log('\n--- Test 6: Message Delimiter ---');

const requestDelim: NormalizedRequest = {
  messages: [
    createMessage('User', 'Hello'),
    createMessage('Claude', 'Hi!'),
    createMessage('User', 'How are you?'),
    createMessage('Claude', ''),
  ],
  config: { model: 'claude-3-5-sonnet-20241022', maxTokens: 1000 },
};

const resultDelim = transformToPrefill(requestDelim, { 
  messageDelimiter: '</s>',
  promptCaching: false,
});

// Check that delimiter is in the content
const assistantContent = resultDelim.messages
  .filter(m => m.role === 'assistant')
  .map(m => typeof m.content === 'string' ? m.content : '')
  .join('');

assert(assistantContent.includes('</s>'), 'Messages should include delimiter');
assert(assistantContent.includes('Hello</s>'), 'Delimiter should follow message content');

// ============================================================================
// Test 7: Context Prefix (Simulacrum Seeding)
// ============================================================================

console.log('\n--- Test 7: Context Prefix ---');

const requestPrefix: NormalizedRequest = {
  messages: [
    createMessage('User', 'Hello'),
    createMessage('Claude', ''),
  ],
  system: 'You are helpful.',
  config: { model: 'claude-3-5-sonnet-20241022', maxTokens: 1000 },
};

const resultPrefix = transformToPrefill(requestPrefix, { 
  contextPrefix: '[Character backstory and personality goes here]',
  promptCaching: true,
});

// Should have user message before the prefix
const userMsgs = resultPrefix.messages.filter(m => m.role === 'user');
const assistantMsgs = resultPrefix.messages.filter(m => m.role === 'assistant');

assert(userMsgs.length >= 1, 'Should have user message for prefix');

// First assistant message should be the context prefix with cache_control
const firstAssistant = assistantMsgs[0];
assert(firstAssistant !== undefined, 'Should have assistant message for prefix');

if (Array.isArray(firstAssistant?.content)) {
  const prefixBlock = firstAssistant.content[0] as any;
  assert(
    prefixBlock?.text?.includes('backstory'),
    'First assistant should contain context prefix'
  );
  assert(
    prefixBlock?.cache_control?.type === 'ephemeral',
    'Context prefix should have cache_control'
  );
}

// ============================================================================
// Test 8: Prefill Thinking
// ============================================================================

console.log('\n--- Test 8: Prefill Thinking ---');

const resultThinking = transformToPrefill(requestPrefix, { 
  prefillThinking: true,
  promptCaching: false,
});

// Last assistant content should start with <thinking>
const lastAssistant = resultThinking.messages
  .filter(m => m.role === 'assistant')
  .pop();

const lastContent = typeof lastAssistant?.content === 'string' 
  ? lastAssistant.content 
  : '';

assert(
  lastContent.includes('<thinking>'),
  'Prefill should include <thinking> tag when enabled'
);
assert(
  lastContent.includes('Claude: <thinking>'),
  'Thinking tag should follow participant name'
);

// ============================================================================
// Test 9: Bot Continuation
// ============================================================================

console.log('\n--- Test 9: Bot Continuation ---');

const requestContinue: NormalizedRequest = {
  messages: [
    createMessage('User', 'Tell me a story'),
    createMessage('Claude', 'Once upon a time...'),
    createMessage('Claude', ''), // Empty continuation
  ],
  config: { model: 'claude-3-5-sonnet-20241022', maxTokens: 1000 },
};

const resultContinue = transformToPrefill(requestContinue, { promptCaching: false });

// The prefill should end with the previous Claude message, ready to continue
const continueContent = resultContinue.messages
  .filter(m => m.role === 'assistant')
  .map(m => typeof m.content === 'string' ? m.content : '')
  .join('');

assert(
  continueContent.includes('Once upon a time'),
  'Continuation should include previous bot message'
);

// Should NOT have double "Claude:" prefix
const claudeCount = (continueContent.match(/Claude:/g) || []).length;
assert(
  claudeCount <= 2, // One for the message, possibly one for continuation
  'Should not have excessive Claude: prefixes'
);

// ============================================================================
// Test 10: Stop Sequences Include Tool Stop
// ============================================================================

console.log('\n--- Test 10: Stop Sequences ---');

assert(
  result1.stopSequences.includes('</function_calls>'),
  'Stop sequences should include tool stop'
);
assert(
  result1.stopSequences.some(s => s.includes('User:')),
  'Stop sequences should include participant stops'
);

// ============================================================================
// Summary
// ============================================================================

console.log('\n========================================');
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('========================================\n');

if (failed > 0) {
  process.exit(1);
}
