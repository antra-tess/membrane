import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheKeepalive, lineageKey, type CacheKeepaliveConfig, type KeepaliveCall } from '../../src/cache-keepalive.js';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';

const START = Date.parse('2026-10-02T00:00:00Z');
const usage = {
  input_tokens: 12, output_tokens: 0,
  cache_read_input_tokens: 1000, cache_creation_input_tokens: 0,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
  service_tier: 'standard', inference_geo: 'us',
};

function wire() {
  return {
    model: 'claude-sonnet-4-5', max_tokens: 1024, stream: true,
    thinking: { type: 'adaptive' },
    system: [{ type: 'text', text: 'Resident system', cache_control: { type: 'ephemeral', ttl: '1h' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
  };
}

const keepalives: CacheKeepalive[] = [];
function setup(send: any, config: CacheKeepaliveConfig = {}) {
  const calls: KeepaliveCall[] = [];
  const events: any[] = [];
  const ka = new CacheKeepalive(send, {
    refreshAfterMs: 100, checkIntervalMs: 100, maxIdleMs: 1000,
    onCall: call => { calls.push(call); },
    onEvent: event => { events.push(event); },
    ...config,
  });
  keepalives.push(ka);
  return { ka, calls, events };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(START); });
afterEach(() => {
  for (const ka of keepalives.splice(0)) ka.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('keepalive terminal call receipts', () => {
  it('reports the exact poke, full response, lineage, lane, and send duration', async () => {
    const response = { id: 'poke_1', model: 'claude-sonnet-4-5', stop_reason: 'max_tokens', usage, extra_vendor_field: { retained: true } };
    const send = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 7));
      return response;
    });
    const { ka, calls, events } = setup(send);
    const original = wire();
    const before = structuredClone(original);
    ka.record(original, { 'anthropic-beta': 'some-beta' }, 'stream');
    await vi.advanceTimersByTimeAsync(107);

    expect(send).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([{
      key: lineageKey(original), lane: 'stream', startedAt: START + 100, durationMs: 7,
      request: { ...original, max_tokens: 0, stream: undefined },
      outcome: 'success', response,
    }]);
    expect(calls[0]!.request).not.toHaveProperty('stream');
    expect(calls[0]).not.toHaveProperty('headers');
    expect(calls[0]!.request).toEqual(send.mock.calls[0]![0]);
    expect(events).toContainEqual(expect.objectContaining({ type: 'refreshed', readTokens: 1000 }));
    expect(original).toEqual(before);
  });

  it.each([
    ['writes', { ...usage, cache_creation_input_tokens: 25, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 25 } }],
    ['reads nothing', { ...usage, cache_read_input_tokens: 0 }],
  ])('reports a successful vendor response even when the poke %s', async (_label, vendorUsage) => {
    const response = { usage: vendorUsage };
    const { ka, calls, events } = setup(vi.fn().mockResolvedValue(response), { maxIneffective: 1 });
    ka.record(wire(), undefined, 'stream');
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ outcome: 'success', response });
    expect(events[0].type).toBe('ineffective');
    expect(ka.getStatus()).toEqual([]);
  });

  it('reports failed sends exactly once and preserves the error and breaker behavior', async () => {
    const error = Object.assign(new Error('Upstream failed'), { status: 503 });
    const send = vi.fn().mockRejectedValue(error);
    const { ka, calls, events } = setup(send, { maxConsecutiveErrors: 2 });
    ka.record(wire(), { Authorization: 'private-credential' }, 'stream');
    await vi.advanceTimersByTimeAsync(300);
    expect(send).toHaveBeenCalledTimes(2);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.outcome).toBe('error');
      expect(call).toMatchObject({ error, lane: 'stream', durationMs: 0 });
      expect(call.request.max_tokens).toBe(0);
      expect(call).not.toHaveProperty('headers');
    }
    expect(events.map(e => e.type)).toEqual(['error', 'error', 'disabled']);
    expect(ka.getStatus()).toEqual([]);
  });

  it('isolates observer mutations from the cached prefix and effectiveness checks', async () => {
    const response = { usage: structuredClone(usage) };
    const original = wire();
    const before = structuredClone(original);
    const send = vi.fn().mockResolvedValue(response);
    const onCall = vi.fn((call: KeepaliveCall) => {
      (call.request.system as any[])[0].text = 'Changed by observer';
      if (call.outcome === 'success') call.response.usage!.cache_read_input_tokens = 0;
    });
    const { ka, events } = setup(send, { maxIneffective: 1, onCall });
    ka.record(original, undefined, 'stream');
    await vi.advanceTimersByTimeAsync(200);
    expect(send).toHaveBeenCalledTimes(2);
    expect(events.map(e => e.type)).toEqual(['refreshed', 'refreshed']);
    expect(onCall).toHaveBeenCalledTimes(2);
    expect(original).toEqual(before);
    expect(response.usage).toEqual(usage);
    for (const [request] of send.mock.calls) {
      expect(request.system).toEqual(before.system);
      expect(request.thinking).toEqual(before.thinking);
    }
  });

  it.each(['throw', 'reject', 'pending'])('keeps sending when the observer returns %s', async mode => {
    const send = vi.fn().mockResolvedValue({ usage });
    const onCall = vi.fn(() => {
      if (mode === 'throw') throw new Error('Logger failed');
      if (mode === 'reject') return Promise.reject(new Error('Logger failed asynchronously'));
      return new Promise<void>(() => {});
    });
    const { ka, events } = setup(send, { onCall });
    ka.record(wire(), undefined, 'stream');
    await vi.advanceTimersByTimeAsync(200);
    expect(send).toHaveBeenCalledTimes(2);
    expect(onCall).toHaveBeenCalledTimes(2);
    expect(events.map(e => e.type)).toEqual(['refreshed', 'refreshed']);
  });

  it('has no receipt for disabled, ineligible, expired, or excluded-lane records', async () => {
    for (const config of [
      { enabled: false }, { maxIdleMs: 50 }, { lanes: ['complete'] as const },
    ]) {
      const { ka, calls } = setup(vi.fn(), config as CacheKeepaliveConfig);
      ka.record(wire(), undefined, 'stream');
      await vi.advanceTimersByTimeAsync(200);
      expect(calls).toEqual([]);
    }
    const { ka, calls } = setup(vi.fn());
    ka.record({ ...wire(), system: [], messages: [] }, undefined, 'stream');
    await vi.advanceTimersByTimeAsync(200);
    expect(calls).toEqual([]);
  });

  it('surfaces non-JSON payload failures through lifecycle events before invoking the sender', async () => {
    const send = vi.fn().mockResolvedValue({ usage });
    const { ka, calls, events } = setup(send, { maxConsecutiveErrors: 1 });
    ka.record({ ...wire(), invalidExtra: 1n }, undefined, 'stream');
    await vi.advanceTimersByTimeAsync(200);
    expect(send).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(events.map(event => event.type)).toEqual(['error', 'disabled']);
    expect(ka.getStatus()).toEqual([]);
  });

  it('reports the complete lane when explicitly enabled', async () => {
    const { ka, calls } = setup(vi.fn().mockResolvedValue({ usage }), { lanes: ['complete'] });
    ka.record(wire(), undefined, 'complete');
    await vi.advanceTimersByTimeAsync(100);
    expect(calls[0]?.lane).toBe('complete');
  });
});

describe('Anthropic adapter receipt integration', () => {
  it.each(['success', 'error'] as const)('keeps a %s receipt when JSON serialization omits callable request fields', async outcome => {
    const calls: KeepaliveCall[] = [];
    const requests: any[] = [];
    const metadataToJSON = vi.fn(() => ({ user_id: 'fixture' }));
    vi.stubGlobal('fetch', vi.fn(async (_input, init) => {
      const body = JSON.parse(init.body);
      requests.push(body);
      if (body.max_tokens === 0 && outcome === 'error') {
        return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Rejected poke' } }), {
          status: 400, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        id: 'response', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5',
        content: [], stop_reason: 'max_tokens', stop_sequence: null, usage,
      }), { headers: { 'content-type': 'application/json' } });
    }));
    const adapter = new AnthropicAdapter({
      apiKey: 'test-key',
      cacheKeepalive: {
        lanes: ['complete'], refreshAfterMs: 100, checkIntervalMs: 100, maxIdleMs: 1000,
        onCall: call => { calls.push(call); },
      },
    });
    keepalives.push(adapter.cacheKeepalive!);
    await adapter.complete({
      model: 'claude-sonnet-4-5', maxTokens: 1024,
      system: wire().system, messages: wire().messages,
      extra: { clientOnly: () => {}, metadata: { toJSON: metadataToJSON } },
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(requests).toHaveLength(2);
    expect(requests[1]).not.toHaveProperty('clientOnly');
    expect(requests[1].metadata).toEqual({ user_id: 'fixture' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.outcome).toBe(outcome);
    expect(calls[0]!.request).toEqual(requests[1]);
    // Materialize JSON once per actual call, rather than invoking a caller's
    // serializer again while creating the receipt.
    expect(metadataToJSON).toHaveBeenCalledTimes(2);
  });

  it('reports one terminal receipt for a poke with an SDK-internal HTTP retry', async () => {
    const calls: KeepaliveCall[] = [];
    const requests: any[] = [];
    let httpCalls = 0;
    const terminal = {
      id: 'poke_response', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5',
      content: [], stop_reason: 'max_tokens', stop_sequence: null, usage,
      vendor_extension: { retained: true },
    };
    vi.stubGlobal('fetch', vi.fn(async (_input, init) => {
      requests.push(JSON.parse(init.body));
      httpCalls++;
      if (httpCalls === 2) {
        return new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Try again' } }), {
          status: 429, headers: { 'content-type': 'application/json', 'retry-after-ms': '20' },
        });
      }
      return new Response(JSON.stringify(terminal), { headers: { 'content-type': 'application/json' } });
    }));
    const adapter = new AnthropicAdapter({
      apiKey: 'test-key',
      cacheKeepalive: {
        lanes: ['complete'], refreshAfterMs: 100, checkIntervalMs: 100, maxIdleMs: 1000,
        onCall: call => { calls.push(call); },
      },
    });
    keepalives.push(adapter.cacheKeepalive!);
    await adapter.complete({
      model: 'claude-sonnet-4-5', maxTokens: 1024,
      system: wire().system, messages: wire().messages,
      extra: { thinking: { type: 'adaptive' } },
    });
    expect(calls).toEqual([]); // Foreground calls already have their own observers.
    await vi.advanceTimersByTimeAsync(150);
    expect(httpCalls).toBe(3); // One foreground call, two attempts for one poke.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      outcome: 'success', lane: 'complete', response: terminal,
      startedAt: START + 100, durationMs: 20,
    });
    const { stream: _stream, ...seed } = requests[0];
    expect(requests[1]).toEqual({ ...seed, max_tokens: 0 });
    expect(requests[2]).toEqual(requests[1]);
    expect(calls[0]!.request).toEqual(requests[2]);
    expect(calls[0]).not.toHaveProperty('headers');
  });
});
