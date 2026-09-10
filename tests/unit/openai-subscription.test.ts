import { afterEach, describe, expect, test } from 'vitest';
import { Membrane, OpenAIResponsesFormatter } from '../../src/index.js';
import type { ProviderRequest } from '../../src/index.js';
import { OpenAIResponsesAPIAdapter, type CredentialResolver } from '../../src/index.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function request(extra: Record<string, unknown> = {}): ProviderRequest {
  return {
    model: 'gpt-5.4',
    messages: [{ type: 'message', role: 'user', content: 'Hello' }],
    maxTokens: 8192,
    temperature: 0.2,
    topP: 0.9,
    topK: 20,
    extra,
  };
}

function completedResponse(): Response {
  const item = {
      type: 'message',
      id: 'msg_test',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Hello back' }],
  };
  const events = [
    { type: 'response.output_item.done', output_index: 0, item },
    {
      type: 'response.completed',
      response: {
        id: 'resp_test',
        model: 'gpt-5.4',
        status: 'completed',
        output: [],
        usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
      },
    },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('OpenAI Responses subscription mode', () => {
  test('uses the subscription endpoint and enables Fast mode per request', async () => {
    const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      });
      return completedResponse();
    };
    const auth: CredentialResolver = async () => ({ token: 'subscription-token', headers: { 'ChatGPT-Account-Id': 'account-test' } });
    const adapter = new OpenAIResponsesAPIAdapter({
      mode: 'subscription',
      credentials: auth,
      baseURL: 'https://example.test/backend-api/codex/',
      fastMode: true,
    });

    const response = await adapter.complete(request({ max_output_tokens: 999, temperature: 1, top_p: 1, top_k: 5 }));

    expect(response.stopReason).toBe('end_turn');
    expect((response.content as Array<{ text?: string }>)[0]?.text).toBe('Hello back');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://example.test/backend-api/codex/responses');
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer subscription-token');
    expect(requests[0]?.headers.get('chatgpt-account-id')).toBe('account-test');
    expect(requests[0]?.body.service_tier).toBe('priority');
    expect(requests[0]?.body.max_output_tokens).toBeUndefined();
    expect(requests[0]?.body.temperature).toBeUndefined();
    expect(requests[0]?.body.top_p).toBeUndefined();
    expect(requests[0]?.body.top_k).toBeUndefined();
    expect(requests[0]?.body.input).toEqual([{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Hello' }],
    }]);
  });

  test('normalizes maintenance text, images, and tool blocks at the transport boundary', async () => {
    let body: Record<string, any> = {};
    globalThis.fetch = async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return completedResponse();
    };
    const adapter = new OpenAIResponsesAPIAdapter({
      mode: 'subscription',
      credentials: async () => ({ token: 'subscription-token' }),
      baseURL: 'https://example.test/codex',
    });

    await adapter.complete({
      model: 'gpt-5.4',
      messages: [
        {
          type: 'message', role: 'user', content: [
            { type: 'text', text: 'inspect' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
          ],
        },
        {
          type: 'message', role: 'assistant', content: [
            { type: 'tool_use', id: 'call_1', name: 'lookup', input: { q: 'x' } },
          ],
        },
        {
          type: 'message', role: 'user', content: [
            { type: 'tool_result', tool_use_id: 'call_1', content: 'found' },
          ],
        },
      ] as any,
      maxTokens: 1024,
    });

    expect(body.input).toEqual([
      {
        type: 'message', role: 'user', content: [
          { type: 'input_text', text: 'inspect' },
          { type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=' },
        ],
      },
      { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"q":"x"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'found' },
    ]);
  });

  test('turns Fast mode off without reconstructing the adapter', async () => {
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return completedResponse();
    };
    const adapter = new OpenAIResponsesAPIAdapter({
      mode: 'subscription',
      credentials: async () => ({ token: 'subscription-token' }),
      baseURL: 'https://example.test/codex',
      fastMode: true,
    });

    await adapter.complete(request());
    adapter.setFastMode(false);
    await adapter.complete(request({ service_tier: 'priority' }));

    expect(bodies[0]?.service_tier).toBe('priority');
    expect(bodies[1]?.service_tier).toBeUndefined();
  });

  test('refreshes the ChatGPT token once after a 401', async () => {
    const refreshFlags: boolean[] = [];
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) return new Response('expired', { status: 401 });
      return completedResponse();
    };
    const adapter = new OpenAIResponsesAPIAdapter({
      mode: 'subscription',
      credentials: async ({ forceRefresh }) => {
        refreshFlags.push(forceRefresh);
        return { token: forceRefresh ? 'fresh-token' : 'expired-token' };
      },
      baseURL: 'https://example.test/codex',
    });

    await adapter.complete(request());

    expect(calls).toBe(2);
    expect(refreshFlags).toEqual([false, true]);
  });

  test('reconstructs tool calls when the terminal event has an empty output', async () => {
    const item = {
      type: 'function_call',
      id: 'fc_test',
      call_id: 'call_test',
      name: 'lookup',
      arguments: '{"query":"connectome"}',
    };
    globalThis.fetch = async () => new Response([
      `data: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item })}\n\n`,
      `data: ${JSON.stringify({
        type: 'response.completed',
        response: {
          model: 'gpt-5.4', status: 'completed', output: [],
          usage: { input_tokens: 2, output_tokens: 3 },
        },
      })}\n\n`,
    ].join(''), { headers: { 'Content-Type': 'text/event-stream' } });
    const adapter = new OpenAIResponsesAPIAdapter({
      mode: 'subscription',
      credentials: async () => ({ token: 'subscription-token' }),
      baseURL: 'https://example.test/codex',
    });

    const response = await adapter.complete(request());

    expect(response.stopReason).toBe('tool_use');
    expect(response.content).toEqual([expect.objectContaining({
      type: 'tool_use', id: 'call_test', name: 'lookup', input: { query: 'connectome' },
    })]);
  });

  test('surfaces nested SSE error details', async () => {
    globalThis.fetch = async () => new Response(
      'data: {"type":"error","error":{"type":"invalid_request_error","code":"context_length_exceeded","message":"input is too large"}}\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
    const adapter = new OpenAIResponsesAPIAdapter({
      mode: 'subscription',
      credentials: async () => ({ token: 'subscription-token' }),
      baseURL: 'https://example.test/codex',
    });

    await expect(adapter.complete(request())).rejects.toThrow(
      /context_length_exceeded.*input is too large/,
    );
  });
});

// These exercise the shared transport directly, without a host or Codex CLI.
describe('subscription transport contracts', () => {
  test('requires explicit subscription credentials, even with an API key', () => {
    expect(() => new OpenAIResponsesAPIAdapter({ mode: 'subscription', apiKey: 'sk-api' }))
      .toThrow('credential resolver');
  });

  test('resolves token and account headers again for every call and retry', async () => {
    const attempts: Array<{ auth: string | null; account: string | null; body: string }> = [];
    const flags: boolean[] = [];
    globalThis.fetch = async (_input, init) => {
      const headers = new Headers(init?.headers);
      attempts.push({ auth: headers.get('authorization'), account: headers.get('chatgpt-account-id'), body: String(init?.body) });
      return attempts.length === 1 ? new Response('expired', { status: 401 }) : completedResponse();
    };
    const adapter = new OpenAIResponsesAPIAdapter({
      mode: 'subscription',
      extraHeaders: { authorization: 'Bearer stale' },
      credentials: ({ forceRefresh }) => {
        flags.push(forceRefresh);
        return { token: `token-${flags.length}`, headers: { 'ChatGPT-Account-Id': `account-${flags.length}` } };
      },
    });
    await adapter.complete(request());
    await adapter.complete(request());
    expect(flags).toEqual([false, true, false]);
    expect(attempts.map(({ auth, account }) => [auth, account])).toEqual([
      ['Bearer token-1', 'account-1'], ['Bearer token-2', 'account-2'], ['Bearer token-3', 'account-3'],
    ]);
    expect(attempts[0]?.body).toBe(attempts[1]?.body);
  });

  test.each([401, 403, 429, 503])('bounds auth retry for HTTP %s', async (status) => {
    const flags: boolean[] = [];
    globalThis.fetch = async () => new Response('rejected', { status });
    const adapter = new OpenAIResponsesAPIAdapter({
      mode: 'subscription',
      credentials: ({ forceRefresh }) => { flags.push(forceRefresh); return { token: 'token' }; },
    });
    await expect(adapter.complete(request())).rejects.toMatchObject({ httpStatus: status });
    expect(flags).toEqual(status === 401 ? [false, true] : [false]);
  });

  test('does not retry an authentication error after stream output', async () => {
    let resolutions = 0;
    const chunks: string[] = [];
    globalThis.fetch = async () => new Response([
      'data: {"type":"response.output_text.delta","output_index":0,"delta":"partial"}\n\n',
      'data: {"type":"error","error":{"code":"invalid_api_key","message":"expired"}}\n\n',
    ].join(''));
    const adapter = new OpenAIResponsesAPIAdapter({ mode: 'subscription', credentials: () => {
      resolutions++; return { token: 'token' };
    } });
    await expect(adapter.stream(request(), { onChunk: chunk => chunks.push(chunk) })).rejects.toMatchObject({ type: 'auth' });
    expect(chunks).toEqual(['partial']);
    expect(resolutions).toBe(1);
  });

  test('cancels while credentials are pending without making an HTTP request', async () => {
    const controller = new AbortController();
    let fetches = 0;
    globalThis.fetch = async () => { fetches++; return completedResponse(); };
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const adapter = new OpenAIResponsesAPIAdapter({ mode: 'subscription', credentials: () => {
      entered(); return new Promise(() => {});
    } });
    const result = adapter.complete(request(), { signal: controller.signal });
    await started;
    controller.abort();
    await expect(result).rejects.toMatchObject({ type: 'abort' });
    expect(fetches).toBe(0);
  });

  test('applies the request deadline to credential resolution', async () => {
    const adapter = new OpenAIResponsesAPIAdapter({ mode: 'subscription', credentials: () => new Promise(() => {}) });
    await expect(adapter.complete(request(), { timeoutMs: 10 })).rejects.toMatchObject({ type: 'timeout' });
  });

  test('preserves native replay metadata and reconstructs normalized encrypted reasoning', async () => {
    let input: unknown;
    globalThis.fetch = async (_url, init) => { input = JSON.parse(String(init?.body)).input; return completedResponse(); };
    const native = [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Policy' }] },
      { type: 'message', role: 'assistant', id: 'm1', phase: 'commentary', status: 'completed', content: [{ type: 'output_text', text: 'Checking', annotations: [] }] },
      { type: 'reasoning', id: 'r1', summary: [], encrypted_content: 'cipher' },
      { type: 'compaction', id: 'c1', encrypted_content: 'compact' },
    ];
    const adapter = new OpenAIResponsesAPIAdapter({ mode: 'subscription', credentials: () => ({ token: 't' }) });
    await adapter.complete({ ...request(), messages: [...native, { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'other' }] }] });
    expect(input).toEqual([...native, { type: 'reasoning', summary: [], encrypted_content: 'other' }]);
  });

  test('parses chunk-split multiline SSE, no-space data fields, CRLF, and EOF tails', async () => {
    const event = JSON.stringify({ type: 'response.completed', response: {
      status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'héllo' }] }],
    } });
    const wire = new TextEncoder().encode(': comment\r\ndata:' + event.replace(',"response":', ',\r\ndata: "response":'));
    globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) {
      for (const byte of wire) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    } }));
    const adapter = new OpenAIResponsesAPIAdapter({ mode: 'subscription', credentials: () => ({ token: 't' }) });
    const result = await adapter.complete(request());
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'héllo' });
  });

  test('warns once when priority is declined and exposes Fast mode controls', async () => {
    const tiers: string[] = [];
    globalThis.fetch = async () => new Response('data: {"type":"response.completed","response":{"status":"completed","output":[],"service_tier":"default"}}\n\n');
    const adapter = new OpenAIResponsesAPIAdapter({ mode: 'subscription', credentials: () => ({ token: 't' }), fastMode: true, onFastModeFallback: tier => tiers.push(tier) });
    await adapter.complete(request());
    await adapter.complete(request());
    expect(tiers).toEqual(['default']);
    expect(adapter.isFastMode()).toBe(true);
    adapter.setFastMode(false);
    expect(adapter.isFastMode()).toBe(false);
  });
});

for (const streaming of [false, true]) {
  test(`normalizes cached usage exactly once through Membrane (${streaming ? 'stream' : 'complete'})`, async () => {
    globalThis.fetch = async () => new Response(`data: ${JSON.stringify({ type: 'response.completed', response: {
      status: 'completed', model: 'gpt-5.4',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }],
      usage: { input_tokens: 100, output_tokens: 2, input_tokens_details: { cached_tokens: 80 } },
    } })}\n\n`);
    const adapter = new OpenAIResponsesAPIAdapter({ mode: 'subscription', credentials: () => ({ token: 'token' }) });
    const direct = await adapter.complete(request());
    expect(adapter.usageCacheConvention).toBe('cache-inclusive');
    expect(direct.usage.inputTokens).toBe(100);
    const membrane = new Membrane(adapter, { formatter: new OpenAIResponsesFormatter() });
    const normalized = { messages: [{ participant: 'user', content: [{ type: 'text' as const, text: 'hello' }] }], config: { model: 'gpt-5.4', maxTokens: 100 } };
    const response = streaming ? await membrane.stream(normalized, { onChunk: () => {} }) : await membrane.complete(normalized);
    expect(response.usage.inputTokens).toBe(20);
    expect(response.usage.cacheReadTokens).toBe(80);
  });
}

test('supports dynamic credentials on the ordinary JSON API path too', async () => {
  const flags: boolean[] = [];
  const bodies: any[] = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return bodies.length === 1 ? new Response('expired', { status: 401 }) : new Response(JSON.stringify({ output: [], status: 'completed' }));
  };
  const adapter = new OpenAIResponsesAPIAdapter({ credentials: ({ forceRefresh }) => { flags.push(forceRefresh); return { token: 't' }; } });
  await adapter.complete(request());
  expect(flags).toEqual([false, true]);
  expect(bodies[1].stream).toBeUndefined();
  expect(bodies[1].max_output_tokens).toBe(8192);
  expect(bodies[1].temperature).toBe(0.2);
});

test('does not retry a static API key', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('expired', { status: 401 }); };
  await expect(new OpenAIResponsesAPIAdapter({ apiKey: 'sk-test' }).complete(request())).rejects.toMatchObject({ type: 'auth' });
  expect(calls).toBe(1);
});

test('replays historical encrypted reasoning through the formatter with a required summary', async () => {
  let input: unknown;
  globalThis.fetch = async (_url, init) => {
    input = JSON.parse(String(init?.body)).input;
    return completedResponse();
  };
  const membrane = new Membrane(new OpenAIResponsesAPIAdapter({
    mode: 'subscription', credentials: () => ({ token: 'fixture' }),
  }), { formatter: new OpenAIResponsesFormatter(), assistantParticipant: 'assistant' });
  await membrane.complete({
    messages: [
      { participant: 'user', content: [{ type: 'text', text: 'Continue' }] },
      { participant: 'assistant', content: [{ type: 'redacted_thinking', data: 'historic-cipher' }] },
      { participant: 'user', content: [{ type: 'text', text: 'What next?' }] },
    ],
    config: { model: 'gpt-5.4', maxTokens: 64 },
  });
  expect(input).toEqual(expect.arrayContaining([
    { type: 'reasoning', encrypted_content: 'historic-cipher', summary: [] },
  ]));
});
