/**
 * A throwing receipt consumer must fail the call before any provider request,
 * whatever basis the receipt uses.
 *
 * Post-hook receipts fire before the adapter is called. Wire-request receipts
 * fire from inside the adapter's onRequest, where adapter decorators commonly
 * swallow hook errors ("never block on caller hook"). Without a guard, the
 * request would go out and the consumer's failure would vanish.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import type {
  ProviderAdapter,
  ProviderRequest,
  ProviderRequestOptions,
  ProviderResponse,
  StreamCallbacks,
} from '../../src/types/index.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const request = {
  messages: [{ participant: 'User', cacheBreakpoint: true, content: [{ type: 'text' as const, text: 'hello' }] }],
  config: { model: 'claude-sonnet-4-5', maxTokens: 64 },
  toolMode: 'native' as const,
  cacheMarkers: 'cm-owned' as const,
};

function swallowHookErrors(options?: ProviderRequestOptions): ProviderRequestOptions {
  const hook = options?.onRequest;
  return {
    ...options,
    onRequest: (raw: unknown) => {
      try { hook?.(raw as never); } catch { /* never block on caller hook */ }
    },
  } as ProviderRequestOptions;
}

class SwallowingAnthropicAdapter extends AnthropicAdapter {
  override complete(req: ProviderRequest, options?: ProviderRequestOptions) {
    return super.complete(req, swallowHookErrors(options));
  }
  override stream(req: ProviderRequest, callbacks: StreamCallbacks, options?: ProviderRequestOptions) {
    return super.stream(req, callbacks, swallowHookErrors(options));
  }
}

const anthropicMessage = () => new Response(JSON.stringify({
  id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5',
  content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
}), { headers: { 'content-type': 'application/json' } });

describe.each([
  ['AnthropicAdapter', () => new AnthropicAdapter({ apiKey: 'test-key', cacheKeepalive: { enabled: false } })],
  ['a decorator that swallows onRequest errors', () => new SwallowingAnthropicAdapter({ apiKey: 'test-key', cacheKeepalive: { enabled: false } })],
] as const)('wire-request receipt consumer throws: %s', (_name, create) => {
  it.each(['complete', 'stream'] as const)('%s surfaces the consumer error and sends nothing', async (method) => {
    const fetchMock = vi.fn().mockImplementation(async () => anthropicMessage());
    vi.stubGlobal('fetch', fetchMock);
    const failure = new Error('receipt consumer has no draft to submit');
    const membrane = new Membrane(create(), { formatter: new NativeFormatter() });
    const call = membrane[method]({ ...request, onCacheWireReceipt: () => { throw failure; } });
    await expect(call).rejects.toThrow(failure.message);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves calls whose receipt consumer succeeds untouched', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => anthropicMessage());
    vi.stubGlobal('fetch', fetchMock);
    const receipts: unknown[] = [];
    const result = await new Membrane(create(), { formatter: new NativeFormatter() })
      .complete({ ...request, onCacheWireReceipt: (receipt) => receipts.push(receipt) });
    expect(result.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(receipts).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('wire-request receipt guard on a generic adapter', () => {
  class WireBasisAdapter implements ProviderAdapter {
    readonly name = 'wire-basis';
    readonly cacheReceiptBasis = 'wire-request' as const;
    sent = 0;
    supportsModel(): boolean { return true; }
    private async send(options?: ProviderRequestOptions): Promise<ProviderResponse> {
      // A decorator in the way: hook errors are swallowed.
      try { options?.onRequest?.({ model: 'm', messages: [] }); } catch { /* swallowed */ }
      if (options?.signal?.aborted) throw new Error('aborted before send');
      this.sent++;
      return { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, model: 'm', raw: {} } as ProviderResponse;
    }
    complete(_req: ProviderRequest, options?: ProviderRequestOptions) { return this.send(options); }
    stream(_req: ProviderRequest, _callbacks: StreamCallbacks, options?: ProviderRequestOptions) { return this.send(options); }
  }

  it('aborts through the signal and rethrows the original error', async () => {
    const adapter = new WireBasisAdapter();
    const failure = new Error('receipt consumer exploded');
    await expect(new Membrane(adapter, { formatter: new NativeFormatter() })
      .stream({ ...request, onCacheWireReceipt: () => { throw failure; } })).rejects.toThrow(failure.message);
    expect(adapter.sent).toBe(0);
  });

  it('passes the caller signal through, still abortable by the caller', async () => {
    const adapter = new WireBasisAdapter();
    const controller = new AbortController();
    controller.abort();
    await expect(new Membrane(adapter, { formatter: new NativeFormatter() })
      .complete({ ...request, onCacheWireReceipt: () => {} }, { signal: controller.signal })).rejects.toThrow();
    expect(adapter.sent).toBe(0);
  });

  it('does not touch the signal when no receipt consumer is registered', async () => {
    let seen: AbortSignal | undefined;
    const adapter = new WireBasisAdapter();
    const original = adapter.complete.bind(adapter);
    adapter.complete = (req, options) => { seen = options?.signal; return original(req, options); };
    const controller = new AbortController();
    await new Membrane(adapter, { formatter: new NativeFormatter() }).complete(request, { signal: controller.signal });
    expect(seen).toBe(controller.signal);
  });
});
