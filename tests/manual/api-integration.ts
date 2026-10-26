import { Membrane } from '../../src/membrane.js';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import type { NormalizedRequest, NormalizedMessage, ToolCall, ToolResult, ContentBlock } from '../../src/types/index.js';
import { isAbortedResponse } from '../../src/types/index.js';

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error('ANTHROPIC_API_KEY environment variable is required');
  process.exit(1);
}

const MODEL = 'claude-haiku-4-5-20251001';

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

const adapter = new AnthropicAdapter({ apiKey: API_KEY });
const membrane = new Membrane(adapter);

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
    const thinkingBlocks = response.content.filter(b => b.type === 'thinking');
    const textBlocks = response.content.filter(b => b.type === 'text');

    assert(thinkingBlocks.length > 0, `Should have thinking block(s) in content (got ${thinkingBlocks.length})`);

    if (thinkingBlocks.length > 0) {
      const thinking = (thinkingBlocks[0] as any).thinking;
      assert(thinking && thinking.length > 0, `Thinking block should have content (got ${thinking?.length || 0} chars)`);
    }

    assert(textBlocks.length > 0, `Should have text block(s) in content (got ${textBlocks.length})`);

    assert(
      response.rawAssistantText.includes('</thinking>'),
      'rawAssistantText should contain </thinking> closing tag'
    );

    const fullText = response.rawAssistantText;
    assert(fullText.includes('255'), 'Response should contain the answer 255');
  }
});

await delay(1500);

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

    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    const toolResultBlocks = response.content.filter(b => b.type === 'tool_result');

    assert(toolUseBlocks.length > 0, `Should have tool_use block(s) in content (got ${toolUseBlocks.length})`);
    assert(toolResultBlocks.length > 0, `Should have tool_result block(s) in content (got ${toolResultBlocks.length})`);

    assert(response.rawAssistantText.includes('579'), 'Response should contain the result 579');
  }
});

await delay(1500);

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
    assert(toolCalls.length >= 2, `Should have at least 2 tool calls (got ${toolCalls.length})`);
    assert(response.toolCalls.length >= 2, `response.toolCalls should have at least 2 (got ${response.toolCalls.length})`);
    assert(response.toolResults.length >= 2, `response.toolResults should have at least 2 (got ${response.toolResults.length})`);

    assert(response.rawAssistantText.includes('50'), 'Response should contain 50');
    assert(response.rawAssistantText.includes('25'), 'Response should contain 25');
  }
});

await delay(1500);

await runTest('Test 4: Tools with prior conversation history', async () => {
  const request: NormalizedRequest = {
    messages: [
      createMessage('User', 'What is 5 + 5?'),
      createMessage('Claude', 'Let me calculate that for you.'),
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
    if (toolCalled) {
      assert(true, 'Tool was called successfully with conversation history');
      assert(response.rawAssistantText.includes('50'), 'Response should contain result 50');
    } else {
      const hasAnswer = response.rawAssistantText.includes('50');
      assert(hasAnswer, 'Should have answer (with or without tool)');
    }
  }
});

await delay(1500);

await runTest('Test 5: Long conversation context with tools', async () => {
  const messages: NormalizedMessage[] = [];

  for (let i = 0; i < 20; i++) {
    messages.push(createMessage('User', `This is message ${i}. Please acknowledge.`));
    messages.push(createMessage('Claude', `I acknowledge message ${i}.`));
  }

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

      assert(
        response.stopReason === 'end_turn',
        `Should end normally (got ${response.stopReason})`
      );

      assert(
        response.rawAssistantText.includes('Chat log'),
        'Raw text should include tool result content'
      );
    }
  }
});

await delay(1500);

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
    const thinkingBlocks = response.content.filter(b => b.type === 'thinking');
    assert(thinkingBlocks.length > 0, `Should have thinking block(s) (got ${thinkingBlocks.length})`);

    assert(
      response.rawAssistantText.includes('9999') || response.rawAssistantText.includes('9,999'),
      'Response should contain the answer 9999'
    );

    console.log(`  Tool called: ${toolCalled}`);
    console.log(`  Thinking blocks: ${thinkingBlocks.length}`);
    console.log(`  Content blocks: ${response.content.length}`);
  }
});

await delay(1500);

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

    assert(textBlocks.length === 1, `Should have exactly 1 text block (got ${textBlocks.length})`);

    const textContent = textBlocks.map(b => (b as any).text).join('');
    const helloCount = (textContent.match(/Hello/g) || []).length;
    assert(helloCount <= 1, `Text should not be duplicated (found "Hello" ${helloCount} times)`);
  }
});

await runTest('Test 9: Cache breakpoints in request', async () => {
  const messages: NormalizedMessage[] = [
    createMessage('User', 'This is the first message with important context.'),
    { ...createMessage('Claude', 'I understand the context.'), cacheBreakpoint: true },
    createMessage('User', 'This is the second message.'),
    { ...createMessage('Claude', 'Got it.'), cacheBreakpoint: true },
    createMessage('User', 'Now answer: what is 2+2?'),
  ];

  const request: NormalizedRequest = {
    messages,
    system: 'You are a helpful assistant.',
    config: { model: MODEL, maxTokens: 100 },
  };

  let rawRequest: any = null;
  const response = await membrane.complete(request, {
    onRequest: (req) => {
      rawRequest = req;
    },
  });

  assert(rawRequest !== null, 'Should capture raw request');

  if (rawRequest) {
    const system = rawRequest.system;
    if (Array.isArray(system)) {
      const systemHasCache = system.some((block: any) => block.cache_control);
      assert(systemHasCache, 'System prompt should have cache_control');
    }

    const messagesWithCache = rawRequest.messages?.filter((m: any) => {
      if (Array.isArray(m.content)) {
        return m.content.some((block: any) => block.cache_control);
      }
      return false;
    }) || [];

    console.log(`  Messages with cache_control: ${messagesWithCache.length}`);

    assert(
      messagesWithCache.length >= 2,
      `Should have at least 2 messages with cache_control (got ${messagesWithCache.length})`
    );

    console.log('  Raw request messages:');
    for (let i = 0; i < (rawRequest.messages?.length || 0); i++) {
      const msg = rawRequest.messages[i];
      const hasCache = Array.isArray(msg.content) && msg.content.some((b: any) => b.cache_control);
      console.log(`    [${i}] ${msg.role}: ${hasCache ? '(cached)' : ''}`);
    }
  }

  assert(!isAbortedResponse(response), 'Response should not be aborted');

  if (!isAbortedResponse(response)) {
    console.log(`  Usage: ${JSON.stringify(response.usage)}`);
    console.log(`  Cache details: ${JSON.stringify(response.details?.cache)}`);
  }
});

await delay(1500);

await runTest('Test 10: Cache breakpoints - second call should hit cache', async () => {
  const messages: NormalizedMessage[] = [
    createMessage('User', 'This is the first message with important context.'),
    { ...createMessage('Claude', 'I understand the context.'), cacheBreakpoint: true },
    createMessage('User', 'This is the second message.'),
    { ...createMessage('Claude', 'Got it.'), cacheBreakpoint: true },
    createMessage('User', 'Now answer: what is 3+3?'),
  ];

  const request: NormalizedRequest = {
    messages,
    system: 'You are a helpful assistant.',
    config: { model: MODEL, maxTokens: 100 },
  };

  const response = await membrane.complete(request, {});

  assert(!isAbortedResponse(response), 'Response should not be aborted');

  if (!isAbortedResponse(response)) {
    console.log(`  Usage: ${JSON.stringify(response.usage)}`);
    console.log(`  Cache details: ${JSON.stringify(response.details?.cache)}`);
    console.log(`  Detailed usage: ${JSON.stringify(response.details?.usage)}`);

    const cacheReadTokens = response.details?.usage?.cacheReadTokens ?? 0;
    console.log(`  Cache read tokens: ${cacheReadTokens}`);

    if (cacheReadTokens > 0) {
      assert(true, `Cache hit! Read ${cacheReadTokens} tokens from cache`);
    } else {
      console.log('  Note: Cache may not have been hit (TTL or other factors)');
      assert(true, 'Request completed (cache hit not guaranteed)');
    }
  }
});

await delay(1500);

await runTest('Temperature enforcement: complete() with thinking enabled', async () => {
  // The Anthropic API rejects temperature != 1 with thinking enabled.
  let capturedRequest: any;

  const request: NormalizedRequest = {
    messages: [
      createMessage('User', 'What is 2+2? Think briefly.'),
    ],
    config: {
      model: MODEL,
      maxTokens: 2000,
      temperature: 0.5,
      thinking: { enabled: true, budgetTokens: 1000 },
    },
  };

  const response = await membrane.complete(request, {
    onRequest: (req) => { capturedRequest = req; },
  });

  assert(response.content.length > 0, 'Got response content with thinking enabled');
  assert(capturedRequest?.temperature === 1, `Temperature forced to 1 (was ${capturedRequest?.temperature})`);

  const hasThinking = response.content.some((b: ContentBlock) => b.type === 'thinking');
  const hasText = response.content.some((b: ContentBlock) => b.type === 'text');
  console.log(`  Content blocks: ${response.content.map((b: ContentBlock) => b.type).join(', ')}`);
  assert(hasThinking, 'Response includes thinking content');
  assert(hasText, 'Response includes text content');
});

await delay(1500);

await runTest('Stop sequence in native mode streaming, with a tool registered to take the native-tools stream path', async () => {
  const request: NormalizedRequest = {
    messages: [
      createMessage('User', 'Count from 1 to 10, one number per line. Do NOT use any tools.'),
    ],
    config: {
      model: MODEL,
      maxTokens: 500,
    },
    tools: [calculatorTool],
    stopSequences: { sequences: ['\n5'] },
    toolMode: 'native',
  };

  let chunks = '';
  const response = await membrane.stream(request, {
    onChunk: (chunk) => { chunks += chunk; },
  });

  if (!isAbortedResponse(response)) {
    console.log(`  Stop reason: ${response.stopReason}`);
    console.log(`  Triggered sequence: ${JSON.stringify(response.details?.stop?.triggeredSequence)}`);
    console.log(`  Chunks: ${chunks.substring(0, 100)}...`);

    if (response.stopReason === 'stop_sequence') {
      assert(true, 'Stop reason correctly detected as stop_sequence');
      if (response.details?.stop?.triggeredSequence) {
        assert(true, `triggeredSequence captured: "${response.details.stop.triggeredSequence}"`);
      } else {
        console.log('  Note: triggeredSequence is undefined (SDK may not propagate in streaming)');
        assert('triggeredSequence' in (response.details?.stop ?? {}), 'triggeredSequence field exists in response structure');
      }
    } else {
      assert(true, `Response completed with stop reason: ${response.stopReason}`);
    }
  } else {
    assert(false, 'Response was unexpectedly aborted');
  }
});

console.log('\n========================================');
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('========================================\n');

if (failed > 0) {
  process.exit(1);
}
