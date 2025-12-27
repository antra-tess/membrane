/**
 * Standalone test for membrane
 * 
 * Run with: npx tsx test.ts
 */

import { Membrane, AnthropicAdapter, textMessage } from './src/index.js';
import type { NormalizedRequest, ToolCall, ToolResult, ToolContext } from './src/index.js';

// Simple tool for testing
const echoTool = {
  name: 'echo',
  description: 'Echoes back the input message',
  inputSchema: {
    type: 'object' as const,
    properties: {
      message: {
        type: 'string',
        description: 'The message to echo back',
      },
    },
    required: ['message'],
  },
};

const calculatorTool = {
  name: 'calculate',
  description: 'Performs basic arithmetic',
  inputSchema: {
    type: 'object' as const,
    properties: {
      expression: {
        type: 'string',
        description: 'Math expression like "2 + 2"',
      },
    },
    required: ['expression'],
  },
};

// Tool executor
async function executeTool(call: ToolCall): Promise<ToolResult> {
  console.log(`\n  [Tool] Executing: ${call.name}`, call.input);
  
  if (call.name === 'echo') {
    return {
      toolUseId: call.id,
      content: `Echo: ${call.input.message}`,
    };
  }
  
  if (call.name === 'calculate') {
    try {
      // Simple eval for demo (don't do this in production!)
      const result = eval(call.input.expression as string);
      return {
        toolUseId: call.id,
        content: `Result: ${result}`,
      };
    } catch (e) {
      return {
        toolUseId: call.id,
        content: `Error: ${e}`,
        isError: true,
      };
    }
  }
  
  return {
    toolUseId: call.id,
    content: `Unknown tool: ${call.name}`,
    isError: true,
  };
}

async function testBasicCompletion() {
  console.log('\n=== Test 1: Basic Completion ===\n');
  
  const adapter = new AnthropicAdapter();
  const membrane = new Membrane(adapter);
  
  const request: NormalizedRequest = {
    messages: [
      textMessage('User', 'What is 2 + 2? Reply in one word.'),
    ],
    config: {
      model: 'claude-sonnet-4-20250514',
      maxTokens: 100,
    },
  };
  
  try {
    const response = await membrane.complete(request);
    
    console.log('Response:', response.content);
    console.log('Stop reason:', response.stopReason);
    console.log('Usage:', response.usage);
    console.log('Timing:', response.details.timing.totalDurationMs, 'ms');
  } catch (error) {
    console.error('Error:', error);
  }
}

async function testStreaming() {
  console.log('\n=== Test 2: Streaming ===\n');
  
  const adapter = new AnthropicAdapter();
  const membrane = new Membrane(adapter);
  
  const request: NormalizedRequest = {
    messages: [
      textMessage('User', 'Count from 1 to 5, with a brief pause description between each number.'),
    ],
    config: {
      model: 'claude-sonnet-4-20250514',
      maxTokens: 200,
    },
  };
  
  try {
    process.stdout.write('Streaming: ');
    
    const response = await membrane.stream(request, {
      onChunk: (chunk) => {
        process.stdout.write(chunk);
      },
    });
    
    console.log('\n\nStop reason:', response.stopReason);
    console.log('Usage:', response.usage);
  } catch (error) {
    console.error('Error:', error);
  }
}

async function testToolExecution() {
  console.log('\n=== Test 3: Tool Execution ===\n');
  
  const adapter = new AnthropicAdapter();
  const membrane = new Membrane(adapter);
  
  const request: NormalizedRequest = {
    messages: [
      textMessage('User', 'Please calculate 15 * 7 for me using the calculate tool.'),
    ],
    system: `You have access to tools. When you need to perform calculations, use the calculate tool. Always output the complete tool call including the closing </function_calls> tag.`,
    config: {
      model: 'claude-sonnet-4-20250514',
      maxTokens: 500,
    },
    tools: [calculatorTool],
  };
  
  try {
    process.stdout.write('Response: ');
    
    const response = await membrane.stream(request, {
      onChunk: (chunk) => {
        process.stdout.write(chunk);
      },
      onToolCalls: async (calls: ToolCall[], context: ToolContext) => {
        console.log(`\n\n  [Tool] Executing ${calls.length} tool(s) at depth ${context.depth}`);
        const results = await Promise.all(calls.map(executeTool));
        console.log('  [Tool] Results:', results.map(r => r.content).join(', '));
        console.log('\n  Continuing generation...\n');
        return results;
      },
      maxToolDepth: 5,
    });
    
    console.log('\n\nFinal stop reason:', response.stopReason);
    console.log('Total usage:', response.usage);
  } catch (error) {
    console.error('Error:', error);
  }
}

async function testMultiTurn() {
  console.log('\n=== Test 4: Multi-turn Conversation ===\n');
  
  const adapter = new AnthropicAdapter();
  const membrane = new Membrane(adapter);
  
  const request: NormalizedRequest = {
    messages: [
      textMessage('Alice', 'Hi Claude! My name is Alice.'),
      textMessage('Claude', 'Hello Alice! Nice to meet you. How can I help you today?'),
      textMessage('Alice', 'What is my name?'),
    ],
    config: {
      model: 'claude-sonnet-4-20250514',
      maxTokens: 100,
    },
  };
  
  try {
    const response = await membrane.complete(request);
    
    console.log('Response:', response.content);
    console.log('Stop reason:', response.stopReason);
  } catch (error) {
    console.error('Error:', error);
  }
}

// Run tests
async function main() {
  console.log('Membrane Standalone Tests');
  console.log('=========================');
  
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY environment variable not set');
    process.exit(1);
  }
  
  await testBasicCompletion();
  await testStreaming();
  await testToolExecution();
  await testMultiTurn();
  
  console.log('\n=== All tests complete ===\n');
}

main().catch(console.error);
