/**
 * `openai-compatible` must capture a reasoning trace delivered as
 * `reasoning_content`, not only as `reasoning`.
 *
 * The adapter only read `message.reasoning` / `delta.reasoning` (the OpenRouter
 * spelling). Endpoints that follow the DeepSeek convention — Xiaomi's official
 * MiMo API (https://api.xiaomimimo.com/v1) is one, in both the non-streamed
 * message and every streamed delta — put the trace in `reasoning_content`, so
 * it was silently dropped: no thinking block, nothing persisted, nothing
 * re-sent on the next turn. `reasoning` keeps precedence when a backend sends
 * both, so OpenRouter-style responses are unchanged.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { OpenAICompatibleAdapter, fromOpenAIMessage } from '../../src/providers/openai-compatible.js';
import { stubFetchWithSseLines, capturedRequestBody } from '../helpers/sse-fixtures.js';

afterEach(() => vi.unstubAllGlobals());

const chatRequest = { model: 'zz-model-1', maxTokens: 64, messages: [{ role: 'user', content: 'zz prompt' }] };
const adapter = () => new OpenAICompatibleAdapter({ baseURL: 'http://localhost:9/v1', apiKey: 'zz-key' });

function stubFetchWithJson(body: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const completion = (message: Record<string, unknown>) => ({
  id: 'zz-id',
  model: 'zz-model-1',
  choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
});

const thinkingOf = (content: any[]) => content.filter((b) => b.type === 'thinking').map((b) => b.thinking);

describe('OpenAICompatibleAdapter reasoning_content (non-streamed)', () => {
  it('captures a trace sent only as reasoning_content into a thinking block', async () => {
    stubFetchWithJson(completion({ content: 'zz answer', reasoning_content: 'zz trace via reasoning_content' }));
    const res: any = await adapter().complete(chatRequest as any);

    expect(res.content[0]).toEqual({ type: 'thinking', thinking: 'zz trace via reasoning_content' });
    expect(res.content[1]).toEqual({ type: 'text', text: 'zz answer' });
  });

  it('prefers reasoning over reasoning_content when a backend sends both', async () => {
    stubFetchWithJson(completion({ content: 'zz answer', reasoning: 'zz primary', reasoning_content: 'zz alias' }));
    const res: any = await adapter().complete(chatRequest as any);

    expect(thinkingOf(res.content)).toEqual(['zz primary']);
  });

  it('falls back to reasoning_content when reasoning is whitespace-only', async () => {
    stubFetchWithJson(completion({ content: 'zz answer', reasoning: ' \n ', reasoning_content: 'zz real trace' }));
    const res: any = await adapter().complete(chatRequest as any);

    expect(thinkingOf(res.content)).toEqual(['zz real trace']);
  });

  it('keeps tool calls alongside a reasoning_content trace', async () => {
    stubFetchWithJson(completion({
      content: '',
      reasoning_content: 'zz need the tool',
      tool_calls: [{ id: 'call_zz', type: 'function', function: { name: 'zz_tool', arguments: '{"a":1}' } }],
    }));
    const res: any = await adapter().complete(chatRequest as any);

    expect(thinkingOf(res.content)).toEqual(['zz need the tool']);
    expect(res.content.find((b: any) => b.type === 'tool_use')).toMatchObject({ id: 'call_zz', name: 'zz_tool', input: { a: 1 } });
  });
});

describe('OpenAICompatibleAdapter reasoning_content (streamed)', () => {
  it('accumulates reasoning_content deltas into a thinking block', async () => {
    const chunks: string[] = [];
    stubFetchWithSseLines([
      '{"choices":[{"delta":{"role":"assistant","reasoning_content":"zz step one, "}}]}',
      '{"choices":[{"delta":{"reasoning_content":"zz step two"}}]}',
      '{"choices":[{"delta":{"content":"zz answer"},"finish_reason":"stop"}]}',
      '[DONE]',
    ]);
    const res: any = await adapter().stream(chatRequest as any, { onChunk: (c: string) => chunks.push(c) } as any);

    expect(res.content[0]).toEqual({ type: 'thinking', thinking: 'zz step one, zz step two' });
    expect(res.content[1]).toEqual({ type: 'text', text: 'zz answer' });
    // The trace never leaks into the visible text channel.
    expect(chunks.join('')).toBe('zz answer');
  });

  it('keeps whitespace-only deltas that are part of the trace', async () => {
    // A streamed trace is split at token boundaries: a lone ' ' or '\n' delta is
    // real content. Trimming per delta would glue the words together.
    stubFetchWithSseLines([
      '{"choices":[{"delta":{"reasoning_content":"zz step one,"}}]}',
      '{"choices":[{"delta":{"reasoning_content":" "}}]}',
      '{"choices":[{"delta":{"reasoning_content":"two"}}]}',
      '{"choices":[{"delta":{"reasoning":"\\n"}}]}',
      '{"choices":[{"delta":{"reasoning":"three"}}]}',
      '{"choices":[{"delta":{"content":"zz answer"},"finish_reason":"stop"}]}',
      '[DONE]',
    ]);
    const res: any = await adapter().stream(chatRequest as any, { onChunk: () => {} } as any);

    expect(thinkingOf(res.content)).toEqual(['zz step one, two\nthree']);
  });

  it('does not double-count a delta that carries both spellings', async () => {
    stubFetchWithSseLines([
      '{"choices":[{"delta":{"reasoning":"zz once","reasoning_content":"zz once"}}]}',
      '{"choices":[{"delta":{"content":"zz answer"},"finish_reason":"stop"}]}',
      '[DONE]',
    ]);
    const res: any = await adapter().stream(chatRequest as any, { onChunk: () => {} } as any);

    expect(thinkingOf(res.content)).toEqual(['zz once']);
  });
});

describe('reasoning_content round trip', () => {
  it('re-sends a captured trace on the prior assistant turn (as `reasoning`, unchanged)', async () => {
    stubFetchWithJson(completion({ content: 'zz first answer', reasoning_content: 'zz first trace' }));
    const first: any = await adapter().complete(chatRequest as any);

    const fetchMock = stubFetchWithJson(completion({ content: 'zz second answer' }));
    await adapter().complete({
      ...chatRequest,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'zz prompt' }] },
        { role: 'assistant', content: first.content },
        { role: 'user', content: [{ type: 'text', text: 'zz follow-up' }] },
      ],
    } as any);

    const sent = capturedRequestBody(fetchMock).messages as any[];
    expect(sent[1]).toMatchObject({ role: 'assistant', content: 'zz first answer', reasoning: 'zz first trace' });
  });

  it('fromOpenAIMessage accepts reasoning_content too', () => {
    const blocks = fromOpenAIMessage({ role: 'assistant', content: 'zz answer', reasoning_content: 'zz trace' } as any);
    expect(blocks[0]).toEqual({ type: 'thinking', thinking: 'zz trace' });
  });
});
