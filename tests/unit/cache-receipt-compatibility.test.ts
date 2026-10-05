import { afterEach, describe, expect, it, vi } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { AnthropicXmlFormatter } from '../../src/formatters/anthropic-xml.js';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { BedrockAdapter } from '../../src/providers/bedrock.js';
import { OpenAIAdapter } from '../../src/providers/openai.js';
import { OpenAIResponsesAPIAdapter } from '../../src/providers/openai-responses-api.js';
import { GeminiAdapter } from '../../src/providers/gemini.js';
import { OpenRouterAdapter } from '../../src/providers/openrouter.js';
import { computeCacheWireReceipt } from '../../src/cache-wire-receipt.js';

afterEach(() => vi.unstubAllGlobals());
const text = (value: string) => ({ type: 'text' as const, text: value });
const request = {
  messages: [{ participant: 'User', cacheBreakpoint: true, content: [text('hello')] }],
  config: { model: 'claude-sonnet-4-5', maxTokens: 64 },
  toolMode: 'native' as const, cacheMarkers: 'cm-owned' as const,
};
const chat = { choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
const responses = { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }], usage: { input_tokens: 1, output_tokens: 1 } };
const gemini = { candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } };

describe('semantic receipt compatibility', () => {
  it.each([
    ['OpenAI', () => new OpenAIAdapter({ apiKey: 'test' }), 'gpt-4', chat],
    ['Responses', () => new OpenAIResponsesAPIAdapter({ apiKey: 'test' }), 'gpt-5.4', responses],
    ['Gemini', () => new GeminiAdapter({ apiKey: 'test' }), 'gemini-2.5-pro', gemini],
    ['OpenRouter', () => new OpenRouterAdapter({ apiKey: 'test' }), 'provider/model', chat],
  ] as const)('preserves the full post-hook receipt on %s', async (_name, create, model, response) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } })));
    let prepared: unknown;
    let observed: unknown;
    const receipts: unknown[] = [];
    const membrane = new Membrane(create(), {
      formatter: new NativeFormatter(),
      hooks: { beforeRequest: (_request, raw) => { prepared = structuredClone(raw); } },
    });
    const result = await membrane.complete({
      ...request, config: { ...request.config, model },
      onCacheWireReceipt: receipt => receipts.push(receipt),
    }, { onRequest: raw => { observed = raw; } });
    expect(observed).toBeDefined();
    expect(receipts).toEqual([computeCacheWireReceipt(prepared)]);
    expect((receipts[0] as any).markers).toHaveLength(1);
    expect(result.details.cache.markersInRequest).toBe(1);
  });

  it('lets subclasses inherit and decorators explicitly forward the wire basis', async () => {
    class DerivedAnthropic extends AnthropicAdapter {}
    const inner = new DerivedAnthropic({ apiKey: 'test', cacheKeepalive: { enabled: false } });
    expect((inner as any).cacheReceiptBasis).toBe('wire-request');
    expect((new BedrockAdapter({ accessKeyId: 'test', secretAccessKey: 'test' }) as any).cacheReceiptBasis).toBe('wire-request');
    (inner as any).client = { messages: { create: async (raw: any) => ({
      model: raw.model, content: [text('ok')], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
    }) } };
    const decorated = {
      name: 'decorated-provider',
      cacheReceiptBasis: (inner as any).cacheReceiptBasis,
      supportsModel: inner.supportsModel.bind(inner),
      complete: inner.complete.bind(inner), stream: inner.stream.bind(inner),
    };
    const receipts: unknown[] = [];
    let observed: unknown;
    await new Membrane(decorated, { formatter: new NativeFormatter() }).complete({
      ...request, onCacheWireReceipt: receipt => receipts.push(receipt),
    }, { onRequest: raw => { observed = raw; } });
    expect(receipts).toEqual([computeCacheWireReceipt(observed)]);
  });
});

function scriptedAdapter(stops: string[]) {
  const adapter = new AnthropicAdapter({ apiKey: 'test', cacheKeepalive: { enabled: false } });
  let attempts = 0;
  const wire: unknown[] = [];
  const original = adapter.stream.bind(adapter);
  adapter.stream = (req, callbacks, options) => original(req, callbacks, {
    ...options,
    onRequest: raw => { wire.push(raw); options?.onRequest?.(raw); },
  });
  (adapter as any).client = { messages: { stream: async () => {
    const stop = stops[attempts++]!;
    return (async function* () {
      yield { type: 'message_start', message: { model: request.config.model, content: [], usage: { input_tokens: 2, output_tokens: 0 } } };
      yield { type: 'content_block_start', index: 0, content_block: stop === 'tool_use'
        ? { type: 'tool_use', id: 'call', name: 'inspect', input: {} }
        : text('') };
      if (stop !== 'tool_use') yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'reply' } };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 1 } };
      yield { type: 'message_stop' };
    })();
  } } };
  return { adapter, wire, attempts: () => attempts };
}

describe('one receipt per logical streaming round', () => {
  it.each(['native', 'xml'] as const)('matches one usage event when refusalRetries is requested on %s', async mode => {
    const { adapter, wire, attempts } = scriptedAdapter(['refusal', 'end_turn']);
    const receipts: unknown[] = [];
    let usageEvents = 0;
    let retries = 0;
    const membrane = new Membrane(adapter, { formatter: mode === 'native' ? new NativeFormatter() : new AnthropicXmlFormatter() });
    for await (const event of membrane.streamYielding({
      ...request, toolMode: mode, onCacheWireReceipt: receipt => receipts.push(receipt),
    }, { refusalRetries: 1, emitUsage: true })) {
      if (event.type === 'error') throw event.error;
      if (event.type === 'usage') usageEvents++;
      if (event.type === 'retrying') retries++;
    }
    // XML mode intentionally surfaces refusal without retrying. Native mode
    // retries internally, while raw logging still observes both attempts.
    expect(attempts()).toBe(mode === 'native' ? 2 : 1);
    expect(wire).toHaveLength(mode === 'native' ? 2 : 1);
    expect(retries).toBe(mode === 'native' ? 1 : 0);
    expect(usageEvents).toBe(1);
    expect(receipts).toEqual([computeCacheWireReceipt(wire[0])]);
  });

  it('keeps a queue and single-flight consumer aligned into the next tool round', async () => {
    const { adapter, wire, attempts } = scriptedAdapter(['refusal', 'tool_use', 'end_turn']);
    const queue: number[] = [];
    let inFlight: number | undefined;
    let receiptCount = 0;
    const settlements: Array<{ queued: number | undefined; inFlight: number | undefined }> = [];
    const membrane = new Membrane(adapter, { formatter: new NativeFormatter() });
    const stream = membrane.streamYielding({
      ...request,
      tools: [{ name: 'inspect', description: 'inspect', inputSchema: { type: 'object' } }],
      onCacheWireReceipt: () => { inFlight = ++receiptCount; queue.push(inFlight); },
    }, { refusalRetries: 1, emitUsage: true });
    for await (const event of stream) {
      if (event.type === 'error') throw event.error;
      if (event.type === 'usage') {
        const queued = queue.shift();
        settlements.push({ queued, inFlight });
        if (queued === inFlight) inFlight = undefined;
      }
      if (event.type === 'tool-calls') stream.provideToolResults([{ toolUseId: 'call', content: 'ok' }]);
    }
    expect(attempts()).toBe(3);
    expect(wire).toHaveLength(3);
    expect(receiptCount).toBe(2);
    expect(settlements).toEqual([{ queued: 1, inFlight: 1 }, { queued: 2, inFlight: 2 }]);
    expect(queue).toEqual([]);
    expect(inFlight).toBeUndefined();
  });
});
