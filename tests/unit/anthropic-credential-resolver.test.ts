import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import type { CredentialContext } from '../../src/providers/credentials.js';
import type { ProviderRequest } from '../../src/types/index.js';

const request: ProviderRequest = {
  model: 'claude-sonnet-4-6', maxTokens: 32,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
};
const message = {
  id: 'msg_test', type: 'message', role: 'assistant', model: request.model,
  content: [{ type: 'text', text: 'hello back' }], stop_reason: 'end_turn', stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 2 },
};
const completed = () => new Response(JSON.stringify(message), { headers: { 'content-type': 'application/json' } });
const unauthorized = () => new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'expired token' } }), { status: 401, headers: { 'content-type': 'application/json' } });
function streaming(error = false): Response {
  const events = [
    { type: 'message_start', message: { ...message, content: [], stop_reason: null } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello back' } },
    ...(error ? [{ type: 'error', error: { type: 'authentication_error', message: 'expired midstream' } }] : [
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ]),
  ];
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('Anthropic rotating credentials through the real SDK', () => {
  it('accepts an authToken resolver and resolves it per call', async () => {
    const sent: string[] = [];
    let token = 'first';
    vi.stubGlobal('fetch', async (_input: unknown, init: RequestInit) => {
      sent.push(new Headers(init.headers).get('authorization')!); return completed();
    });
    const adapter = new AnthropicAdapter({ authToken: () => token, cacheKeepalive: { enabled: false } });
    await adapter.complete(request);
    token = 'second';
    await adapter.complete(request);
    expect(sent).toEqual(['Bearer first', 'Bearer second']);
  });

  it.each(['complete', 'stream'] as const)('refreshes once after HTTP 401 on %s', async lane => {
    const flags: boolean[] = [];
    const attempts: Array<{ headers: Headers; body: string }> = [];
    vi.stubEnv('ANTHROPIC_API_KEY', 'env-key');
    vi.stubGlobal('fetch', async (_input: unknown, init: RequestInit) => {
      attempts.push({ headers: new Headers(init.headers), body: String(init.body) });
      return attempts.length === 1 ? unauthorized() : lane === 'stream' ? streaming() : completed();
    });
    const adapter = new AnthropicAdapter({
      credentials: async ({ forceRefresh }) => {
        flags.push(forceRefresh);
        return { token: forceRefresh ? 'fresh' : 'expired', headers: { 'X-Api-Key': 'resolver-key', 'x-account': forceRefresh ? 'new' : 'old' } };
      },
      authToken: 'ignored-static-token', apiKey: 'ignored-api-key',
      defaultHeaders: { authorization: 'Bearer stale', 'X-Api-Key': 'default-key', 'anthropic-beta': 'oauth-2025-04-20' },
      dynamicHeaders: () => ({ 'x-lane-stamp': lane, 'x-api-key': 'dynamic-key' }),
      cacheKeepalive: { enabled: false },
    });
    const result = lane === 'stream' ? await adapter.stream(request, { onChunk: () => {} }) : await adapter.complete(request);
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'hello back' });
    expect(flags).toEqual([false, true]);
    expect(attempts[0]?.body).toBe(attempts[1]?.body);
    expect(attempts[1]?.headers.get('authorization')).toBe('Bearer fresh');
    expect(attempts[1]?.headers.get('x-account')).toBe('new');
    for (const { headers } of attempts) {
      expect(headers.has('x-api-key')).toBe(false);
      expect(headers.get('anthropic-beta')).toContain('oauth-2025-04-20');
      expect(headers.get('x-lane-stamp')).toBe(lane);
    }
  });

  it('propagates forceRefresh through authToken shorthand and bounds a repeated 401', async () => {
    const flags: boolean[] = [];
    vi.stubGlobal('fetch', async () => unauthorized());
    const adapter = new AnthropicAdapter({ authToken: ({ forceRefresh }: CredentialContext) => {
      flags.push(forceRefresh); return 'expired';
    }, cacheKeepalive: { enabled: false } });
    await expect(adapter.complete(request)).rejects.toMatchObject({ type: 'auth' });
    expect(flags).toEqual([false, true]);
  });

  it('does not replay an auth failure after streaming partial output', async () => {
    let resolutions = 0;
    const chunks: string[] = [];
    vi.stubGlobal('fetch', async () => streaming(true));
    const adapter = new AnthropicAdapter({ credentials: () => { resolutions++; return { token: 't' }; }, cacheKeepalive: { enabled: false } });
    await expect(adapter.stream(request, { onChunk: chunk => chunks.push(chunk) })).rejects.toMatchObject({ type: 'auth' });
    expect(chunks).toEqual(['hello back']);
    expect(resolutions).toBe(1);
  });

  it('aborts a pending credential resolver before making an HTTP request', async () => {
    const controller = new AbortController();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const adapter = new AnthropicAdapter({ credentials: () => { entered(); return new Promise(() => {}); }, cacheKeepalive: { enabled: false } });
    const pending = adapter.complete(request, { signal: controller.signal });
    await started;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ type: 'abort' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('resolves fresh credentials on keepalive replay without replaying a telemetry stamp', async () => {
    const sent: Array<{ headers: Headers; body: any }> = [];
    let token = 'first';
    let wake!: () => void;
    const touched = new Promise<void>(resolve => { wake = resolve; });
    vi.stubGlobal('fetch', async (_input: unknown, init: RequestInit) => {
      sent.push({ headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
      if (sent.length === 2) wake();
      return completed();
    });
    const adapter = new AnthropicAdapter({
      authToken: () => token,
      dynamicHeaders: () => ({ 'x-live-stamp': 'primary' }),
      cacheKeepalive: { lanes: ['complete'], refreshAfterMs: 1, checkIntervalMs: 5 },
    });
    try {
      await adapter.complete({ ...request, system: [{ type: 'text', text: 'policy', cache_control: { type: 'ephemeral', ttl: '1h' } }] });
      token = 'second';
      await touched;
      expect(sent[0]?.headers.get('authorization')).toBe('Bearer first');
      expect(sent[1]?.headers.get('authorization')).toBe('Bearer second');
      expect(sent[1]?.headers.has('x-live-stamp')).toBe(false);
      expect(sent[1]?.body.max_tokens).toBe(0);
    } finally {
      adapter.cacheKeepalive?.stop();
    }
  });
});
