import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenRouterAdapter, fromOpenRouterMessage } from '../../src/providers/openrouter.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { AnthropicXmlFormatter } from '../../src/formatters/anthropic-xml.js';
import { Membrane } from '../../src/membrane.js';
import { computeCacheWireReceipt } from '../../src/cache-wire-receipt.js';
import { sseResponse } from '../helpers/sse-fixtures.js';
import type { NormalizedRequest } from '../../src/types/index.js';

const text = (value: string) => ({ type: 'text' as const, text: value });
const usage = { prompt_tokens: 7, completion_tokens: 3 };
const malformedText = [
  { type: 'text' }, { type: 'text', text: null }, { type: 'text', text: 0 },
  { type: 'text', text: {} }, text(''), text('kept'),
];
function response(content: unknown) {
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage }));
}
function request(): NormalizedRequest {
  return {
    messages: [{ participant: 'User', content: [text('hello')] }],
    system: [], promptCaching: false, toolMode: 'native',
    tools: [{ name: 'noop', description: 'noop', inputSchema: { type: 'object' } }],
    config: { model: 'test-model', maxTokens: 128 },
  };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('OpenRouter complete-response text validation', () => {
  it('omits non-string text parts from exported conversion while preserving string parts', () => {
    expect(fromOpenRouterMessage({ role: 'assistant', content: malformedText } as any)).toEqual([text(''), text('kept')]);
  });

  it('preserves text and usage through complete without synthesizing undefined/null text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(malformedText)));
    const membrane = new Membrane(new OpenRouterAdapter({ apiKey: 'test' }), { formatter: new NativeFormatter() });
    const result = await membrane.complete(request());
    expect(result.content).toEqual([text(''), text('kept')]);
    expect(result.rawAssistantText).toBe('kept');
    expect(result.usage).toMatchObject({ inputTokens: 7, outputTokens: 3 });
  });
});

describe('empty systems at the OpenRouter wire and semantic receipt boundaries', () => {
  it.each(['complete', 'stream', 'yielding'])('omits the empty leading system message on %s', async entry => {
    const wire: any[] = [];
    const hooks: any[] = [];
    const receipts: any[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url, init) => {
      wire.push(JSON.parse(init.body));
      return entry === 'complete' ? response([text('done')]) : sseResponse([
        JSON.stringify({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }], usage }),
      ]);
    }));
    const membrane = new Membrane(new OpenRouterAdapter({ apiKey: 'test' }), {
      formatter: new NativeFormatter(),
      hooks: { beforeRequest: (_normalized, raw) => { hooks.push(structuredClone(raw)); } },
    });
    const req = { ...request(), onCacheWireReceipt: (receipt: unknown) => { receipts.push(receipt); } };
    if (entry === 'complete') await membrane.complete(req);
    else if (entry === 'stream') await membrane.stream(req);
    else for await (const event of membrane.streamYielding(req)) {
      if (event.type === 'error') throw event.error;
    }
    expect(wire).toHaveLength(1);
    expect(wire[0].messages).toEqual([{ role: 'user', content: 'User: hello' }]);
    expect(hooks[0].system).toBeUndefined();
    expect(receipts).toHaveLength(1);
    expect(receipts[0].requestHash).toBe(computeCacheWireReceipt(hooks[0]).requestHash);
    expect(receipts[0].requestHash).not.toBe(computeCacheWireReceipt({ ...hooks[0], system: [] }).requestHash);
  });
});

it('replays a stored assistant image through XML as a named user-role image message', async () => {
  const wire: any[] = [];
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url, init) => {
    wire.push(JSON.parse(init.body));
    return response([text('done')]);
  }));
  const data = 'iVBORw0KGgo=';
  const membrane = new Membrane(new OpenRouterAdapter({ apiKey: 'test' }), { formatter: new AnthropicXmlFormatter() });
  await membrane.complete({
    messages: [
      { participant: 'User', content: [text('Draw')] },
      { participant: 'Claude', content: [text('Here'), { type: 'image', source: { type: 'base64', mediaType: 'image/png', data } }] },
      { participant: 'User', content: [text('Thanks')] },
    ],
    config: { model: 'test-model', maxTokens: 128 }, toolMode: 'xml', promptCaching: false,
  });
  const replay = wire[0].messages.find((message: any) => Array.isArray(message.content)
    && message.content.some((part: any) => part.type === 'image_url'));
  expect(replay.role).toBe('user');
  expect(replay.content).toContainEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,' + data } });
  expect(replay.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('')).toContain('Claude: Here');
});
