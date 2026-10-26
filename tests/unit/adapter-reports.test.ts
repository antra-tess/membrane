import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { BedrockAdapter } from '../../src/providers/bedrock.js';
import { chunkFrame, streamBody } from '../helpers/bedrock-event-stream.js';
import type { ProviderRequest, ProviderRequestOptions, SendReport } from '../../src/types/index.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const EVENTS = [
  { type: 'message_start', message: { id: 'msg_zz', type: 'message', role: 'assistant', model: 'claude-zz', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'zz' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'zzsig' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'zzdata' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'zz' } },
  { type: 'content_block_stop', index: 2 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
];
const SEEN = [undefined, 'think', 'content', 'content', undefined, 'content', undefined, undefined, 'content', undefined, undefined];

const DISPLAYS = [undefined, 'omitted', 'updates', 'summarized'] as const;
const thinkingFor = (display: (typeof DISPLAYS)[number]): Partial<ProviderRequest> =>
  display === undefined ? {} : { thinking: { type: 'enabled', budget_tokens: 100, display } };
const startSeen = (display: (typeof DISPLAYS)[number]): string | undefined => (display === 'summarized' ? undefined : 'think');

const REQUEST: ProviderRequest = {
  model: 'claude-sonnet-4-5',
  messages: [{ role: 'user', content: 'zz hello' }],
  maxTokens: 64,
  extra: { max_tokens: 333 },
};
const WIRE_SUMMARIZED: ProviderRequest = {
  ...REQUEST,
  thinking: { type: 'enabled', budget_tokens: 100, display: 'omitted' },
  extra: { ...REQUEST.extra, thinking: { type: 'enabled', budget_tokens: 100, display: 'summarized' } },
};

function observed() {
  const sends: SendReport[] = [];
  const seen: Array<string | undefined> = [];
  let body: { max_tokens?: unknown } | undefined;
  const options: ProviderRequestOptions = {
    onRequest: (raw) => { body = raw as { max_tokens?: unknown }; },
    onSend: (send) => { sends.push(send); },
    onProgress: (kind) => { seen.push(kind); },
  };
  return { options, sends, seen, body: () => body };
}

function anthropicStreaming(events: unknown[], sends?: SendReport[], reportsAtSend: number[] = []) {
  const adapter = new AnthropicAdapter({ apiKey: 'zz-key', cacheKeepalive: { enabled: false } });
  (adapter as any).client = {
    withOptions() { return this; },
    messages: {
      stream: async () => (reportsAtSend.push(sends?.length ?? -1), {
        controller: { abort() {} },
        async *[Symbol.asyncIterator]() { yield* events; },
      }),
      create: async () => (reportsAtSend.push(sends?.length ?? -1), {
        id: 'msg_zz', type: 'message', role: 'assistant', model: 'claude-zz',
        content: [{ type: 'text', text: 'zz' }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    },
  };
  return adapter;
}

function bedrock() {
  return new BedrockAdapter({ accessKeyId: 'zz-key', secretAccessKey: 'zz-secret', region: 'us-east-1' });
}

describe('AnthropicAdapter', () => {
  it('stream(): reports the body\'s max_tokens and that it reports content before the send, then each content event and thinking block\'s start', async () => {
    const o = observed();
    const atSend: number[] = [];
    await anthropicStreaming(EVENTS, o.sends, atSend).stream(REQUEST, { onChunk: () => {} }, o.options);

    expect(atSend).toEqual([1]);
    expect(o.body()!.max_tokens).toBe(333);
    expect(o.sends).toEqual([{ maxTokens: 333, reportsContent: true }]);
    expect(o.seen).toEqual(SEEN);
  });

  it('complete(): reports the body\'s max_tokens before the send, and no content', async () => {
    const o = observed();
    const atSend: number[] = [];
    await anthropicStreaming([], o.sends, atSend).complete(REQUEST, o.options);

    expect(atSend).toEqual([1]);
    expect(o.sends).toEqual([{ maxTokens: 333 }]);
    expect(o.seen).toEqual([]);
  });

  it("stream(): reports a thinking block's start as a think unless the body asks for summarized thinking, whose deltas are content", async () => {
    for (const display of DISPLAYS) {
      const o = observed();
      await anthropicStreaming(EVENTS).stream({ ...REQUEST, ...thinkingFor(display) }, { onChunk: () => {} }, o.options);
      expect((o.body() as { thinking?: { display?: unknown } }).thinking?.display).toBe(display);
      expect(o.seen).toEqual([undefined, startSeen(display), ...SEEN.slice(2)]);
    }
  });

  it("stream(): reads the display from the body it sends, where extra's thinking replaces the request's", async () => {
    const o = observed();
    await anthropicStreaming(EVENTS).stream(WIRE_SUMMARIZED, { onChunk: () => {} }, o.options);
    expect((o.body() as { thinking?: { display?: unknown } }).thinking?.display).toBe('summarized');
    expect(o.seen).toEqual([undefined, undefined, ...SEEN.slice(2)]);
  });
});

describe('BedrockAdapter', () => {
  it('stream(): reports the body\'s max_tokens and that it reports content before the send, then each content event and thinking block\'s start up to message_delta, where reading stops', async () => {
    const o = observed();
    const atSend: number[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => (atSend.push(o.sends.length), { ok: true, status: 200, body: streamBody([...EVENTS, { type: 'message_stop' }].map(chunkFrame)) })));
    await bedrock().stream(REQUEST, { onChunk: () => {} }, o.options);

    expect(atSend).toEqual([1]);
    expect(o.body()!.max_tokens).toBe(333);
    expect(o.sends).toEqual([{ maxTokens: 333, reportsContent: true }]);
    expect(o.seen).toEqual(SEEN);
  });

  it("stream(): reports a thinking block's start as a think unless the body asks for summarized thinking, whose deltas are content", async () => {
    for (const display of DISPLAYS) {
      const o = observed();
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, body: streamBody([...EVENTS, { type: 'message_stop' }].map(chunkFrame)) })));
      await bedrock().stream({ ...REQUEST, ...thinkingFor(display) }, { onChunk: () => {} }, o.options);
      expect((o.body() as { thinking?: { display?: unknown } }).thinking?.display).toBe(display);
      expect(o.seen).toEqual([undefined, startSeen(display), ...SEEN.slice(2)]);
    }
  });

  it("stream(): reads the display from the body it sends, where extra's thinking replaces the request's", async () => {
    const o = observed();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, body: streamBody([...EVENTS, { type: 'message_stop' }].map(chunkFrame)) })));
    await bedrock().stream(WIRE_SUMMARIZED, { onChunk: () => {} }, o.options);
    expect((o.body() as { thinking?: { display?: unknown } }).thinking?.display).toBe('summarized');
    expect(o.seen).toEqual([undefined, undefined, ...SEEN.slice(2)]);
  });

  /** A refusal as AWS's page for the Claude Messages API shows a non-streamed body. */
  const refusedBody = {
    id: 'msg_zz', type: 'message', role: 'assistant', model: 'claude-zz', content: [],
    stop_reason: 'refusal',
    stop_details: { type: 'refusal', category: 'cyber', explanation: 'zz explanation' },
    usage: { input_tokens: 106, output_tokens: 1 },
  };

  it("complete(): reports the body's max_tokens before the send, and the refusal's category as AWS documents the body (our reading of AWS's page, not a live response)", async () => {
    const o = observed();
    const atSend: number[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => (atSend.push(o.sends.length), new Response(JSON.stringify(refusedBody), { status: 200, headers: { 'content-type': 'application/json' } }))));
    const response = await bedrock().complete(REQUEST, o.options);

    expect(atSend).toEqual([1]);
    expect(o.sends).toEqual([{ maxTokens: 333 }]);
    expect(response.stopReason).toBe('refusal');
    expect(response.refusalCategory).toBe('cyber');
  });

  it('complete(): no category without stop_details, or beside a stop that isn\'t a refusal', async () => {
    const { stop_details: _details, ...withoutDetails } = refusedBody;
    for (const body of [withoutDetails, { ...refusedBody, stop_reason: 'end_turn' }]) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })));
      const response = await bedrock().complete(REQUEST);
      expect(Object.keys(response)).not.toContain('refusalCategory');
    }
  });

  it("stream(): reads a refusal's category from its message_delta when it's there, as AnthropicAdapter does (AWS's page doesn't show it in the stream, so it may never come)", async () => {
    const refusalDelta = (delta: Record<string, unknown>) => [
      EVENTS[0],
      { type: 'message_delta', delta: { stop_reason: 'refusal', ...delta }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ].map(chunkFrame);

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, body: streamBody(refusalDelta({ stop_details: { type: 'refusal', category: 'cyber' } })) })));
    const withDetails = await bedrock().stream(REQUEST, { onChunk: () => {} });
    expect(withDetails.stopReason).toBe('refusal');
    expect(withDetails.refusalCategory).toBe('cyber');
    expect((withDetails.raw as { stop_details?: unknown }).stop_details).toEqual({ type: 'refusal', category: 'cyber' });

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, body: streamBody(refusalDelta({})) })));
    const without = await bedrock().stream(REQUEST, { onChunk: () => {} });
    expect(without.stopReason).toBe('refusal');
    expect(Object.keys(without)).not.toContain('refusalCategory');
    expect(Object.keys(without.raw as object)).not.toContain('stop_details');
  });
});
