/**
 * OpenAI's usage reports reasoning tokens inside the completion count:
 * `completion_tokens_details.reasoning_tokens` on Chat Completions (and the
 * OpenAI-shaped servers OpenRouter and openai-compatible front),
 * `output_tokens_details.reasoning_tokens` on the Responses API. `thinkingTokens`
 * is the field for a count already inside `outputTokens`, and until now only the
 * Gemini adapter set it (#277).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIAdapter } from '../../src/providers/openai.js';
import { OpenAIResponsesAPIAdapter } from '../../src/providers/openai-responses-api.js';
import { OpenAICompatibleAdapter } from '../../src/providers/openai-compatible.js';
import { OpenRouterAdapter } from '../../src/providers/openrouter.js';
import { stubFetchWithSseLines } from '../helpers/sse-fixtures.js';

afterEach(() => { vi.unstubAllGlobals(); });

const chatUsage = { prompt_tokens: 100, completion_tokens: 60, total_tokens: 160, completion_tokens_details: { reasoning_tokens: 40 } };
function stubChat(usage: unknown, model = 'gpt-5.6-sol') {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
    id: 'chatcmpl_r', object: 'chat.completion', model,
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
}
const chatRequest = { model: 'gpt-5.6-sol', maxTokens: 10, messages: [{ role: 'user', content: 'hi' }] } as any;

describe('reasoning tokens reach thinkingTokens, inside outputTokens as the API counts them', () => {
  it('OpenAIAdapter, whole response and stream', async () => {
    stubChat(chatUsage);
    const whole = await new OpenAIAdapter({ apiKey: 'sk-test' }).complete(chatRequest);
    expect(whole.usage).toEqual({ inputTokens: 100, outputTokens: 60, thinkingTokens: 40 });
    stubFetchWithSseLines([
      '{"choices":[{"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}',
      '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
      JSON.stringify({ choices: [], usage: chatUsage }),
      '[DONE]',
    ]);
    const streamed = await new OpenAIAdapter({ apiKey: 'sk-test' }).stream(chatRequest, { onChunk: () => {} } as any);
    expect(streamed.usage).toEqual({ inputTokens: 100, outputTokens: 60, thinkingTokens: 40 });
  });

  it('OpenAICompatibleAdapter, whole response and stream', async () => {
    stubChat(chatUsage, 'zz-model');
    const adapter = () => new OpenAICompatibleAdapter({ baseURL: 'http://localhost:9/v1', apiKey: 'zz-key' });
    const whole = await adapter().complete({ ...chatRequest, model: 'zz-model' });
    expect(whole.usage).toEqual({ inputTokens: 100, outputTokens: 60, thinkingTokens: 40 });
    stubFetchWithSseLines([
      '{"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}',
      JSON.stringify({ choices: [], usage: chatUsage }),
      '[DONE]',
    ]);
    const streamed = await adapter().stream({ ...chatRequest, model: 'zz-model' }, { onChunk: () => {} } as any);
    expect(streamed.usage).toEqual({ inputTokens: 100, outputTokens: 60, thinkingTokens: 40 });
  });

  it('OpenRouterAdapter, whole response and stream, beside the cache fields it already reads', async () => {
    const usage = { ...chatUsage, prompt_tokens_details: { cached_tokens: 30 } };
    const request = { ...chatRequest, model: 'openai/gpt-5.6-sol' };
    stubChat(usage, 'openai/gpt-5.6-sol');
    const whole = await new OpenRouterAdapter({ apiKey: 'or-test' }).complete(request);
    expect(whole.usage).toMatchObject({ inputTokens: 100, outputTokens: 60, thinkingTokens: 40, cacheReadTokens: 30 });
    stubFetchWithSseLines([
      '{"choices":[{"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}',
      '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
      JSON.stringify({ choices: [], usage }),
      '[DONE]',
    ]);
    const streamed = await new OpenRouterAdapter({ apiKey: 'or-test' }).stream(request, { onChunk: () => {} } as any);
    expect(streamed.usage).toMatchObject({ inputTokens: 100, outputTokens: 60, thinkingTokens: 40, cacheReadTokens: 30 });
  });

  it('OpenAIResponsesAPIAdapter, whole response and stream', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 'resp_r', model: 'gpt-5.6-sol', status: 'completed',
      output: [{ type: 'message', id: 'msg_r', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok' }] }],
      usage: { input_tokens: 100, output_tokens: 60, total_tokens: 160, output_tokens_details: { reasoning_tokens: 40 } },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    const whole = await new OpenAIResponsesAPIAdapter({ apiKey: 'sk-test' }).complete({ model: 'gpt-5.6-sol', messages: [], maxTokens: 10 });
    expect(whole.usage).toEqual({ inputTokens: 100, outputTokens: 60, thinkingTokens: 40 });
    stubFetchWithSseLines([
      '{"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_r","role":"assistant","status":"completed","content":[{"type":"output_text","text":"ok"}]}}',
      '{"type":"response.completed","response":{"id":"resp_r","model":"gpt-5.6-sol","status":"completed","output":[],"usage":{"input_tokens":100,"output_tokens":60,"total_tokens":160,"output_tokens_details":{"reasoning_tokens":40}}}}',
    ]);
    const streamed = await new OpenAIResponsesAPIAdapter({ apiKey: 'sk-test' }).stream({ model: 'gpt-5.6-sol', messages: [], maxTokens: 10 }, { onChunk: () => {} } as any);
    expect(streamed.usage).toEqual({ inputTokens: 100, outputTokens: 60, thinkingTokens: 40 });
  });

  it('stays absent when the API reports no reasoning count, and a reported zero is zero', async () => {
    stubChat({ prompt_tokens: 100, completion_tokens: 60, total_tokens: 160 });
    const none = await new OpenAIAdapter({ apiKey: 'sk-test' }).complete(chatRequest);
    expect('thinkingTokens' in none.usage).toBe(false);
    stubChat({ prompt_tokens: 100, completion_tokens: 60, total_tokens: 160, completion_tokens_details: { reasoning_tokens: 0 } });
    const zero = await new OpenAIAdapter({ apiKey: 'sk-test' }).complete(chatRequest);
    expect(zero.usage.thinkingTokens).toBe(0);
  });
});
