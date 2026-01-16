/**
 * Smoke tests with real Anthropic API
 * Run with: npx tsx test/smoke.test.ts
 *
 * These tests verify the core streaming and tool execution flow.
 * Model outputs are non-deterministic, so we test structural behavior
 * rather than specific content.
 */

import { Membrane } from '../src/membrane.js';
import { AnthropicAdapter } from '../src/providers/anthropic.js';
import type { NormalizedRequest, ToolCall, ToolResult } from '../src/types/index.js';
import { isAbortedResponse } from '../src/types/index.js';

// ============================================================================
// Configuration
// ============================================================================

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error('ANTHROPIC_API_KEY environment variable is required');
  process.exit(1);
}
const MODEL = 'claude-haiku-4-5-20251001';

// ============================================================================
// Test Helpers
// ============================================================================

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`  FAIL: ${message}`);
    failed++;
    return false;
  } else {
    console.log(`  PASS: ${message}`);
    passed++;
    return true;
  }
}

async function runTest(name: string, fn: () => Promise<void>) {
  console.log(`\n--- ${name} ---`);
  try {
    await fn();
  } catch (error) {
    console.error(`  ERROR: ${error}`);
    failed++;
  }
}

// Add delay between tests to avoid rate limiting
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// Setup
// ============================================================================

const adapter = new AnthropicAdapter({ apiKey: API_KEY });
const membrane = new Membrane(adapter);

// ============================================================================
// Test 1: Basic Streaming Works
// ============================================================================

await runTest('Test 1: Basic Streaming', async () => {
  const request: NormalizedRequest = {
    messages: [
      { participant: 'Alice', content: [{ type: 'text', text: 'Count from 1 to 5.' }] },
    ],
    config: { model: MODEL, maxTokens: 100 },
  };

  let chunks: string[] = [];
  const response = await membrane.stream(request, {
    onChunk: (chunk) => {
      chunks.push(chunk);
      process.stdout.write(chunk);
    },
  });
  console.log('');

  assert(!isAbortedResponse(response), 'Response should not be aborted');

  if (!isAbortedResponse(response)) {
    // Verify streaming worked
    const hasContent = response.rawAssistantText.length > 0;
    assert(hasContent, `Should have content (got ${response.rawAssistantText.length} chars)`);

    if (hasContent) {
      assert(chunks.length > 0, `Should have received chunks (got ${chunks.length})`);
      assert(chunks.join('') === response.rawAssistantText, 'Chunks should match raw text');
    }

    // Usage should be populated
    assert(response.usage.outputTokens > 0, `Should have output tokens (got ${response.usage.outputTokens})`);
  }
});

await delay(1000);

// ============================================================================
// Test 2: Tool Execution Flow
// ============================================================================

await runTest('Test 2: Tool Execution Flow', async () => {
  const request: NormalizedRequest = {
    messages: [
      {
        participant: 'Alice',
        content: [{ type: 'text', text: 'Use the add_numbers tool to add 10 and 20.' }]
      },
    ],
    tools: [
      {
        name: 'add_numbers',
        description: 'Adds two numbers together and returns the sum.',
        inputSchema: {
          type: 'object',
          properties: {
            a: { type: 'number', description: 'First number' },
            b: { type: 'number', description: 'Second number' },
          },
          required: ['a', 'b'],
        },
      },
    ],
    config: { model: MODEL, maxTokens: 500 },
  };

  let toolCallCount = 0;
  let receivedToolCalls: ToolCall[] = [];

  const response = await membrane.stream(request, {
    onChunk: (chunk) => process.stdout.write(chunk),
    onToolCalls: async (calls: ToolCall[]) => {
      toolCallCount++;
      receivedToolCalls.push(...calls);
      console.log(`\n  [onToolCalls invoked: ${calls.map(c => c.name).join(', ')}]`);

      return calls.map(call => ({
        toolUseId: call.id,
        content: JSON.stringify({ result: 30 }),
      }));
    },
  });
  console.log('');

  assert(!isAbortedResponse(response), 'Response should not be aborted');

  if (!isAbortedResponse(response)) {
    // Check if tool was called via callback
    if (toolCallCount > 0) {
      assert(true, `Tool callback was invoked ${toolCallCount} time(s)`);
      assert(receivedToolCalls.length > 0, 'Should have received tool calls');
      assert(response.toolResults.length > 0, 'Should have tool results in response');

      // Tool results should be in the raw text (as XML)
      const hasResults = response.rawAssistantText.includes('<function_results>') ||
                         response.rawAssistantText.includes('result');
      assert(hasResults, 'Raw text should contain tool results');
    } else {
      // Model might not have called tool - check if it's in the parsed response
      if (response.toolCalls.length > 0) {
        console.log('  NOTE: Tool calls parsed but callback not invoked (stop sequence issue?)');
        assert(false, 'Tool callback should have been invoked');
      } else {
        console.log('  NOTE: Model did not use tool - this can happen');
        assert(false, 'Model should have used the tool');
      }
    }
  }
});

await delay(1000);

// ============================================================================
// Test 3: Multi-turn Tool Execution
// ============================================================================

await runTest('Test 3: Multi-turn Tool Execution', async () => {
  const request: NormalizedRequest = {
    messages: [
      {
        participant: 'Alice',
        content: [{
          type: 'text',
          text: 'I need you to check the status twice. First call check_status with id="first", then call it again with id="second".'
        }],
      },
    ],
    tools: [
      {
        name: 'check_status',
        description: 'Checks status of something by ID',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'ID to check' },
          },
          required: ['id'],
        },
      },
    ],
    config: { model: MODEL, maxTokens: 1000 },
  };

  let toolCallCount = 0;
  const idsChecked: string[] = [];

  const response = await membrane.stream(request, {
    onChunk: (chunk) => process.stdout.write(chunk),
    onToolCalls: async (calls: ToolCall[]) => {
      toolCallCount++;
      for (const call of calls) {
        const id = call.input.id as string;
        idsChecked.push(id);
        console.log(`\n  [Tool call #${toolCallCount}: check_status(${id})]`);
      }

      return calls.map(call => ({
        toolUseId: call.id,
        content: `Status for ${call.input.id}: OK`,
      }));
    },
  });
  console.log('');

  assert(!isAbortedResponse(response), 'Response should not be aborted');

  if (!isAbortedResponse(response)) {
    console.log(`  Tool callback invoked ${toolCallCount} time(s), IDs: ${idsChecked.join(', ')}`);

    // We expect at least one tool call
    if (toolCallCount >= 1) {
      assert(true, 'Tool was called at least once');
      assert(response.toolResults.length >= 1, 'Should have at least one tool result');
    } else {
      assert(false, 'Tool should have been called at least once');
    }
  }
});

await delay(1000);

// ============================================================================
// Test 4: False Positive Resistance
// ============================================================================

await runTest('Test 4: Stop Sequence in Tool Result', async () => {
  // Test that content in tool results doesn't cause premature stops
  const request: NormalizedRequest = {
    messages: [
      {
        participant: 'Alice',
        content: [{ type: 'text', text: 'Use the get_log tool to get the chat log.' }],
      },
    ],
    tools: [
      {
        name: 'get_log',
        description: 'Returns a chat log',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ],
    config: { model: MODEL, maxTokens: 500 },
  };

  let toolCalled = false;
  let responseAfterTool = '';

  const response = await membrane.stream(request, {
    onChunk: (chunk) => {
      process.stdout.write(chunk);
      if (toolCalled) {
        responseAfterTool += chunk;
      }
    },
    onToolCalls: async (calls: ToolCall[]) => {
      toolCalled = true;
      console.log(`\n  [Tool called: ${calls[0]?.name}]`);

      // Return content with potential stop sequences embedded
      return calls.map(call => ({
        toolUseId: call.id,
        content: `Chat log:
User: Hello
Claude: Hi there!
User: Thanks
---end---`,
      }));
    },
  });
  console.log('');

  assert(!isAbortedResponse(response), 'Response should not be aborted');

  if (!isAbortedResponse(response)) {
    if (toolCalled) {
      assert(true, 'Tool was called');

      // The model should continue after receiving tool results
      const hasToolResults = response.rawAssistantText.includes('<function_results>') ||
                            response.rawAssistantText.includes('Chat log');
      assert(hasToolResults, 'Should include tool results in output');

      // Response should complete normally
      assert(response.stopReason === 'end_turn', `Should end normally (got ${response.stopReason})`);
    } else {
      console.log('  NOTE: Model did not call tool');
      assert(false, 'Model should have called the tool');
    }
  }
});

// ============================================================================
// Summary
// ============================================================================

console.log('\n========================================');
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('========================================\n');

if (failed > 0) {
  process.exit(1);
}
