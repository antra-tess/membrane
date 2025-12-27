/**
 * Test both XML and native tool modes
 * 
 * Run with: npx tsx test-tool-modes.ts
 */

import { 
  Membrane, 
  AnthropicAdapter, 
  OpenRouterAdapter,
  textMessage 
} from './src/index.js';
import type { 
  NormalizedRequest, 
  ToolCall, 
  ToolResult, 
  ToolContext,
  ToolDefinition 
} from './src/index.js';

// Tool definition (same for both modes)
const calculatorTool: ToolDefinition = {
  name: 'calculate',
  description: 'Performs arithmetic calculations',
  inputSchema: {
    type: 'object',
    properties: {
      expression: {
        type: 'string',
        description: 'Math expression to evaluate',
      },
    },
    required: ['expression'],
  },
};

// Tool executor (same for both modes)
async function executeTool(call: ToolCall): Promise<ToolResult> {
  console.log(`    [Tool] ${call.name}(${JSON.stringify(call.input)})`);
  
  if (call.name === 'calculate') {
    try {
      const result = eval((call.input as any).expression);
      return { toolUseId: call.id, content: `Result: ${result}` };
    } catch (e) {
      return { toolUseId: call.id, content: `Error: ${e}`, isError: true };
    }
  }
  
  return { toolUseId: call.id, content: 'Unknown tool', isError: true };
}

async function testXmlToolMode() {
  console.log('\n=== Test 1: XML Tool Mode (Anthropic Direct) ===\n');
  
  const adapter = new AnthropicAdapter();
  const membrane = new Membrane(adapter);
  
  const request: NormalizedRequest = {
    messages: [
      textMessage('User', 'What is 25 * 25? Use the calculate tool.'),
    ],
    system: 'You have access to tools. Use them when needed.',
    config: {
      model: 'claude-sonnet-4-20250514',
      maxTokens: 500,
    },
    tools: [calculatorTool],
    toolMode: 'xml',  // Explicit XML mode
  };
  
  console.log('Using toolMode: xml');
  process.stdout.write('Response: ');
  
  try {
    const response = await membrane.stream(request, {
      onChunk: (chunk) => process.stdout.write(chunk),
      onToolCalls: async (calls, context) => {
        console.log(`\n  [XML Mode] Tool calls at depth ${context.depth}:`);
        const results = await Promise.all(calls.map(executeTool));
        console.log(`  [XML Mode] Results:`, results.map(r => r.content).join(', '));
        return results;
      },
      maxToolDepth: 3,
    });
    
    console.log('\n\nStop reason:', response.stopReason);
    console.log('Usage:', response.usage);
  } catch (error) {
    console.error('\nError:', error);
  }
}

async function testNativeToolMode() {
  console.log('\n=== Test 2: Native Tool Mode (Anthropic Direct) ===\n');
  
  const adapter = new AnthropicAdapter();
  const membrane = new Membrane(adapter);
  
  const request: NormalizedRequest = {
    messages: [
      textMessage('User', 'What is 33 * 33? Use the calculate tool.'),
    ],
    system: 'You have access to tools. Use them when needed.',
    config: {
      model: 'claude-sonnet-4-20250514',
      maxTokens: 500,
    },
    tools: [calculatorTool],
    toolMode: 'native',  // Explicit native mode
  };
  
  console.log('Using toolMode: native');
  process.stdout.write('Response: ');
  
  try {
    const response = await membrane.stream(request, {
      onChunk: (chunk) => process.stdout.write(chunk),
      onToolCalls: async (calls, context) => {
        console.log(`\n  [Native Mode] Tool calls at depth ${context.depth}:`);
        const results = await Promise.all(calls.map(executeTool));
        console.log(`  [Native Mode] Results:`, results.map(r => r.content).join(', '));
        return results;
      },
      maxToolDepth: 3,
    });
    
    console.log('\n\nStop reason:', response.stopReason);
    console.log('Usage:', response.usage);
    console.log('Content blocks:', response.content.map(b => b.type).join(', '));
  } catch (error) {
    console.error('\nError:', error);
  }
}

async function testOpenRouterTools() {
  console.log('\n=== Test 3: OpenRouter Tool Mode (Auto = Native) ===\n');
  
  const adapter = new OpenRouterAdapter();
  const membrane = new Membrane(adapter);
  
  const request: NormalizedRequest = {
    messages: [
      textMessage('User', 'What is 42 * 42? Use the calculate tool.'),
    ],
    config: {
      model: 'openai/gpt-4o-mini',
      maxTokens: 500,
    },
    tools: [calculatorTool],
    // toolMode: 'auto' (default) - should auto-select native for OpenRouter
  };
  
  console.log('Using toolMode: auto (should select native for OpenRouter)');
  process.stdout.write('Response: ');
  
  try {
    const response = await membrane.stream(request, {
      onChunk: (chunk) => process.stdout.write(chunk),
      onToolCalls: async (calls, context) => {
        console.log(`\n  [OpenRouter] Tool calls at depth ${context.depth}:`);
        const results = await Promise.all(calls.map(executeTool));
        console.log(`  [OpenRouter] Results:`, results.map(r => r.content).join(', '));
        return results;
      },
      maxToolDepth: 3,
    });
    
    console.log('\n\nStop reason:', response.stopReason);
    console.log('Usage:', response.usage);
  } catch (error) {
    console.error('\nError:', error);
  }
}

async function testTransparentInterface() {
  console.log('\n=== Test 4: Transparent Interface (Same Code, Different Backends) ===\n');
  
  // Same request for all backends
  const makeRequest = (model: string): NormalizedRequest => ({
    messages: [
      textMessage('User', 'What is 7 * 8? Use the calculate tool.'),
    ],
    config: {
      model,
      maxTokens: 300,
    },
    tools: [calculatorTool],
    // toolMode: 'auto' - let membrane decide
  });
  
  // Same callback for all backends
  const toolHandler = async (calls: ToolCall[], context: ToolContext): Promise<ToolResult[]> => {
    console.log(`    Tool calls: ${calls.map(c => c.name).join(', ')}`);
    return Promise.all(calls.map(executeTool));
  };
  
  // Test with Anthropic (XML)
  console.log('  Anthropic (XML mode):');
  const anthropicAdapter = new AnthropicAdapter();
  const anthropicMembrane = new Membrane(anthropicAdapter);
  
  try {
    const response1 = await anthropicMembrane.stream(
      { ...makeRequest('claude-sonnet-4-20250514'), toolMode: 'xml' },
      { onToolCalls: toolHandler }
    );
    console.log(`    Result: ${response1.content.find(b => b.type === 'text')?.text?.slice(0, 50) ?? 'N/A'}...`);
  } catch (e) {
    console.log(`    Error: ${e}`);
  }
  
  // Test with Anthropic (Native)
  console.log('\n  Anthropic (Native mode):');
  try {
    const response2 = await anthropicMembrane.stream(
      { ...makeRequest('claude-sonnet-4-20250514'), toolMode: 'native' },
      { onToolCalls: toolHandler }
    );
    console.log(`    Result: ${response2.content.find(b => b.type === 'text')?.text?.slice(0, 50) ?? 'N/A'}...`);
  } catch (e) {
    console.log(`    Error: ${e}`);
  }
  
  // Test with OpenRouter
  console.log('\n  OpenRouter (Auto = Native):');
  const openRouterAdapter = new OpenRouterAdapter();
  const openRouterMembrane = new Membrane(openRouterAdapter);
  
  try {
    const response3 = await openRouterMembrane.stream(
      makeRequest('openai/gpt-4o-mini'),
      { onToolCalls: toolHandler }
    );
    console.log(`    Result: ${response3.content.find(b => b.type === 'text')?.text?.slice(0, 50) ?? 'N/A'}...`);
  } catch (e) {
    console.log(`    Error: ${e}`);
  }
}

async function main() {
  console.log('Tool Mode Tests');
  console.log('===============');
  
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY not set');
    process.exit(1);
  }
  
  if (!process.env.OPENROUTER_API_KEY) {
    console.error('OPENROUTER_API_KEY not set');
    process.exit(1);
  }
  
  await testXmlToolMode();
  await testNativeToolMode();
  await testOpenRouterTools();
  await testTransparentInterface();
  
  console.log('\n=== All tests complete ===\n');
}

main().catch(console.error);
