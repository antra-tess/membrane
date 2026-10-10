/**
 * Thinking-binding controls and their report (context-manager #155).
 *
 * Anthropic binds each signed thinking block to the conversation before it.
 * `thinking.blockBinding` says what the API does with one that fails that
 * check ('drop_block' removes it, 'error' fails the request), and with the
 * `thinking-binding-controls-2026-08-01` beta every response reports, as
 * `input_transformations`, the blocks that failed a binding check: dropped,
 * or shown anyway where the check isn't enforced. Membrane sends the
 * controls, carries the provider's report on ProviderResponse, and on
 * yielding streams places each entry in the consumer's coordinates
 * (RoundReport.thinking).
 *
 * Shapes are the API's as a live probe through the house's router showed
 * them (Opus 5.5, 2026-10-10): `{type: 'thinking_dropped', reason:
 * 'prefix_binding_mismatch', path: 'messages.1.content.0'}`, one entry per
 * block, `[]` when nothing failed.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { AnthropicAdapter, readInputTransformations } from '../../src/providers/anthropic.js';
import { BedrockAdapter } from '../../src/providers/bedrock.js';
import { chunkFrame, streamBody } from '../helpers/bedrock-event-stream.js';
import type {
  ContentBlock,
  NormalizedMessage,
  NormalizedRequest,
  ProviderAdapter,
  ProviderInputTransformation,
  ProviderRequest,
  ProviderRequestOptions,
  ProviderResponse,
  RoundReport,
  StreamCallbacks,
  ToolDefinition,
} from '../../src/types/index.js';
import type { InjectedMessage } from '../../src/types/yielding-stream.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const BETA = 'thinking-binding-controls-2026-08-01';
const DROP = { prefixMismatchBehavior: 'drop_block' as const };
const noopTool: ToolDefinition = { name: 'noop', description: 'A no-op tool.', inputSchema: { type: 'object', properties: {} } };

const thinking = (signature: string): ContentBlock => ({ type: 'thinking', thinking: '', signature } as ContentBlock);
const text = (t: string): ContentBlock => ({ type: 'text', text: t });
const user = (t: string): NormalizedMessage => ({ participant: 'User', content: [text(t)] });
const reply = (...content: ContentBlock[]): NormalizedMessage => ({ participant: 'Claude', content });

interface Turn {
  content: unknown[];
  stopReason: string;
  /** Report entries by path; each is resolved against the request as sent. */
  report?: Array<{ type: string; reason: string; path: string }>;
}

/** A native adapter that plays a script, and reports binding entries as the real adapters do: with the request's own block at each path. */
class BindingAdapter implements ProviderAdapter {
  readonly name = 'binding-scripted';
  readonly reportsContentAlterations = true;
  requests: ProviderRequest[] = [];
  constructor(private turns: Turn[]) {}
  supportsModel(): boolean {
    return true;
  }
  async complete(): Promise<ProviderResponse> {
    throw new Error('not used');
  }
  async stream(request: ProviderRequest, callbacks: StreamCallbacks, _options?: ProviderRequestOptions): Promise<ProviderResponse> {
    this.requests.push(request);
    const turn = this.turns.shift();
    if (!turn) throw new Error('no scripted turn left');
    for (const block of turn.content as Array<{ type: string; text?: string }>) if (block.type === 'text') callbacks.onChunk(block.text!);
    return {
      content: turn.content,
      stopReason: turn.stopReason,
      usage: { inputTokens: 10, outputTokens: 2 },
      model: request.model,
      raw: {},
      ...(turn.report ? readInputTransformations(turn.report, request.messages) : {}),
    };
  }
}

function request(messages: NormalizedMessage[], extra: Partial<NormalizedRequest['config']> = {}): NormalizedRequest {
  return {
    messages,
    config: { model: 'claude-opus-5-5', maxTokens: 4000, thinking: { enabled: true, budgetTokens: 2000, blockBinding: DROP }, ...extra },
    tools: [noopTool],
    toolMode: 'native',
  };
}

async function rounds(membrane: Membrane, req: NormalizedRequest, inject: Array<InjectedMessage[] | undefined> = []): Promise<RoundReport[]> {
  const stream = membrane.streamYielding(req, {});
  const out: RoundReport[] = [];
  let toolRound = 0;
  for await (const event of stream) {
    if (event.type === 'usage' && event.round) out.push(event.round);
    if (event.type === 'tool-calls') {
      const injectedMessages = inject[toolRound++];
      stream.provideToolResults(event.calls.map((c) => ({ toolUseId: c.id, content: 'ok', isError: false })),
        injectedMessages ? { injectedMessages } : undefined);
    }
  }
  return out;
}

const finalTurn = (report?: Turn['report']): Turn => ({ content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn', ...(report ? { report } : {}) });

describe('the request asks for the controls', () => {
  it('carries block_binding in an enabled or adaptive thinking config, and nothing when unset', async () => {
    const adapter = new BindingAdapter([finalTurn(), finalTurn(), finalTurn()]);
    const membrane = new Membrane(adapter);
    await rounds(membrane, request([user('hi')]));
    await rounds(membrane, request([user('hi')], { thinking: { enabled: true, type: 'adaptive', blockBinding: { prefixMismatchBehavior: 'error' } } }));
    await rounds(membrane, request([user('hi')], { thinking: { enabled: true, budgetTokens: 2000 } }));
    expect(adapter.requests.map((r) => r.thinking)).toEqual([
      { type: 'enabled', budget_tokens: 2000, block_binding: { prefix_mismatch_behavior: 'drop_block' } },
      { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'error' } },
      { type: 'enabled', budget_tokens: 2000 },
    ]);
  });

  it('sends a model whose thinking is always on only the controls, and still no sampling params', async () => {
    const adapter = new BindingAdapter([finalTurn(), finalTurn()]);
    const membrane = new Membrane(adapter);
    await rounds(membrane, request([user('hi')], { model: 'claude-fable-5-1', temperature: 0.3 }));
    await rounds(membrane, request([user('hi')], { model: 'claude-fable-5-1', temperature: 0.3, thinking: { enabled: true, budgetTokens: 2000 } }));
    expect(adapter.requests[0]!.thinking).toEqual({ type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } });
    expect(adapter.requests[1]!.thinking).toBeUndefined();
    expect(adapter.requests.map((r) => r.temperature)).toEqual([undefined, undefined]);
  });

  it('Anthropic: adds the beta to the header when the built request carries the controls, beside the interleaved beta and a default one', async () => {
    const seen: Array<Record<string, string> | undefined> = [];
    const adapter = new AnthropicAdapter({ apiKey: 'sk-test', cacheKeepalive: { enabled: false }, defaultHeaders: { 'anthropic-beta': 'oauth-2025-04-20' } });
    (adapter as any).client = { messages: { create: async (_body: unknown, opts: { headers?: Record<string, string> }) => {
      seen.push(opts.headers);
      return { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', model: 'm', usage: { input_tokens: 1, output_tokens: 1 } };
    } } };
    const base = { messages: [{ role: 'user', content: 'hi' }], maxTokens: 4000 } as const;
    const binding = { type: 'enabled', budget_tokens: 2000, block_binding: { prefix_mismatch_behavior: 'drop_block' } };
    await adapter.complete({ ...base, model: 'claude-opus-5-5', thinking: binding } as any);
    await adapter.complete({ ...base, model: 'claude-opus-4-5', thinking: binding } as any);
    // A thinking config passed through `extra` is what goes out, so it counts.
    await adapter.complete({ ...base, model: 'claude-opus-5-5', extra: { thinking: binding } } as any);
    await adapter.complete({ ...base, model: 'claude-opus-5-5', thinking: { type: 'enabled', budget_tokens: 2000 } } as any);
    expect(seen.map((h) => h?.['anthropic-beta'])).toEqual([
      `oauth-2025-04-20,${BETA}`,
      `oauth-2025-04-20,interleaved-thinking-2025-05-14,${BETA}`,
      `oauth-2025-04-20,${BETA}`,
      undefined,
    ]);
  });

  it('Bedrock: adds the beta to anthropic_beta, merged with the caller\'s', () => {
    const adapter = new BedrockAdapter({ accessKeyId: 'k', secretAccessKey: 's', region: 'us-east-1' }) as any;
    const built = adapter.buildRequest({
      model: 'claude-opus-4-5', maxTokens: 4000, messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'enabled', budget_tokens: 2000, block_binding: { prefix_mismatch_behavior: 'drop_block' } },
      extra: { anthropic_beta: ['context-1m-2025-08-07'] },
    });
    expect(built.anthropic_beta).toEqual(['context-1m-2025-08-07', 'interleaved-thinking-2025-05-14', BETA]);
    const plain = adapter.buildRequest({ model: 'claude-opus-5-5', maxTokens: 4000, messages: [{ role: 'user', content: 'hi' }] });
    expect(plain.anthropic_beta).toBeUndefined();
  });
});

/** An async iterable of SSE events with the surface the Anthropic adapter touches. */
function fakeStream(events: unknown[]) {
  return {
    controller: { abort() {} },
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
  };
}

const streamed = (start: unknown, deltaExtra: Record<string, unknown> = {}) => [
  { type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 9 }, ...(start === undefined ? {} : { input_transformations: start }) } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 }, ...deltaExtra },
];

describe('the adapters carry the provider\'s report', () => {
  const sentThinking = { type: 'thinking', thinking: '', signature: 'S1' };
  const wire = () => ({
    model: 'claude-opus-5-5', maxTokens: 4000,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'u1' }] },
      { role: 'assistant', content: [sentThinking, { type: 'text', text: 'a1' }] },
      { role: 'user', content: [{ type: 'text', text: 'u2' }] },
    ],
    thinking: { type: 'enabled', budget_tokens: 2000, block_binding: { prefix_mismatch_behavior: 'drop_block' } },
  });
  const dropped = [{ type: 'thinking_dropped', reason: 'prefix_binding_mismatch', path: 'messages.1.content.0' }];

  it('Anthropic, streamed: from message_start, each entry with the request\'s own block, and in the raw response', async () => {
    const adapter = new AnthropicAdapter({ apiKey: 'sk-test', cacheKeepalive: { enabled: false } });
    (adapter as any).client = { messages: { stream: async () => fakeStream(streamed(dropped)) } };
    const response = await adapter.stream(wire() as any, { onChunk: () => {} });
    expect(response.inputTransformations).toEqual([{ ...dropped[0], block: sentThinking }]);
    expect(response.inputTransformations![0]!.block).toBe(sentThinking);
    expect((response.raw as { input_transformations?: unknown }).input_transformations).toEqual(dropped);
  });

  it('Anthropic, streamed: a message_delta\'s report replaces message_start\'s (a server-side fallback)', async () => {
    const adapter = new AnthropicAdapter({ apiKey: 'sk-test', cacheKeepalive: { enabled: false } });
    const served = [{ type: 'thinking_mismatch_allowed', reason: 'prefix_binding_mismatch', path: 'messages.1.content.0' }];
    (adapter as any).client = { messages: { stream: async () => fakeStream(streamed(dropped, { input_transformations: served })) } };
    const response = await adapter.stream(wire() as any, { onChunk: () => {} });
    expect(response.inputTransformations!.map((e) => e.type)).toEqual(['thinking_mismatch_allowed']);
  });

  it('Anthropic: an empty report is an empty list, and no report is none', async () => {
    const adapter = new AnthropicAdapter({ apiKey: 'sk-test', cacheKeepalive: { enabled: false } });
    (adapter as any).client = { messages: { stream: async () => fakeStream(streamed([])) } };
    expect((await adapter.stream(wire() as any, { onChunk: () => {} })).inputTransformations).toEqual([]);
    (adapter as any).client = { messages: { stream: async () => fakeStream(streamed(undefined)) } };
    const none = await adapter.stream(wire() as any, { onChunk: () => {} });
    expect(none.inputTransformations).toBeUndefined();
    expect('input_transformations' in (none.raw as object)).toBe(false);
  });

  it('Anthropic, unstreamed: from the response body', async () => {
    const adapter = new AnthropicAdapter({ apiKey: 'sk-test', cacheKeepalive: { enabled: false } });
    (adapter as any).client = { messages: { create: async () => ({
      content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', model: 'claude-opus-5-5',
      usage: { input_tokens: 9, output_tokens: 1 }, input_transformations: dropped,
    }) } };
    const response = await adapter.complete(wire() as any);
    expect(response.inputTransformations).toEqual([{ ...dropped[0], block: sentThinking }]);
  });

  it('keeps an entry type it doesn\'t know, and a path it can\'t resolve, without a block', () => {
    const { inputTransformations } = readInputTransformations(
      [{ type: 'connector_rewritten', reason: 'x', path: 'messages.9.content.0' }, { type: 'thinking_dropped', path: 'system.0' }, 'junk'],
      wire().messages,
    );
    expect(inputTransformations).toEqual([
      { type: 'connector_rewritten', reason: 'x', path: 'messages.9.content.0' },
      { type: 'thinking_dropped', path: 'system.0' },
    ]);
  });

  it('Bedrock, streamed: from message_start, with the request\'s own block', async () => {
    const frames = [
      chunkFrame({ type: 'message_start', message: { usage: { input_tokens: 9 }, input_transformations: dropped } }),
      chunkFrame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      chunkFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }),
      chunkFrame({ type: 'content_block_stop', index: 0 }),
      chunkFrame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }),
      chunkFrame({ type: 'message_stop' }),
    ];
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, body: streamBody(frames) }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new BedrockAdapter({ accessKeyId: 'k', secretAccessKey: 's', region: 'us-east-1' });
    const sent = wire();
    const response = await adapter.stream(sent as any, { onChunk: () => {} });
    expect(response.inputTransformations).toEqual([{ ...dropped[0], block: sentThinking }]);
    expect(response.inputTransformations![0]!.block).toBe(sent.messages[1]!.content[0]);
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [unknown, { body: string }])[1].body);
    expect(body.anthropic_beta).toEqual([BETA]);
  });
});

describe('yielding rounds place each entry in the consumer\'s coordinates', () => {
  it('names the submitted message and its block, through a merge that moves the block', async () => {
    // Two assistant messages travel as one provider message: S2's block is
    // content 1 of messages.1 on the wire, and block 0 of message 2 here.
    const messages = [user('u1'), reply(text('note')), reply(thinking('S2'), text('a2')), user('u3')];
    const adapter = new BindingAdapter([finalTurn([
      { type: 'thinking_dropped', reason: 'prefix_binding_mismatch', path: 'messages.1.content.1' },
    ])]);
    const [round] = await rounds(new Membrane(adapter), request(messages));
    expect(adapter.requests[0]!.messages).toHaveLength(3);
    expect(round!.thinking).toEqual({
      dropped: [{ reason: 'prefix_binding_mismatch', path: 'messages.1.content.1', message: 2, block: 0 }],
      mismatchAllowed: [],
    });
    // The provider's account is beside membrane's: the request carried the block.
    expect(round!.altered).toEqual({ messages: [], injected: [] });
  });

  it('names an earlier round of the stream for its own assistant content, and lists what was shown anyway', async () => {
    const adapter = new BindingAdapter([
      { content: [{ type: 'thinking', thinking: '', signature: 'R0' }, { type: 'tool_use', id: 't1', name: 'noop', input: {} }], stopReason: 'tool_use', report: [] },
      finalTurn([{ type: 'thinking_mismatch_allowed', reason: 'prefix_binding_mismatch', path: 'messages.1.content.0' }]),
    ]);
    const reports = await rounds(new Membrane(adapter), request([user('go')]));
    expect(reports[0]!.thinking).toEqual({ dropped: [], mismatchAllowed: [] });
    expect(reports[1]!.thinking).toEqual({
      dropped: [],
      mismatchAllowed: [{ reason: 'prefix_binding_mismatch', path: 'messages.1.content.0', round: 0, block: 0 }],
    });
  });

  it('names an injected message', async () => {
    const adapter = new BindingAdapter([
      { content: [{ type: 'tool_use', id: 't1', name: 'noop', input: {} }], stopReason: 'tool_use' },
      // go | (tool_use) | (tool_result + injected, merged as one user message) ... the injected
      // reply is an assistant message here, so it travels on its own.
      finalTurn([{ type: 'thinking_dropped', reason: 'prefix_binding_mismatch', path: 'messages.3.content.0' }]),
    ]);
    const reports = await rounds(new Membrane(adapter), request([user('go')]), [
      [{ participant: 'Claude', content: [thinking('I1'), text('carried in')] }],
    ]);
    expect(adapter.requests[1]!.messages.map((m) => (m as { role: string }).role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(reports[1]!.thinking!.dropped).toEqual([
      { reason: 'prefix_binding_mismatch', path: 'messages.3.content.0', injected: [0, 0], block: 0 },
    ]);
  });

  it('names no block when two blocks of the message carry the same signature', async () => {
    const twice = reply(thinking('S2'), thinking('S2'), text('a2'));
    const adapter = new BindingAdapter([finalTurn([
      { type: 'thinking_dropped', reason: 'prefix_binding_mismatch', path: 'messages.1.content.1' },
    ])]);
    const [round] = await rounds(new Membrane(adapter), request([user('u1'), twice, user('u2')]));
    expect(round!.thinking!.dropped).toEqual([{ reason: 'prefix_binding_mismatch', path: 'messages.1.content.1', message: 1 }]);
  });

  it('keeps an entry it can\'t place with the provider\'s path alone, and leaves out a type it doesn\'t know', async () => {
    const adapter = new BindingAdapter([finalTurn([
      { type: 'thinking_dropped', reason: 'organization_binding_mismatch', path: 'messages.7.content.0' },
      { type: 'connector_rewritten', reason: 'x', path: 'messages.0.content.0' },
    ])]);
    const [round] = await rounds(new Membrane(adapter), request([user('hi')]));
    expect(round!.thinking).toEqual({
      dropped: [{ reason: 'organization_binding_mismatch', path: 'messages.7.content.0' }],
      mismatchAllowed: [],
    });
  });

  it('has no thinking report when the response carried none', async () => {
    const [round] = await rounds(new Membrane(new BindingAdapter([finalTurn()])), request([user('hi')]));
    expect(round!.thinking).toBeUndefined();
  });

  it('carries the report on the XML path too', async () => {
    const adapter = new BindingAdapter([finalTurn([
      { type: 'thinking_dropped', reason: 'prefix_binding_mismatch', path: 'messages.5.content.0' },
    ])]);
    const req = request([user('hi')]);
    delete req.toolMode;
    const [round] = await rounds(new Membrane(adapter), req);
    expect(round!.thinking!.dropped).toEqual([{ reason: 'prefix_binding_mismatch', path: 'messages.5.content.0' }]);
  });
});
