import { describe, expect, it } from 'vitest';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { AnthropicXmlFormatter } from '../../src/formatters/anthropic-xml.js';
import { Membrane } from '../../src/membrane.js';
import { computeCacheWireReceipt } from '../../src/cache-wire-receipt.js';
import type { NormalizedRequest } from '../../src/types/index.js';

const text = (value: string) => ({ type: 'text' as const, text: value });
const base: NormalizedRequest = {
  messages: [{ participant: 'User', content: [text('hello')] }],
  config: { model: 'claude-sonnet-4-5', maxTokens: 64 },
  toolMode: 'native',
};
function capture() {
  const adapter = new AnthropicAdapter({ apiKey: 'test', cacheKeepalive: { enabled: false } });
  const calls: any[] = [];
  const raw = {
    model: base.config.model, content: [text('ok')], stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  (adapter as any).client = { messages: {
    create: async (req: any) => { calls.push(req); return raw; },
    stream: async (req: any) => {
      // The real SDK stream() helper adds stream:true to its HTTP body.
      calls.push({ ...req, stream: true });
      return (async function* () {
        yield { type: 'message_start', message: { ...raw, content: [] } };
        yield { type: 'content_block_start', index: 0, content_block: text('') };
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } };
        yield { type: 'content_block_stop', index: 0 };
        yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: raw.usage };
        yield { type: 'message_stop' };
      })();
    },
  } };
  return { adapter, calls };
}

describe('empty-text cleanup scope and ordering', () => {
  it.each(['complete', 'stream', 'yielding'])('omits a wire receipt when a custom adapter omits onRequest on %s', async entry => {
    const receipts: any[] = [];
    const result = { content: [text('ok')], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
    const adapter: any = {
      name: 'unobserved-custom-adapter', supportsModel: () => true,
      complete: async () => result,
      stream: async (_request: unknown, callbacks: any) => { callbacks.onChunk('ok'); return result; },
    };
    const membrane = new Membrane(adapter, { formatter: new NativeFormatter() });
    const req = {
      ...base, messages: [{ ...base.messages[0]!, cacheBreakpoint: true }],
      onCacheWireReceipt: (receipt: any) => receipts.push(receipt),
    };
    let response: any;
    if (entry === 'complete') response = await membrane.complete(req);
    else if (entry === 'stream') response = await membrane.stream(req);
    else for await (const event of membrane.streamYielding(req)) {
      if (event.type === 'error') throw event.error;
      if (event.type === 'complete') response = event.response;
    }
    expect(receipts).toEqual([]);
    // The documented compatibility fallback counts the adapter input.
    expect(response.details.cache.markersInRequest).toBe(1);
  });

  it('keeps the receipt aligned with valid markers in adapter-level overrides', async () => {
    const { adapter, calls } = capture();
    const receipts: any[] = [];
    const system = [
      { ...text(' \n'), cache_control: { type: 'ephemeral' } },
      { ...text('rules'), cache_control: { type: 'ephemeral' } },
    ];
    const before = structuredClone(system);
    const response = await new Membrane(adapter, { formatter: new NativeFormatter() }).complete({
      ...base, providerParams: { system },
      onCacheWireReceipt: receipt => receipts.push(receipt),
    });
    expect(calls[0].system).toEqual([system[1]]);
    expect(receipts[0]).toEqual(computeCacheWireReceipt(calls[0]));
    expect(receipts[0].markers).toHaveLength(1);
    expect(response.details.cache.markersInRequest).toBe(1);
    expect(system).toEqual(before);
  });

  it('keeps standalone NativeFormatter whitespace for transports that permit it', () => {
    const built = new NativeFormatter().buildMessages([
      base.messages[0]!,
      { participant: 'Claude', content: [text('left'), text(' \t\n'), text('right')] },
    ], { participantMode: 'multiuser', assistantParticipant: 'Claude' });
    expect((built.messages[1] as any).content).toEqual([text('left'), text(' \t\n'), text('right')]);
  });

  it.each(['complete', 'stream', 'yielding'])('keeps whitespace for other adapters on %s', async entry => {
    const calls: any[] = [];
    const adapter: any = {
      name: 'other-provider', supportsModel: () => true,
      complete: async (req: any) => {
        calls.push(req);
        return { content: [text('ok')], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
      },
      stream: async (req: any, callbacks: any) => {
        calls.push(req); callbacks.onChunk('ok');
        return { content: [text('ok')], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const membrane = new Membrane(adapter, { formatter: new NativeFormatter() });
    const req = { ...base, messages: [...base.messages, { participant: 'Claude', content: [text('left'), text(' \t\n'), text('right')] }] };
    if (entry === 'complete') await membrane.complete(req);
    else if (entry === 'stream') await membrane.stream(req);
    else for await (const event of membrane.streamYielding(req)) {
      if (event.type === 'error') throw event.error;
    }
    expect(calls[0].messages.find((m: any) => m.role === 'assistant').content).toEqual([text('left'), text(' \t\n'), text('right')]);
  });

  it('removes the invalid prefix block while retaining other formatted content', async () => {
    const { adapter, calls } = capture();
    await new Membrane(adapter, { formatter: new NativeFormatter() }).complete({ ...base, contextPrefix: ' \n\t' });
    // Anthropic combines consecutive same-role messages. This transport
    // cleanup preserves the formatter's synthetic content rather than adding
    // a second, competing role-repair policy.
    expect(calls[0].messages).toEqual([
      { role: 'user', content: [text('[continuing]')] },
      { role: 'user', content: [text('User: hello')] },
    ]);
  });

  it.each(['complete', 'stream', 'yielding'].flatMap(entry => ['native', 'xml'].map(mode => ({ entry, mode }))))(
    'reports only sent markers after $entry/$mode cleanup', async ({ entry, mode }) => {
    const { adapter, calls } = capture();
    const receipts: any[] = [];
    const membrane = new Membrane(adapter, {
      formatter: mode === 'native' ? new NativeFormatter() : new AnthropicXmlFormatter(),
      hooks: { beforeRequest: (_normalized, raw: any) => {
        // A hook can add a new invalid block after formatter cleanup.
        raw.system = [{ ...text(' \n'), cache_control: { type: 'ephemeral' } }];
      } },
    });
    const req = { ...base, toolMode: mode as 'native' | 'xml', system: ' \n', onCacheWireReceipt: (receipt: any) => receipts.push(receipt) };
    let response: any;
    if (entry === 'complete') response = await membrane.complete(req);
    else if (entry === 'stream') response = await membrane.stream(req);
    else for await (const event of membrane.streamYielding(req)) {
      if (event.type === 'error') throw event.error;
      if (event.type === 'complete') response = event.response;
    }
    expect(calls[0]).not.toHaveProperty('system');
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toEqual(computeCacheWireReceipt(calls[0]));
    expect(response.details.cache.markersInRequest).toBe(0);
  });
});
