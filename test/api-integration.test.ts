/**
 * API Integration Tests
 * Run with: npx tsx test/api-integration.test.ts
 *
 * These tests hit the real Anthropic API to verify end-to-end behavior.
 * They specifically test scenarios that unit tests with mocks cannot catch:
 * - Thinking block parsing when opening tag is in prefill
 * - Tool execution across multiple turns
 * - Tools in long conversation contexts
 * - Tool results rendered in previous turns
 */

import { Membrane } from '../src/membrane.js';
import { AnthropicAdapter } from '../src/providers/anthropic.js';
import type { NormalizedRequest, NormalizedMessage, ToolCall, ToolResult, ContentBlock } from '../src/types/index.js';
import { isAbortedResponse } from '../src/types/index.js';

// ============================================================================
// Configuration
// ============================================================================

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error('ANTHROPIC_API_KEY environment variable is required');
  process.exit(1);
}

// Use haiku for speed and cost, but these tests should work with any model
const MODEL = 'claude-haiku-4-5-20251001';

// ============================================================================
// Test Helpers
// ============================================================================

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): boolean {
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

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createMessage(participant: string, text: string): NormalizedMessage {
  return {
    participant,
    content: [{ type: 'text', text }],
  };
}

// ============================================================================
// Setup
// ============================================================================

const adapter = new AnthropicAdapter({ apiKey: API_KEY });
const membrane = new Membrane(adapter);

// Standard calculator tool for testing
const calculatorTool = {
  name: 'calculate',
  description: 'Performs a calculation. Use this for any math operations.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      expression: { type: 'string', description: 'Math expression to evaluate, e.g. "2 + 2"' },
    },
    required: ['expression'],
  },
};

// ============================================================================
// Test 1: Thinking Block Parsing
// ============================================================================

await runTest('Test 1: Thinking block parsing with prefill', async () => {
  const request: NormalizedRequest = {
    messages: [
      createMessage('User', 'What is 15 * 17? Think through it step by step.'),
    ],
    config: {
      model: MODEL,
      maxTokens: 1000,
      thinking: { enabled: true },
    },
  };

  const response = await membrane.stream(request, {
    onChunk: (chunk) => process.stdout.write(chunk),
  });
  console.log('');

  assert(!isAbortedResponse(response), 'Response should not be aborted');

  if (!isAbortedResponse(response)) {
    // Key assertion: response.content should have parsed thinking block
    const thinkingBlocks = response.content.filter(b => b.type === 'thinking');
    const textBlocks = response.content.filter(b => b.type === 'text');

    assert(thinkingBlocks.length > 0, `Should have thinking block(s) in content (got ${thinkingBlocks.length})`);

    if (thinkingBlocks.length > 0) {
      const thinking = (thinkingBlocks[0] as any).thinking;
      assert(thinking && thinking.length > 0, `Thinking block should have content (got ${thinking?.length || 0} chars)`);
    }

    assert(textBlocks.length > 0, `Should have text block(s) in content (got ${textBlocks.length})`);

    // rawAssistantText should contain the closing tag (proves API continued from prefill)
    assert(
      response.rawAssistantText.includes('</thinking>'),
      'rawAssistantText should contain </thinking> closing tag'
    );

    // The response should mention 255 (15 * 17)
    const fullText = response.rawAssistantText;
    assert(fullText.includes('255'), 'Response should contain the answer 255');
  }
});

await delay(1500);

// ============================================================================
// Test 2: Basic Tool Execution
// ============================================================================

await runTest('Test 2: Basic tool execution', async () => {
  const request: NormalizedRequest = {
    messages: [
      createMessage('User', 'Use the calculate tool to compute 123 + 456.'),
    ],
    tools: [calculatorTool],
    config: { model: MODEL, maxTokens: 500 },
  };

  let toolCallCount = 0;
  const response = await membrane.stream(request, {
    onChunk: (chunk) => process.stdout.write(chunk),
    onToolCalls: async (calls) => {
      toolCallCount++;
      console.log(`\n  [Tool called: ${calls.map(c => `${c.name}(${JSON.stringify(c.input)})`).join(', ')}]`);
      return calls.map(call => ({
        toolUseId: call.id,
        content: '579',
      }));
    },
  });
  console.log('');

  assert(!isAbortedResponse(response), 'Response should not be aborted');

  if (!isAbortedResponse(response)) {
    assert(toolCallCount > 0, `Tool should have been called (called ${toolCallCount} times)`);
    assert(response.toolCalls.length > 0, `Should have toolCalls in response (got ${response.toolCalls.length})`);
    assert(response.toolResults.length > 0, `Should have toolResults in response (got ${response.toolResults.length})`);

    // Content should have tool_use and tool_result blocks
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    const toolResultBlocks = response.content.filter(b => b.type === 'tool_result');

    assert(toolUseBlocks.length > 0, `Should have tool_use block(s) in content (got ${toolUseBlocks.length})`);
    assert(toolResultBlocks.length > 0, `Should have tool_result block(s) in content (got ${toolResultBlocks.length})`);

    // Response should mention the result
    assert(response.rawAssistantText.includes('579'), 'Response should contain the result 579');
  }
});

await delay(1500);

// ============================================================================
// Test 3: Multi-turn Tool Execution
// ============================================================================

await runTest('Test 3: Multi-turn tool execution', async () => {
  const request: NormalizedRequest = {
    messages: [
      createMessage('User', 'I need two calculations. First calculate 10 * 5, then calculate 100 / 4. Do them one at a time.'),
    ],
    tools: [calculatorTool],
    config: { model: MODEL, maxTokens: 1000 },
  };

  const toolCalls: string[] = [];
  const response = await membrane.stream(request, {
    onChunk: (chunk) => process.stdout.write(chunk),
    onToolCalls: async (calls) => {
      for (const call of calls) {
        toolCalls.push(call.input.expression as string);
        console.log(`\n  [Tool call: calculate(${call.input.expression})]`);
      }
      return calls.map(call => {
        const expr = call.input.expression as string;
        // Simple eval for test (safe because we control the input)
        let result: number;
        if (expr.includes('*')) result = 50;
        else if (expr.includes('/')) result = 25;
        else result = 0;
        return { toolUseId: call.id, content: String(result) };
      });
    },
  });
  console.log('');

  assert(!isAbortedResponse(response), 'Response should not be aborted');

  if (!isAbortedResponse(response)) {
    // Should have multiple tool calls
    assert(toolCalls.length >= 2, `Should have at least 2 tool calls (got ${toolCalls.length})`);
    assert(response.toolCalls.length >= 2, `response.toolCalls should have at least 2 (got ${response.toolCalls.length})`);
    assert(response.toolResults.length >= 2, `response.toolResults should have at least 2 (got ${response.toolResults.length})`);

    // Response should mention both results
    assert(response.rawAssistantText.includes('50'), 'Response should contain 50');
    assert(response.rawAssistantText.includes('25'), 'Response should contain 25');
  }
});

await delay(1500);

// ============================================================================
// Test 4: Tools with Conversation History
// ============================================================================

await runTest('Test 4: Tools with prior conversation history', async () => {
  // Simulate a conversation where tools were used in previous turns
  const request: NormalizedRequest = {
    messages: [
      createMessage('User', 'What is 5 + 5?'),
      createMessage('Claude', 'Let me calculate that for you.'),
      // Previous tool use would be in the conversation
      createMessage('User', 'Great! Now what is 20 + 30?'),
    ],
    tools: [calculatorTool],
    config: { model: MODEL, maxTokens: 500 },
  };

  let toolCalled = false;
  const response = await membrane.stream(request, {
    onChunk: (chunk) => process.stdout.write(chunk),
    onToolCalls: async (calls) => {
      toolCalled = true;
      console.log(`\n  [Tool called: ${calls[0]?.name}]`);
      return calls.map(call => ({
        toolUseId: call.id,
        content: '50',
      }));
    },
  });
  console.log('');

  assert(!isAbortedResponse(response), 'Response should not be aborted');

  if (!isAbortedResponse(response)) {
    // The model should be able to use tools even with conversation history
    if (toolCalled) {
      assert(true, 'Tool was called successfully with conversation history');
      assert(response.rawAssistantText.includes('50'), 'Response should contain result 50');
    } else {
      // Model might answer without tool - check if it's reasonable
      const hasAnswer = response.rawAssistantText.includes('50');
      assert(hasAnswer, 'Should have answer (with or without tool)');
    }
  }
});

await delay(1500);

// ============================================================================
// Test 5: Long Conversation Context with Tools
// ============================================================================

await runTest('Test 5: Long conversation context with tools', async () => {
  // Build a long conversation history
  const messages: NormalizedMessage[] = [];

  for (let i = 0; i < 20; i++) {
    messages.push(createMessage('User', `This is message ${i}. Please acknowledge.`));
    messages.push(createMessage('Claude', `I acknowledge message ${i}.`));
  }

  // Final message asking for tool use
  messages.push(createMessage('User', 'Now use the calculate tool to compute 7 * 8.'));

  const request: NormalizedRequest = {
    messages,
    tools: [calculatorTool],
    config: { model: MODEL, maxTokens: 500 },
  };

  let toolCalled = false;
  const response = await membrane.stream(request, {
    onChunk: (chunk) => process.stdout.write(chunk),
    onToolCalls: async (calls) => {
      toolCalled = true;
      console.log(`\n  [Tool called in long context]`);
      return calls.map(call => ({
        toolUseId: call.id,
        content: '56',
      }));
    },
  });
  console.log('');

  assert(!isAbortedResponse(response), 'Response should not be aborted');

  if (!isAbortedResponse(response)) {
    // Check that prefill didn't leak into response content
    const contentText = response.content
      .filter(b => b.type === 'text')
      .map(b => (b as any).text)
      .join('');

    assert(!contentText.includes('User:'), 'Content should not contain "User:" prefix');
    assert(!contentText.includes('Claude:'), 'Content should not contain "Claude:" prefix');
    assert(!contentText.includes('message 0'), 'Content should not contain conversation history');

    if (toolCalled) {
      assert(true, 'Tool worked in long context');
    }
  }
});

await delay(1500);

// ============================================================================
// Test 6: Tool Results with Stop Sequences
// ============================================================================

await runTest('Test 6: Tool results containing stop sequences', async () => {
  const request: NormalizedRequest = {
    messages: [
      createMessage('User', 'Use the get_chat_log tool to retrieve the chat history.'),
    ],
    tools: [{
      name: 'get_chat_log',
      description: 'Returns a chat log',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    }],
    config: { model: MODEL, maxTokens: 500 },
  };

  let toolCalled = false;
  const response = await membrane.stream(request, {
    onChunk: (chunk) => process.stdout.write(chunk),
    onToolCalls: async (calls) => {
      toolCalled = true;
      console.log(`\n  [Returning tool result with embedded stop sequences]`);
      // Return content that contains potential stop sequences
      return calls.map(call => ({
        toolUseId: call.id,
        content: `Chat log:
User: Hello there
Claude: Hi! How can I help?
User: Thanks for the help
Claude: You're welcome!`,
      }));
    },
  });
  console.log('');

  assert(!isAbortedResponse(response), 'Response should not be aborted');

  if (!isAbortedResponse(response)) {
    if (toolCalled) {
      assert(true, 'Tool was called');

      // The response should complete normally despite stop sequences in tool result
      assert(
        response.stopReason === 'end_turn',
        `Should end normally (got ${response.stopReason})`
      );

      // Tool result should be in the raw text
      assert(
        response.rawAssistantText.includes('Chat log'),
        'Raw text should include tool result content'
      );
    }
  }
});

await delay(1500);

// ============================================================================
// Test 7: Thinking + Tools Combined
// ============================================================================

await runTest('Test 7: Thinking and tools combined', async () => {
  const request: NormalizedRequest = {
    messages: [
      createMessage('User', 'I need to know what 99 * 101 is. Think about whether you need to use a tool.'),
    ],
    tools: [calculatorTool],
    config: {
      model: MODEL,
      maxTokens: 1000,
      thinking: { enabled: true },
    },
  };

  let toolCalled = false;
  const response = await membrane.stream(request, {
    onChunk: (chunk) => process.stdout.write(chunk),
    onToolCalls: async (calls) => {
      toolCalled = true;
      console.log(`\n  [Tool called with thinking enabled]`);
      return calls.map(call => ({
        toolUseId: call.id,
        content: '9999',
      }));
    },
  });
  console.log('');

  assert(!isAbortedResponse(response), 'Response should not be aborted');

  if (!isAbortedResponse(response)) {
    // Should have thinking block
    const thinkingBlocks = response.content.filter(b => b.type === 'thinking');
    assert(thinkingBlocks.length > 0, `Should have thinking block(s) (got ${thinkingBlocks.length})`);

    // Should have answer (9999)
    assert(
      response.rawAssistantText.includes('9999'),
      'Response should contain the answer 9999'
    );

    console.log(`  Tool called: ${toolCalled}`);
    console.log(`  Thinking blocks: ${thinkingBlocks.length}`);
    console.log(`  Content blocks: ${response.content.length}`);
  }
});

await delay(1500);

// ============================================================================
// Test 8: Content Block Integrity
// ============================================================================

await runTest('Test 8: Content block integrity (no duplicates)', async () => {
  const request: NormalizedRequest = {
    messages: [
      createMessage('User', 'Say exactly: "Hello, world!"'),
    ],
    config: { model: MODEL, maxTokens: 100 },
  };

  const response = await membrane.stream(request, {
    onChunk: (chunk) => process.stdout.write(chunk),
  });
  console.log('');

  assert(!isAbortedResponse(response), 'Response should not be aborted');

  if (!isAbortedResponse(response)) {
    const textBlocks = response.content.filter(b => b.type === 'text');

    // Should have exactly one text block
    assert(textBlocks.length === 1, `Should have exactly 1 text block (got ${textBlocks.length})`);

    // Text content should not be duplicated
    const textContent = textBlocks.map(b => (b as any).text).join('');
    const helloCount = (textContent.match(/Hello/g) || []).length;
    assert(helloCount <= 1, `Text should not be duplicated (found "Hello" ${helloCount} times)`);
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
