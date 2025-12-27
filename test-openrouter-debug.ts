/**
 * Debug OpenRouter streaming tool calls
 */

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const BASE_URL = 'https://openrouter.ai/api/v1';

async function debugStreamingToolCalls() {
  console.log('\n=== Debug OpenRouter Streaming Tool Calls ===\n');
  
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
  
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://membrane-test.local',
      'X-Title': 'Membrane Debug',
    },
    body: JSON.stringify({
      model: 'openai/gpt-4o-mini',
      messages: [{ role: 'user', content: 'What is 42 * 42? Use the calculate tool.' }],
      max_tokens: 500,
      tools,
      stream: true,
    }),
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenRouter error: ${response.status} ${error}`);
  }
  
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');
  
  const decoder = new TextDecoder();
  
  interface ToolCall {
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }
  
  let toolCalls: ToolCall[] = [];
  let accumulated = '';
  let finishReason = '';
  
  console.log('Streaming chunks:');
  
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    
    const chunk = decoder.decode(value, { stream: true });
    const lines = chunk.split('\n').filter(line => line.startsWith('data: '));
    
    for (const line of lines) {
      const data = line.slice(6);
      if (data === '[DONE]') {
        console.log('\n[DONE]');
        continue;
      }
      
      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta;
        
        console.log('\nDelta:', JSON.stringify(delta, null, 2));
        
        if (delta?.content) {
          accumulated += delta.content;
        }
        
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const index = tc.index ?? 0;
            if (!toolCalls[index]) {
              toolCalls[index] = {
                id: '',
                type: 'function',
                function: { name: '', arguments: '' },
              };
            }
            if (tc.id) {
              toolCalls[index].id = tc.id;
              console.log(`  Set id[${index}] = ${tc.id}`);
            }
            if (tc.function?.name) {
              toolCalls[index].function.name = tc.function.name;
              console.log(`  Set name[${index}] = ${tc.function.name}`);
            }
            if (tc.function?.arguments) {
              toolCalls[index].function.arguments += tc.function.arguments;
              console.log(`  Append args[${index}] += "${tc.function.arguments}" -> "${toolCalls[index].function.arguments}"`);
            }
          }
        }
        
        if (parsed.choices?.[0]?.finish_reason) {
          finishReason = parsed.choices[0].finish_reason;
        }
      } catch (e) {
        console.log('Parse error:', e);
      }
    }
  }
  
  console.log('\n\n=== Final Results ===');
  console.log('Accumulated text:', accumulated);
  console.log('Finish reason:', finishReason);
  console.log('Tool calls:', JSON.stringify(toolCalls, null, 2));
  
  if (toolCalls.length > 0) {
    console.log('\nParsed tool input:');
    for (const tc of toolCalls) {
      try {
        const input = JSON.parse(tc.function.arguments || '{}');
        console.log(`  ${tc.function.name}:`, input);
      } catch (e) {
        console.log(`  ${tc.function.name}: PARSE ERROR - "${tc.function.arguments}"`);
      }
    }
  }
}

async function main() {
  if (!OPENROUTER_API_KEY) {
    console.error('OPENROUTER_API_KEY not set');
    process.exit(1);
  }
  
  await debugStreamingToolCalls();
}

main().catch(console.error);
