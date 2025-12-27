/**
 * Test OpenRouter API
 * 
 * Run with: npx tsx test-openrouter.ts
 */

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const BASE_URL = 'https://openrouter.ai/api/v1';

interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string | ContentBlock[];
}

interface ContentBlock {
  type: string;
  [key: string]: any;
}

async function callOpenRouter(
  model: string,
  messages: Message[],
  options: {
    tools?: any[];
    temperature?: number;
    max_tokens?: number;
  } = {}
) {
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://membrane-test.local',
      'X-Title': 'Membrane Test',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.max_tokens ?? 1000,
      tools: options.tools,
    }),
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenRouter error: ${response.status} ${error}`);
  }
  
  return response.json();
}

async function testBasicCompletion() {
  console.log('\n=== Test 1: Basic Completion (Claude via OpenRouter) ===\n');
  
  const response = await callOpenRouter('anthropic/claude-3.5-sonnet', [
    { role: 'user', content: 'What is 2 + 2? Answer in one word.' }
  ]);
  
  console.log('Model:', response.model);
  console.log('Choices:', response.choices?.length);
  console.log('Message:', response.choices?.[0]?.message);
  console.log('Usage:', response.usage);
  console.log('Finish reason:', response.choices?.[0]?.finish_reason);
}

async function testOpenAIModel() {
  console.log('\n=== Test 2: OpenAI Model ===\n');
  
  const response = await callOpenRouter('openai/gpt-4o-mini', [
    { role: 'user', content: 'What is 2 + 2? Answer in one word.' }
  ]);
  
  console.log('Model:', response.model);
  console.log('Message:', response.choices?.[0]?.message);
  console.log('Usage:', response.usage);
}

async function testToolUse() {
  console.log('\n=== Test 3: Tool Use (OpenAI format) ===\n');
  
  const tools = [
    {
      type: 'function',
      function: {
        name: 'calculate',
        description: 'Performs arithmetic calculations',
        parameters: {
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
    },
  ];
  
  const response = await callOpenRouter('openai/gpt-4o-mini', [
    { role: 'user', content: 'What is 123 * 456? Use the calculate tool.' }
  ], { tools });
  
  console.log('Model:', response.model);
  console.log('Finish reason:', response.choices?.[0]?.finish_reason);
  console.log('Message:', JSON.stringify(response.choices?.[0]?.message, null, 2));
  
  // Check for tool calls
  const toolCalls = response.choices?.[0]?.message?.tool_calls;
  if (toolCalls && toolCalls.length > 0) {
    console.log('\nTool calls found:');
    for (const call of toolCalls) {
      console.log('  -', call.function?.name, call.function?.arguments);
    }
    
    // Execute and continue
    const result = eval(JSON.parse(toolCalls[0].function.arguments).expression);
    console.log('\nTool result:', result);
    
    // Continue conversation
    const response2 = await callOpenRouter('openai/gpt-4o-mini', [
      { role: 'user', content: 'What is 123 * 456? Use the calculate tool.' },
      response.choices[0].message,
      { 
        role: 'tool',
        tool_call_id: toolCalls[0].id,
        content: String(result),
      } as any
    ], { tools });
    
    console.log('\nContinuation response:', response2.choices?.[0]?.message?.content);
  }
}

async function testClaudeViaOpenRouter() {
  console.log('\n=== Test 4: Claude with Tools via OpenRouter ===\n');
  
  const tools = [
    {
      type: 'function',
      function: {
        name: 'calculate',
        description: 'Performs arithmetic calculations',
        parameters: {
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
    },
  ];
  
  const response = await callOpenRouter('anthropic/claude-3.5-sonnet', [
    { role: 'user', content: 'What is 99 * 99? Use the calculate tool.' }
  ], { tools });
  
  console.log('Model:', response.model);
  console.log('Finish reason:', response.choices?.[0]?.finish_reason);
  console.log('Message:', JSON.stringify(response.choices?.[0]?.message, null, 2));
  
  const toolCalls = response.choices?.[0]?.message?.tool_calls;
  if (toolCalls && toolCalls.length > 0) {
    console.log('\nTool calls:');
    for (const call of toolCalls) {
      console.log('  -', call.function?.name, call.function?.arguments);
    }
  }
}

async function testStreaming() {
  console.log('\n=== Test 5: Streaming ===\n');
  
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://membrane-test.local',
      'X-Title': 'Membrane Test',
    },
    body: JSON.stringify({
      model: 'openai/gpt-4o-mini',
      messages: [{ role: 'user', content: 'Count from 1 to 5 slowly.' }],
      max_tokens: 200,
      stream: true,
    }),
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenRouter error: ${response.status} ${error}`);
  }
  
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  
  process.stdout.write('Streaming: ');
  
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    
    const chunk = decoder.decode(value);
    const lines = chunk.split('\n').filter(line => line.startsWith('data: '));
    
    for (const line of lines) {
      const data = line.slice(6);
      if (data === '[DONE]') continue;
      
      try {
        const parsed = JSON.parse(data);
        const content = parsed.choices?.[0]?.delta?.content;
        if (content) {
          process.stdout.write(content);
        }
      } catch (e) {
        // Ignore parse errors
      }
    }
  }
  
  console.log('\n');
}

async function main() {
  console.log('OpenRouter Tests');
  console.log('================');
  
  if (!OPENROUTER_API_KEY) {
    console.error('OPENROUTER_API_KEY not set');
    process.exit(1);
  }
  
  try {
    await testBasicCompletion();
    await testOpenAIModel();
    await testToolUse();
    await testClaudeViaOpenRouter();
    await testStreaming();
    
    console.log('\n=== All tests complete ===\n');
  } catch (error) {
    console.error('Error:', error);
  }
}

main();
