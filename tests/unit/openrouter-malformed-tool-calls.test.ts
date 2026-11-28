import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenRouterAdapter, fromOpenRouterMessage } from '../../src/providers/openrouter.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { Membrane } from '../../src/membrane.js';
import { sseResponse } from '../helpers/sse-fixtures.js';
import type { NormalizedRequest } from '../../src/types/index.js';

// antra-tess/membrane#95: one malformed tool_calls entry failed the whole response.
const usage = { prompt_tokens: 7, completion_tokens: 3 };
const good = { id: 'call_1', type: 'function', function: { name: 'noop', arguments: '{"a":1}' } };
const malformed = [{}, null, 0, 'x', { function: null }, { function: {} }, { function: { name: 5 } }];

function request(): NormalizedRequest {
  return {
    messages: [{ participant: 'User', content: [{ type: 'text', text: 'hello' }] }],
    system: [], promptCaching: false, toolMode: 'native',
    tools: [{ name: 'noop', description: 'noop', inputSchema: { type: 'object' } }],
    config: { model: 'test-model', maxTokens: 128 },
  };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('OpenRouter malformed tool_calls entries', () => {
  it('skips each malformed entry, keeps the well-formed call, and warns once without provider content', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const blocks = fromOpenRouterMessage({ role: 'assistant', content: 'kept', tool_calls: [...malformed, good] } as any);
    expect(blocks).toEqual([
      { type: 'text', text: 'kept' },
      { type: 'tool_use', id: 'call_1', name: 'noop', input: { a: 1 } },
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('skipped tool_calls entry');
  });

  it('complete: tool_calls [{}] keeps the text and usage instead of failing the response', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'kept', tool_calls: [{}] }, finish_reason: 'stop' }],
      usage,
    }))));
    const membrane = new Membrane(new OpenRouterAdapter({ apiKey: 'test' }), { formatter: new NativeFormatter() });
    const result = await membrane.complete(request());
    expect(result.content).toEqual([{ type: 'text', text: 'kept' }]);
    expect(result.usage).toMatchObject({ inputTokens: 7, outputTokens: 3 });
  });

  it('stream: a null tool_calls entry does not swallow finish_reason and usage of its frame', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      JSON.stringify({ choices: [{ delta: { content: 'kept', tool_calls: [null] }, finish_reason: 'stop' }], usage }),
    ])));
    const chunks: string[] = [];
    const response = await new OpenRouterAdapter({ apiKey: 'test' }).stream(
      { messages: [{ role: 'user', content: 'hello' }], model: 'test-model', maxTokens: 128 } as any,
      { onChunk: (chunk) => chunks.push(chunk) },
    );
    expect(chunks).toEqual(['kept']);
    expect(response.content).toEqual([{ type: 'text', text: 'kept' }]);
    expect(response.stopReason).toBe('end_turn');
    expect(response.usage).toMatchObject({ inputTokens: 7, outputTokens: 3 });
  });

  it('complete: finish_reason tool_calls with every call skipped does not claim tool_use', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'calling', tool_calls: [{}] }, finish_reason: 'tool_calls' }],
      usage,
    }))));
    const response = await new OpenRouterAdapter({ apiKey: 'test' }).complete(
      { messages: [{ role: 'user', content: 'hello' }], model: 'test-model', maxTokens: 128 } as any,
    );
    expect(response.content).toEqual([{ type: 'text', text: 'calling' }]);
    expect(response.stopReason).toBe('end_turn');
    expect(response.providerStopReason).toBe('tool_calls');
  });

  it('complete: a well-formed call still stops with tool_use', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: null, tool_calls: [good] }, finish_reason: 'tool_calls' }],
      usage,
    }))));
    const response = await new OpenRouterAdapter({ apiKey: 'test' }).complete(
      { messages: [{ role: 'user', content: 'hello' }], model: 'test-model', maxTokens: 128 } as any,
    );
    expect(response.content).toEqual([{ type: 'tool_use', id: 'call_1', name: 'noop', input: { a: 1 } }]);
    expect(response.stopReason).toBe('tool_use');
  });

  it('an empty function.name is malformed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const blocks = fromOpenRouterMessage({
      role: 'assistant', content: 'kept', tool_calls: [{ id: 'c1', type: 'function', function: { name: '', arguments: '{}' } }],
    } as any);
    expect(blocks).toEqual([{ type: 'text', text: 'kept' }]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('stream: a call with an id but no name is skipped and the turn ends without tool_use', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      JSON.stringify({
        choices: [{ delta: { content: 'calling', tool_calls: [{ id: 'c1', function: { arguments: '{}' } }] }, finish_reason: 'tool_calls' }],
        usage,
      }),
    ])));
    const response = await new OpenRouterAdapter({ apiKey: 'test' }).stream(
      { messages: [{ role: 'user', content: 'hello' }], model: 'test-model', maxTokens: 128 } as any,
      { onChunk: () => {} },
    );
    expect(response.content).toEqual([{ type: 'text', text: 'calling' }]);
    expect(response.stopReason).toBe('end_turn');
  });
});
