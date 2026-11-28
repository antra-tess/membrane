/** antra-tess/membrane#95 on the OpenAI and OpenAI-compatible adapters: one malformed tool_calls entry failed the whole response. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleAdapter, fromOpenAIMessage } from '../../src/providers/openai-compatible.js';
import { OpenAIAdapter, fromOpenAIContent } from '../../src/providers/openai.js';
import { sseResponse } from '../helpers/sse-fixtures.js';

const usage = { prompt_tokens: 7, completion_tokens: 3 };
const good = { id: 'call_1', type: 'function', function: { name: 'noop', arguments: '{"a":1}' } };
const malformed = [{}, null, 0, 'x', { function: null }, { function: {} }, { function: { name: 5 } }, { id: 'c0', function: { name: '' } }];
const chatRequest = { model: 'test-model', maxTokens: 64, messages: [{ role: 'user', content: 'hello' }] } as any;

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const adapters = [
  ['OpenAICompatibleAdapter', () => new OpenAICompatibleAdapter({ baseURL: 'http://localhost:9/v1', apiKey: 'test' })],
  ['OpenAIAdapter', () => new OpenAIAdapter({ apiKey: 'test' })],
] as const;

describe.each(adapters)('%s malformed tool_calls entries', (_name, adapter) => {
  it('complete: tool_calls [{}] keeps the text and usage, and the turn does not claim tool_use', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'kept', tool_calls: [{}] }, finish_reason: 'tool_calls' }],
      usage,
    }))));
    const response = await adapter().complete(chatRequest);
    expect(response.content).toEqual([{ type: 'text', text: 'kept' }]);
    expect(response.usage).toMatchObject({ inputTokens: 7, outputTokens: 3 });
    expect(response.stopReason).toBe('end_turn');
    expect(response.providerStopReason).toBe('tool_calls');
  });

  it('complete: a well-formed call beside malformed ones is kept and stops with tool_use', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: null, tool_calls: [...malformed, good] }, finish_reason: 'tool_calls' }],
      usage,
    }))));
    const response = await adapter().complete(chatRequest);
    expect(response.content).toEqual([{ type: 'tool_use', id: 'call_1', name: 'noop', input: { a: 1 } }]);
    expect(response.stopReason).toBe('tool_use');
  });

  it('stream: a call with an id but no name is skipped and the turn ends without tool_use', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      JSON.stringify({
        choices: [{ delta: { content: 'calling', tool_calls: [{ id: 'c1', function: { arguments: '{}' } }] }, finish_reason: 'tool_calls' }],
        usage,
      }),
      '[DONE]',
    ])));
    const response = await adapter().stream(chatRequest, { onChunk: () => {} } as any);
    expect(response.content).toEqual([{ type: 'text', text: 'calling' }]);
    expect(response.stopReason).toBe('end_turn');
  });
});

describe.each([
  ['fromOpenAIMessage', fromOpenAIMessage],
  ['fromOpenAIContent', fromOpenAIContent],
] as const)('%s malformed tool_calls entries', (_name, convert) => {
  it('skips each malformed entry, keeps the well-formed call, and warns once without provider content', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const blocks = convert({ role: 'assistant', content: 'kept', tool_calls: [...malformed, good] } as any);
    expect(blocks).toEqual([
      { type: 'text', text: 'kept' },
      { type: 'tool_use', id: 'call_1', name: 'noop', input: { a: 1 } },
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('skipped tool_calls entry');
  });
});
