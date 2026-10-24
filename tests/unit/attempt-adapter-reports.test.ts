/**
 * What the Anthropic and Bedrock adapters report for the attempt record: as
 * they send, the `max_tokens` the body carries and whether the stream reports
 * content (`onSend`); then, per parsed event, whether it was content
 * (`onProgress('content')`). And Bedrock's refusal category, which AWS
 * documents on a non-streamed body only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { BedrockAdapter } from '../../src/providers/bedrock.js';
import { Membrane } from '../../src/membrane.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { chunkFrame, streamBody } from '../helpers/bedrock-event-stream.js';
import type { AttemptRecord, ProviderRequest, ProviderRequestOptions, SendReport } from '../../src/types/index.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** One response's events: a silent think's start, its signature, a redacted think, then text. */
const EVENTS = [
  { type: 'message_start', message: { id: 'msg_zz', type: 'message', role: 'assistant', model: 'claude-zz', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'zzsig' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'zzdata' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'zz' } },
  { type: 'content_block_stop', index: 2 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
];
/** What each event above is reported as. */
const SEEN = [undefined, undefined, 'content', undefined, 'content', undefined, undefined, 'content', undefined, undefined];

const REQUEST: ProviderRequest = {
  model: 'claude-sonnet-4-5',
  messages: [{ role: 'user', content: 'zz hello' }],
  maxTokens: 64,
  extra: { max_tokens: 333 },
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

/**
 * A real AnthropicAdapter over a stubbed SDK client. `sends`, when given, is
 * read as the SDK is called, into `reportsAtSend`, so a test can tell the
 * send report came first.
 */
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
  it('stream(): reports the body\'s max_tokens and that it reports content before the send, then each content event', async () => {
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

  it('through Membrane, the record has its first content and its limit', async () => {
    const records: AttemptRecord[] = [];
    const membrane = new Membrane(anthropicStreaming(EVENTS), { formatter: new NativeFormatter(), onAttempt: (r) => { records.push(r); } });

    await membrane.stream({
      messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz hello' }] }],
      config: { model: 'claude-sonnet-4-5', maxTokens: 64 },
      toolMode: 'native',
    });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-4-5', reportsContent: true, maxTokens: 64 });
    expect(records[0]!.firstContentMs).toBeTypeOf('number');
    expect(records[0]!.firstEventMs).toBeLessThanOrEqual(records[0]!.firstContentMs!);
  });
});

describe('BedrockAdapter', () => {
  it('stream(): reports the body\'s max_tokens and that it reports content before the send, then each content event', async () => {
    const o = observed();
    const atSend: number[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => (atSend.push(o.sends.length), { ok: true, status: 200, body: streamBody([...EVENTS, { type: 'message_stop' }].map(chunkFrame)) })));
    await bedrock().stream(REQUEST, { onChunk: () => {} }, o.options);

    expect(atSend).toEqual([1]);
    expect(o.body()!.max_tokens).toBe(333);
    expect(o.sends).toEqual([{ maxTokens: 333, reportsContent: true }]);
    // Reading stops at message_delta, so message_stop is never an event.
    expect(o.seen).toEqual(SEEN);
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

  it("stream(): reports no category, since AWS's page doesn't document it in the stream's events", async () => {
    const frames = [
      EVENTS[0],
      { type: 'message_delta', delta: { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ].map(chunkFrame);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, body: streamBody(frames) })));
    const response = await bedrock().stream(REQUEST, { onChunk: () => {} });

    expect(response.stopReason).toBe('refusal');
    expect(Object.keys(response)).not.toContain('refusalCategory');
  });
});
