/**
 * Cache control verification test
 * Run with: npx tsx test/cache-control.test.ts
 */

import { transformToPrefill } from '../src/transforms/prefill.js';
import type { NormalizedMessage, NormalizedRequest } from '../src/types/index.js';

// Test helpers
function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  }
  console.log(`PASS: ${message}`);
}

function createMessage(participant: string, text: string, cacheControl?: boolean): NormalizedMessage {
  return {
    participant,
    content: [{ type: 'text', text }],
    metadata: cacheControl ? { cacheControl: { type: 'ephemeral' } } : undefined,
  };
}

// ============================================================================
// Test 1: System prompt gets cache_control
// ============================================================================

console.log('\n--- Test 1: System prompt gets cache_control ---');

const request1: NormalizedRequest = {
  messages: [
    createMessage('User', 'Hello'),
    createMessage('Claude', ''),
  ],
  system: 'You are a helpful assistant.',
  config: { model: 'claude-3-5-sonnet-20241022', maxTokens: 1000 },
};

const result1 = transformToPrefill(request1, { promptCaching: true });

assert(result1.systemContent.length > 0, 'System content should not be empty');
assert(result1.systemContent[0]?.type === 'text', 'System content should be text');
assert(
  (result1.systemContent[0] as any).cache_control?.type === 'ephemeral',
  'System content should have cache_control'
);
assert(result1.cacheMarkersApplied >= 1, 'Should have at least 1 cache marker');

// ============================================================================
// Test 2: Content before cache marker gets cache_control
// ============================================================================

console.log('\n--- Test 2: Content before cache marker gets cache_control ---');

const request2: NormalizedRequest = {
  messages: [
    createMessage('Alice', 'First message'),
    createMessage('Bob', 'Second message'),
    createMessage('Alice', 'Third message', true), // Cache marker here
    createMessage('Bob', 'Fourth message (uncached)'),
    createMessage('Claude', ''),
  ],
  system: 'System prompt',
  config: { model: 'claude-3-5-sonnet-20241022', maxTokens: 1000 },
};

const result2 = transformToPrefill(request2, { promptCaching: true });

// Find assistant messages with cache_control
let foundCachedAssistant = false;
let foundUncachedAssistant = false;

for (const msg of result2.messages) {
  if (msg.role === 'assistant') {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if ((block as any).cache_control) {
          foundCachedAssistant = true;
        }
      }
    }
  }
}

// The last assistant message should NOT have cache_control (it's after the marker)
const lastAssistant = result2.messages.filter(m => m.role === 'assistant').pop();
if (lastAssistant && typeof lastAssistant.content === 'string') {
  foundUncachedAssistant = true;
}

assert(foundCachedAssistant, 'Should have cached assistant content (before marker)');
assert(result2.cacheMarkersApplied >= 2, 'Should have multiple cache markers (system + content before marker)');

console.log(`Cache markers applied: ${result2.cacheMarkersApplied}`);

// ============================================================================
// Test 3: No cache_control when prompt caching disabled
// ============================================================================

console.log('\n--- Test 3: No cache_control when prompt caching disabled ---');

const result3 = transformToPrefill(request1, { promptCaching: false });

assert(result3.cacheMarkersApplied === 0, 'Should have 0 cache markers when disabled');

const hasAnyCacheControl = result3.messages.some(msg => {
  if (Array.isArray(msg.content)) {
    return msg.content.some((block: any) => block.cache_control);
  }
  return false;
});

assert(!hasAnyCacheControl, 'No content should have cache_control when disabled');

// ============================================================================
// Test 4: Messages structure is correct
// ============================================================================

console.log('\n--- Test 4: Messages structure ---');

const request4: NormalizedRequest = {
  messages: [
    createMessage('User', 'Hello there!'),
    createMessage('Claude', 'Hi! How can I help?'),
    createMessage('User', 'Tell me a joke'),
    createMessage('Claude', ''),
  ],
  system: 'You are helpful.',
  config: { model: 'claude-3-5-sonnet-20241022', maxTokens: 1000 },
};

const result4 = transformToPrefill(request4, { promptCaching: true });

// Should have system content (separate from messages, as Anthropic API requires)
assert(result4.systemContent.length > 0, 'Should have system content');

// Should have assistant messages with conversation
const assistantMsgs = result4.messages.filter(m => m.role === 'assistant');
assert(assistantMsgs.length > 0, 'Should have assistant messages');

// Last assistant should contain the prefill
const lastContent = assistantMsgs[assistantMsgs.length - 1]?.content;
assert(
  typeof lastContent === 'string' && lastContent.includes('Claude:'),
  'Last assistant should have prefill with participant name'
);

// ============================================================================
// Test 5: Stop sequences generated correctly
// ============================================================================

console.log('\n--- Test 5: Stop sequences ---');

assert(result4.stopSequences.includes('\nUser:'), 'Should have User stop sequence');
assert(result4.stopSequences.includes('</function_calls>'), 'Should have tool stop sequence');

// ============================================================================
// Summary
// ============================================================================

console.log('\n=== All tests passed! ===\n');

// Print example output structure
console.log('Example message structure with cache_control:');
console.log(JSON.stringify(result2.messages.slice(0, 2), null, 2));
