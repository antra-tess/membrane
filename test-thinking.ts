/**
 * Test extended thinking and redacted traces
 * 
 * Run with: npx tsx test-thinking.ts
 */

import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

async function testBasicThinking() {
  console.log('\n=== Test 1: Basic Extended Thinking ===\n');
  
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 8000,
    thinking: {
      type: 'enabled',
      budget_tokens: 5000,
    },
    messages: [
      { role: 'user', content: 'What is 15 * 17? Think through it step by step.' }
    ],
  });
  
  console.log('Stop reason:', response.stop_reason);
  console.log('Content blocks:', response.content.length);
  
  for (let i = 0; i < response.content.length; i++) {
    const block = response.content[i];
    console.log(`\nBlock ${i}:`, block.type);
    
    if (block.type === 'thinking') {
      console.log('  Thinking:', block.thinking.slice(0, 200) + '...');
      console.log('  Signature:', block.signature ? `${block.signature.slice(0, 50)}...` : 'none');
    } else if (block.type === 'text') {
      console.log('  Text:', block.text);
    } else if (block.type === 'redacted_thinking') {
      console.log('  REDACTED - data:', (block as any).data?.slice(0, 50) + '...');
    }
  }
  
  console.log('\nUsage:', response.usage);
  
  return response;
}

async function testThinkingMultiTurn() {
  console.log('\n=== Test 2: Multi-turn with Thinking Preservation ===\n');
  
  // First turn
  const response1 = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 8000,
    thinking: {
      type: 'enabled',
      budget_tokens: 5000,
    },
    messages: [
      { role: 'user', content: 'I\'m thinking of a number between 1 and 100. It\'s 42. Remember it.' }
    ],
  });
  
  console.log('Turn 1 - Content blocks:', response1.content.length);
  for (const block of response1.content) {
    console.log('  -', block.type, block.type === 'text' ? `: "${block.text.slice(0, 50)}..."` : '');
  }
  
  // Second turn - echo back the content blocks
  const response2 = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 8000,
    thinking: {
      type: 'enabled',
      budget_tokens: 5000,
    },
    messages: [
      { role: 'user', content: 'I\'m thinking of a number between 1 and 100. It\'s 42. Remember it.' },
      { role: 'assistant', content: response1.content },  // Echo back with thinking
      { role: 'user', content: 'What number was I thinking of?' }
    ],
  });
  
  console.log('\nTurn 2 - Content blocks:', response2.content.length);
  for (const block of response2.content) {
    if (block.type === 'text') {
      console.log('  Text:', block.text);
    } else {
      console.log('  -', block.type);
    }
  }
  
  return response2;
}

async function testThinkingWithTools() {
  console.log('\n=== Test 3: Thinking with Native Tool Use ===\n');
  
  const tools: Anthropic.Tool[] = [
    {
      name: 'calculate',
      description: 'Performs arithmetic calculations',
      input_schema: {
        type: 'object',
        properties: {
          expression: {
            type: 'string',
            description: 'Math expression to evaluate',
          },
        },
        required: ['expression'],
      },
    },
  ];
  
  // First request - should trigger tool use
  const response1 = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 8000,
    thinking: {
      type: 'enabled',
      budget_tokens: 5000,
    },
    tools,
    messages: [
      { role: 'user', content: 'What is 123 * 456? Use the calculate tool.' }
    ],
  });
  
  console.log('Turn 1 - Stop reason:', response1.stop_reason);
  console.log('Content blocks:', response1.content.length);
  
  let toolUseBlock: Anthropic.ToolUseBlock | null = null;
  for (const block of response1.content) {
    console.log('  -', block.type);
    if (block.type === 'tool_use') {
      toolUseBlock = block;
      console.log('    Tool:', block.name, block.input);
    } else if (block.type === 'thinking') {
      console.log('    Thinking:', block.thinking.slice(0, 100) + '...');
    }
  }
  
  if (!toolUseBlock) {
    console.log('No tool use, stopping');
    return;
  }
  
  // Execute tool
  const toolResult = eval((toolUseBlock.input as any).expression);
  console.log('\nTool result:', toolResult);
  
  // Second request - provide tool result, preserve thinking
  const response2 = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 8000,
    thinking: {
      type: 'enabled',
      budget_tokens: 5000,
    },
    tools,
    messages: [
      { role: 'user', content: 'What is 123 * 456? Use the calculate tool.' },
      { role: 'assistant', content: response1.content },  // Include thinking blocks
      { 
        role: 'user', 
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseBlock.id,
            content: String(toolResult),
          }
        ]
      }
    ],
  });
  
  console.log('\nTurn 2 - Stop reason:', response2.stop_reason);
  console.log('Content blocks:', response2.content.length);
  for (const block of response2.content) {
    if (block.type === 'text') {
      console.log('  Text:', block.text);
    } else if (block.type === 'thinking') {
      console.log('  Thinking:', block.thinking.slice(0, 100) + '...');
    } else {
      console.log('  -', block.type);
    }
  }
  
  return response2;
}

async function testRedactedThinking() {
  console.log('\n=== Test 4: Trying to Trigger Redacted Thinking ===\n');
  
  // Redacted thinking typically happens with sensitive content
  // Let's try a benign request and see what we get
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 8000,
    thinking: {
      type: 'enabled',
      budget_tokens: 5000,
    },
    messages: [
      { role: 'user', content: 'Explain briefly why the sky is blue.' }
    ],
  });
  
  console.log('Content blocks:');
  for (const block of response.content) {
    console.log('  Type:', block.type);
    if (block.type === 'redacted_thinking') {
      console.log('  GOT REDACTED THINKING!');
      console.log('  Block:', JSON.stringify(block).slice(0, 200));
    }
  }
  
  // Check if any thinking was redacted
  const hasRedacted = response.content.some(b => b.type === 'redacted_thinking');
  console.log('\nHas redacted thinking:', hasRedacted);
}

async function main() {
  console.log('Extended Thinking Tests');
  console.log('=======================');
  
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY not set');
    process.exit(1);
  }
  
  try {
    await testBasicThinking();
    await testThinkingMultiTurn();
    await testThinkingWithTools();
    await testRedactedThinking();
    
    console.log('\n=== All tests complete ===\n');
  } catch (error) {
    console.error('Error:', error);
  }
}

main();
