/**
 * The Responses API defaults an omitted function-tool `strict` to TRUE (Chat
 * Completions defaults it to false). In strict mode every property is
 * required, so models fill optional arguments with zero values ("", 0) that
 * handlers then treat as real input: e.g. `ref: ""` next to `index`/`count`,
 * or character-paging zeros next to line-paging arguments. Membrane and Chat
 * Completions schemas are not written for strict mode, so the adapter sends
 * them with `strict: false` unless the tool asks for strict itself.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIResponsesAPIAdapter } from '../../src/providers/openai-responses-api.js';

afterEach(() => vi.unstubAllGlobals());

async function wireTools(tools: unknown[]) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({
      id: 'resp_1', model: 'gpt-5.6', status: 'completed',
      output: [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'ok' }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const adapter = new OpenAIResponsesAPIAdapter({ apiKey: 'sk-test' });
  await adapter.complete({ model: 'gpt-5.6', messages: [], maxTokens: 64, tools } as any);
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
  return JSON.parse(String(init.body)).tools as Array<Record<string, unknown>>;
}

const schema = {
  type: 'object',
  properties: { path: { type: 'string' }, ref: { type: 'string' } },
  required: ['path'],
};

describe('OpenAIResponsesAPIAdapter tool strictness', () => {
  it('sends membrane-format tools with strict: false', async () => {
    const [tool] = await wireTools([{ name: 'save_recent_image', description: 'd', inputSchema: schema }]);
    expect(tool).toMatchObject({ type: 'function', name: 'save_recent_image', parameters: schema, strict: false });
  });

  it('sends Chat Completions-format tools with strict: false (their own default)', async () => {
    const [tool] = await wireTools([{ type: 'function', function: { name: 'read', parameters: schema } }]);
    expect(tool).toMatchObject({ type: 'function', name: 'read', strict: false });
  });

  it('treats a present-but-undefined strict as unset, in either format', async () => {
    const tools = await wireTools([
      { name: 'a', description: 'd', inputSchema: schema, strict: undefined },
      { type: 'function', function: { name: 'b', parameters: schema, strict: undefined } },
    ]);
    expect(tools.map((t) => t.strict)).toEqual([false, false]);
  });

  it('keeps an explicit strict: true in either format', async () => {
    const tools = await wireTools([
      { name: 'a', description: 'd', inputSchema: schema, strict: true },
      { type: 'function', function: { name: 'b', parameters: schema, strict: true } },
    ]);
    expect(tools.map((t) => t.strict)).toEqual([true, true]);
  });

  it('passes native Responses function tools through unchanged', async () => {
    const native = { type: 'function', name: 'native', parameters: schema };
    const [tool] = await wireTools([native]);
    expect(tool).toEqual(native);
  });
});
