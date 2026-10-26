import { afterEach, describe, it, expect, vi } from 'vitest';
import { AnthropicAdapter, THINKING_BINDING_BETA } from '../../src/providers/anthropic.js';

afterEach(() => { vi.unstubAllGlobals(); });

const message = {
  id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
};
const events = [
  { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
];

async function sentBetas(defaultHeaders: unknown, binding: boolean, path: 'complete' | 'stream' = 'complete'): Promise<string[]> {
  const sent: Array<string | null> = [];
  // Stubbed before the adapter is built, since the SDK's client takes the global fetch when it's made.
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    sent.push(new Headers(init?.headers).get('anthropic-beta'));
    return path === 'complete'
      ? new Response(JSON.stringify(message), { headers: { 'content-type': 'application/json' } })
      : new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  }));
  const adapter = new AnthropicAdapter({ apiKey: 'sk-test', cacheKeepalive: { enabled: false }, defaultHeaders: defaultHeaders as any });
  const request = {
    model: 'claude-opus-5-5',
    maxTokens: 100,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    thinking: binding ? { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } } : { type: 'adaptive' },
  } as any;
  if (path === 'complete') await adapter.complete(request);
  else await adapter.stream(request, { onChunk() {} });
  expect(sent).toHaveLength(1);
  return (sent[0] ?? '').split(',').map((b) => b.trim()).filter(Boolean);
}

const shapes: Array<[string, unknown, string[]]> = [
  ['a string', { 'anthropic-beta': 'oauth-2025-04-20' }, ['oauth-2025-04-20']],
  ['an array', { 'anthropic-beta': ['oauth-2025-04-20'] }, ['oauth-2025-04-20']],
  ['an array where null clears the values before it', { 'anthropic-beta': ['old-beta', null, 'oauth-2025-04-20', 'other-beta'] }, ['oauth-2025-04-20', 'other-beta']],
  ['an array ending in null', { 'anthropic-beta': ['oauth-2025-04-20', null] }, []],
  ['an array with undefined between values', { 'anthropic-beta': ['a-beta', undefined, 'b-beta'] }, ['a-beta', 'b-beta']],
  ['null', { 'anthropic-beta': null }, []],
  ['entries rows, which append', [['anthropic-beta', 'a-beta'], ['Anthropic-Beta', 'b-beta']], ['a-beta', 'b-beta']],
  ['entries rows with a null row', [['anthropic-beta', 'a-beta'], ['anthropic-beta', null], ['anthropic-beta', 'b-beta']], ['b-beta']],
  ['a later key differing in case, which replaces', { 'anthropic-beta': ['old-beta'], 'Anthropic-Beta': ['new-beta'] }, ['new-beta']],
  ['a later key differing in case, null', { 'anthropic-beta': 'a-beta', 'Anthropic-Beta': null }, []],
  ['a later key differing in case, undefined only', { 'anthropic-beta': 'a-beta', 'Anthropic-Beta': undefined }, ['a-beta']],
  ['a Headers object', new Headers({ 'anthropic-beta': 'a-beta' }), ['a-beta']],
];

describe('a default anthropic-beta beside a per-request beta', () => {
  it.each(shapes)('%s: the request keeps the betas the SDK sends for the default', async (_label, defaults, sdkDefault) => {
    expect(await sentBetas(defaults, false)).toEqual(sdkDefault);
    expect(await sentBetas(defaults, true)).toEqual([...sdkDefault, THINKING_BINDING_BETA]);
  });

  it('stream() keeps them too', async () => {
    const defaults = { 'anthropic-beta': ['oauth-2025-04-20', 'other-beta'] };
    expect(await sentBetas(defaults, false, 'stream')).toEqual(['oauth-2025-04-20', 'other-beta']);
    expect(await sentBetas(defaults, true, 'stream')).toEqual(['oauth-2025-04-20', 'other-beta', THINKING_BINDING_BETA]);
  });
});
