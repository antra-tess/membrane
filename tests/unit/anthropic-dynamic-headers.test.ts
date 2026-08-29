/**
 * dynamicHeaders: live per-request header stamps (e.g. x-gate-debt-chunks,
 * a household-telemetry value read by an inference gateway and stripped
 * there — the vendor never sees it).
 *
 * Contract under test:
 *   - the callback is evaluated PER REQUEST, so a changing value (compression
 *     debt) produces a fresh header on every call;
 *   - null / undefined / '' entries are dropped, and an all-empty result
 *     leaves headers exactly as they were (undefined stays undefined);
 *   - the cache-keepalive recorder receives the PRE-merge headers: a replayed
 *     touch must never resend a stale telemetry stamp — an unstamped touch is
 *     honest, a stale stamp lies.
 */

import { describe, it, expect, vi } from 'vitest';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import type { ProviderRequest } from '../../src/types/index.js';

const REQUEST: ProviderRequest = {
  model: 'claude-3-opus-20240229',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
} as unknown as ProviderRequest;

const RESPONSE = {
  id: 'msg_test', model: 'claude-3-opus-20240229', role: 'assistant',
  content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
  usage: { input_tokens: 1, output_tokens: 1 },
};

function adapterWith(dynamicHeaders?: () => Record<string, string | number | null | undefined>) {
  const adapter = new AnthropicAdapter({
    apiKey: 'sk-test',
    cacheKeepalive: { enabled: false },
    dynamicHeaders,
  });
  const create = vi.fn().mockResolvedValue(RESPONSE);
  (adapter as any).client = { messages: { create } };
  return { adapter, create };
}

describe('AnthropicAdapter dynamicHeaders', () => {
  it('stamps the outgoing request and re-evaluates per call', async () => {
    let debt = 3;
    const { adapter, create } = adapterWith(() => ({ 'x-gate-debt-chunks': debt }));

    await adapter.complete(REQUEST);
    expect(create.mock.calls[0][1].headers).toEqual({ 'x-gate-debt-chunks': '3' });

    debt = 7; // a chunk appeared between calls
    await adapter.complete(REQUEST);
    expect(create.mock.calls[1][1].headers).toEqual({ 'x-gate-debt-chunks': '7' });
  });

  it('drops empty values and leaves absent headers absent', async () => {
    const { adapter, create } = adapterWith(() => ({
      'x-gate-debt-chunks': null, 'x-empty': '', 'x-undef': undefined,
    }));
    await adapter.complete(REQUEST);
    expect(create.mock.calls[0][1].headers).toBeUndefined();
  });

  it('is a no-op when unconfigured', async () => {
    const { adapter, create } = adapterWith(undefined);
    await adapter.complete(REQUEST);
    expect(create.mock.calls[0][1].headers).toBeUndefined();
  });

  it('keepalive records PRE-merge headers — a replay never resends a stale stamp', async () => {
    const adapter = new AnthropicAdapter({
      apiKey: 'sk-test',
      cacheKeepalive: { enabled: false },
      dynamicHeaders: () => ({ 'x-gate-debt-chunks': 42 }),
    });
    const create = vi.fn().mockResolvedValue(RESPONSE);
    (adapter as any).client = { messages: { create } };
    const record = vi.fn();
    (adapter as any).cacheKeepalive = { record };

    await adapter.complete(REQUEST);

    // outgoing request carries the live stamp…
    expect(create.mock.calls[0][1].headers).toEqual({ 'x-gate-debt-chunks': '42' });
    // …but the recorded (replayable) headers do not
    const recordedHeaders = record.mock.calls[0][1];
    expect(recordedHeaders?.['x-gate-debt-chunks']).toBeUndefined();
  });
});
