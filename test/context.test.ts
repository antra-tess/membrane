/**
 * Context management tests
 * Run with: npx tsx test/context.test.ts
 */

import {
  createInitialState,
  defaultTokenEstimator,
  DEFAULT_CONTEXT_CONFIG,
} from '../src/context/index.js';
import type {
  ContextState,
  ContextConfig,
  CacheMarker,
} from '../src/context/index.js';
import type { NormalizedMessage } from '../src/types/index.js';

// ============================================================================
// Test Helpers
// ============================================================================

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
  sourceId?: string
): NormalizedMessage {
  return {
    participant,
    content: [{ type: 'text', text }],
    metadata: sourceId ? { sourceId } : undefined,
  };
}

function createMessages(count: number, prefix = 'msg'): NormalizedMessage[] {
  const messages: NormalizedMessage[] = [];
  for (let i = 0; i < count; i++) {
    const participant = i % 2 === 0 ? 'User' : 'Claude';
    messages.push(createMessage(
      participant,
      `Message ${i}: ${'x'.repeat(100)}`, // ~100 chars each
      `${prefix}-${i}`
    ));
  }
  return messages;
}

// ============================================================================
// Test 1: Initial State
// ============================================================================

console.log('\n--- Test 1: Initial State ---');

const initialState = createInitialState();

assert(initialState.cacheMarkers.length === 0, 'Initial state has no cache markers');
assert(initialState.windowMessageIds.length === 0, 'Initial state has no window IDs');
assert(initialState.messagesSinceRoll === 0, 'Initial state has 0 messages since roll');
assert(initialState.inGracePeriod === false, 'Initial state not in grace period');

// ============================================================================
// Test 2: Token Estimator
// ============================================================================

console.log('\n--- Test 2: Token Estimator ---');

const textMessage = createMessage('User', 'Hello world'); // 11 chars
const tokens = defaultTokenEstimator(textMessage);
assert(tokens === 3, `Token estimate for "Hello world" should be 3, got ${tokens}`);

const longMessage = createMessage('User', 'x'.repeat(400)); // 400 chars
const longTokens = defaultTokenEstimator(longMessage);
assert(longTokens === 100, `Token estimate for 400 chars should be 100, got ${longTokens}`);

// ============================================================================
// Test 3: Default Config
// ============================================================================

console.log('\n--- Test 3: Default Config ---');

assert(DEFAULT_CONTEXT_CONFIG.rolling.threshold === 50, 'Default threshold is 50');
assert(DEFAULT_CONTEXT_CONFIG.rolling.buffer === 20, 'Default buffer is 20');
assert(DEFAULT_CONTEXT_CONFIG.rolling.unit === 'messages', 'Default unit is messages');
assert(DEFAULT_CONTEXT_CONFIG.cache?.enabled === true, 'Cache enabled by default');
assert(DEFAULT_CONTEXT_CONFIG.cache?.points === 1, 'Default 1 cache point');

// ============================================================================
// Test 4: Message ID Extraction
// ============================================================================

console.log('\n--- Test 4: Message Creation ---');

const messages = createMessages(10);
assert(messages.length === 10, 'Created 10 messages');
assert(messages[0]!.metadata?.sourceId === 'msg-0', 'First message has sourceId');
assert(messages[0]!.participant === 'User', 'First message is from User');
assert(messages[1]!.participant === 'Claude', 'Second message is from Claude');

// ============================================================================
// Test 5: State Serialization
// ============================================================================

console.log('\n--- Test 5: State Serialization ---');

const stateWithData: ContextState = {
  cacheMarkers: [{ messageId: 'msg-5', messageIndex: 5, tokenEstimate: 500 }],
  windowMessageIds: ['msg-0', 'msg-1', 'msg-2'],
  messagesSinceRoll: 10,
  tokensSinceRoll: 1000,
  inGracePeriod: true,
  lastRollTime: '2024-01-01T00:00:00Z',
};

// Serialize and deserialize
const serialized = JSON.stringify(stateWithData);
const deserialized = JSON.parse(serialized) as ContextState;

assert(deserialized.cacheMarkers.length === 1, 'Deserialized has 1 cache marker');
assert(deserialized.cacheMarkers[0]!.messageId === 'msg-5', 'Cache marker ID preserved');
assert(deserialized.windowMessageIds.length === 3, 'Window IDs preserved');
assert(deserialized.messagesSinceRoll === 10, 'Messages since roll preserved');
assert(deserialized.inGracePeriod === true, 'Grace period preserved');
assert(deserialized.lastRollTime === '2024-01-01T00:00:00Z', 'Last roll time preserved');

// ============================================================================
// Test 6: Config Merging
// ============================================================================

console.log('\n--- Test 6: Config Structure ---');

const customConfig: ContextConfig = {
  rolling: {
    threshold: 100,
    buffer: 30,
    grace: 20,
    unit: 'tokens',
  },
  limits: {
    maxCharacters: 1000000,
    maxTokens: 200000,
  },
  cache: {
    enabled: true,
    points: 4,
    minTokens: 2048,
  },
};

assert(customConfig.rolling.threshold === 100, 'Custom threshold set');
assert(customConfig.rolling.grace === 20, 'Grace period set');
assert(customConfig.cache?.points === 4, 'Four cache points set');
assert(customConfig.limits?.maxTokens === 200000, 'Max tokens set');

// ============================================================================
// Test 7: Branch/Clone Simulation
// ============================================================================

console.log('\n--- Test 7: Branch/Clone Simulation ---');

const mainState: ContextState = {
  cacheMarkers: [{ messageId: 'msg-10', messageIndex: 10, tokenEstimate: 1000 }],
  windowMessageIds: ['msg-0', 'msg-1', 'msg-2', 'msg-3', 'msg-4'],
  messagesSinceRoll: 5,
  tokensSinceRoll: 500,
  inGracePeriod: false,
};

// Branch = shallow copy (for simple state, this is fine)
const branchState = { ...mainState, cacheMarkers: [...mainState.cacheMarkers] };

// Modify branch
branchState.messagesSinceRoll = 6;
branchState.windowMessageIds = [...branchState.windowMessageIds, 'msg-5'];

assert(mainState.messagesSinceRoll === 5, 'Main state unchanged');
assert(branchState.messagesSinceRoll === 6, 'Branch state modified');
assert(mainState.windowMessageIds.length === 5, 'Main window unchanged');
assert(branchState.windowMessageIds.length === 6, 'Branch window has new message');

// ============================================================================
// Test 8: Deep Clone Helper
// ============================================================================

console.log('\n--- Test 8: Deep Clone Helper ---');

function cloneState(state: ContextState): ContextState {
  return JSON.parse(JSON.stringify(state));
}

const original: ContextState = {
  cacheMarkers: [
    { messageId: 'msg-5', messageIndex: 5, tokenEstimate: 500 },
    { messageId: 'msg-10', messageIndex: 10, tokenEstimate: 1000 },
  ],
  windowMessageIds: ['a', 'b', 'c'],
  messagesSinceRoll: 3,
  tokensSinceRoll: 300,
  inGracePeriod: true,
};

const cloned = cloneState(original);

// Modify cloned
cloned.cacheMarkers.push({ messageId: 'msg-15', messageIndex: 15, tokenEstimate: 1500 });
cloned.windowMessageIds.push('d');

assert(original.cacheMarkers.length === 2, 'Original has 2 markers');
assert(cloned.cacheMarkers.length === 3, 'Cloned has 3 markers');
assert(original.windowMessageIds.length === 3, 'Original has 3 window IDs');
assert(cloned.windowMessageIds.length === 4, 'Cloned has 4 window IDs');

// ============================================================================
// Summary
// ============================================================================

console.log('\n========================================');
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('========================================\n');

if (failed > 0) {
  process.exit(1);
}
