/**
 * Round reports (UsageEvent.round) and ToolContext.supportsInjectedMessages.
 *
 * A consumer that needs to know what a round's request actually carried —
 * agent-framework's receipt clocks are the first — reads one report per
 * provider round whose response stands. The contract:
 *
 *   - `altered` names consumer messages the request did not carry verbatim,
 *     in the consumer's coordinates: `NormalizedRequest.messages` indices,
 *     and `[batch, index]` for injected messages, for every batch still
 *     retained in the request, resolved before role merging.
 *   - `fidelity` is 'unknown' whenever an empty list would prove nothing:
 *     an uninstrumented path, opt-in image shedding, a beforeRequest hook
 *     that changed either of its arguments (and every round after one that
 *     changed one in place), an adapter alteration that could not be
 *     attributed.
 *   - `injectedBatch.applied` is the ordered prefix of the newest batch's
 *     supplied positions the round accounts for: its whole supplied size
 *     natively, and 0 on the XML prefill path. With established fidelity, a
 *     position not carried verbatim is in `altered` (even one whose stripped
 *     tool blocks left nothing to send).
 *   - `usage` is the round's own; an unreported field is absent, a reported
 *     0 is 0.
 *   - where a path sends a provider-native raw form (`rawItem`,
 *     `openaiResponsesItems`, `rawXml`) in place of the fields it stands in
 *     for, verbatim is measured against the raw form; a zero-width carrier
 *     (`''` text holding an object `rawItem`) that a path leaves out alters
 *     its message.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { MockAdapter } from '../../src/providers/mock.js';
import { OpenAIAdapter } from '../../src/providers/openai.js';
import { OpenAIResponsesAPIAdapter } from '../../src/providers/openai-responses-api.js';
import { GeminiAdapter } from '../../src/providers/gemini.js';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { normalizeResponsesInput } from '../../src/providers/responses-input.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { CompletionsFormatter } from '../../src/formatters/completions.js';
import { AnthropicXmlFormatter } from '../../src/formatters/anthropic-xml.js';
import { OpenAIResponsesFormatter } from '../../src/formatters/openai-responses.js';
import { FidelityNotes } from '../../src/utils/fidelity.js';
import { stubFetchWithSseLines } from '../helpers/sse-fixtures.js';
import type {
  ContentBlock,
  NormalizedRequest,
  ProviderAdapter,
  ProviderRequest,
  ProviderRequestOptions,
  ProviderResponse,
  RoundReport,
  StreamCallbacks,
  StreamEvent,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../../src/types/index.js';
import type { InjectedMessage } from '../../src/types/yielding-stream.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const noopTool: ToolDefinition = {
  name: 'noop',
  description: 'A no-op tool used to force tool rounds.',
  inputSchema: { type: 'object', properties: {} },
};

/** An image no provider accepts: every builder substitutes a placeholder. */
const svgImage: ContentBlock = {
  type: 'image',
  source: { type: 'base64', mediaType: 'image/svg+xml', data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64') },
} as ContentBlock;

interface ScriptedTurn {
  content: unknown[];
  stopReason: string;
  usage?: ProviderResponse['usage'];
  /** Call options.onContentAltered while serving this turn. */
  alterContent?: boolean;
}

/** Native-mode adapter that plays a script and records what it was sent. */
class ScriptedAdapter implements ProviderAdapter {
  readonly name = 'scripted';
  readonly reportsContentAlterations: boolean;
  requests: ProviderRequest[] = [];
  private turns: ScriptedTurn[];

  constructor(turns: ScriptedTurn[], options: { instrumented?: boolean } = {}) {
    this.turns = [...turns];
    this.reportsContentAlterations = options.instrumented ?? true;
  }

  supportsModel(): boolean {
    return true;
  }

  async complete(): Promise<ProviderResponse> {
    throw new Error('not used');
  }

  async stream(request: ProviderRequest, callbacks: StreamCallbacks, options?: ProviderRequestOptions): Promise<ProviderResponse> {
    this.requests.push(JSON.parse(JSON.stringify(request)));
    const turn = this.turns.shift();
    if (!turn) throw new Error('no scripted turn left');
    if (turn.alterContent) options?.onContentAltered?.();
    for (const block of turn.content) {
      if ((block as { type?: string }).type === 'text') callbacks.onChunk((block as { text: string }).text);
    }
    return {
      content: turn.content,
      stopReason: turn.stopReason,
      usage: turn.usage ?? { inputTokens: 10, outputTokens: 10 },
      raw: {},
    };
  }
}

function toolUseTurn(id: string, extra: Partial<ScriptedTurn> = {}): ScriptedTurn {
  return {
    content: [
      { type: 'text', text: 'working' },
      { type: 'tool_use', id, name: 'noop', input: {} },
    ],
    stopReason: 'tool_use',
    ...extra,
  };
}

function finalTurn(extra: Partial<ScriptedTurn> = {}): ScriptedTurn {
  return { content: [{ type: 'text', text: 'done.' }], stopReason: 'end_turn', ...extra };
}

function nativeRequest(messages: NormalizedRequest['messages']): NormalizedRequest {
  return { messages, config: { model: 'test-model', maxTokens: 1000 }, tools: [noopTool], toolMode: 'native' };
}

function okResults(event: { calls: Array<{ id: string }> }): ToolResult[] {
  return event.calls.map((c) => ({ toolUseId: c.id, content: 'ok', isError: false }));
}

interface Driven {
  rounds: RoundReport[];
  contexts: ToolContext[];
  events: StreamEvent[];
}

/** Drive a yielding stream; `inject[n]` is supplied with the n-th tool round's results. */
async function drive(
  membrane: Membrane,
  request: NormalizedRequest,
  options: { inject?: Array<InjectedMessage[] | undefined>; streamOptions?: Parameters<Membrane['streamYielding']>[1] } = {},
): Promise<Driven> {
  const stream = membrane.streamYielding(request, options.streamOptions ?? {});
  const out: Driven = { rounds: [], contexts: [], events: [] };
  let toolRound = 0;
  for await (const event of stream) {
    out.events.push(event);
    if (event.type === 'usage' && event.round) out.rounds.push(event.round);
    if (event.type === 'tool-calls') {
      out.contexts.push(event.context);
      const injectedMessages = options.inject?.[toolRound++];
      stream.provideToolResults(okResults(event), injectedMessages ? { injectedMessages } : undefined);
    }
  }
  return out;
}

describe('native yielding rounds', () => {
  it('reports each round that stands: index, stop reason, its own usage, established fidelity', async () => {
    const adapter = new ScriptedAdapter([
      toolUseTurn('t1', { usage: { inputTokens: 100, outputTokens: 7, cacheReadTokens: 0 } }),
      finalTurn({ usage: { inputTokens: 120, outputTokens: 3, cacheReadTokens: 90 } }),
    ]);
    const { rounds, contexts } = await drive(new Membrane(adapter), nativeRequest([
      { participant: 'User', content: [{ type: 'text', text: 'hello' }] },
    ]));
    expect(rounds.map((r) => [r.index, r.stopReason, r.fidelity])).toEqual([
      [0, 'tool_use', 'established'],
      [1, 'end_turn', 'established'],
    ]);
    expect(rounds[0]!.usage).toMatchObject({ inputTokens: 100, outputTokens: 7, cacheReadTokens: 0 });
    expect(rounds[1]!.usage).toMatchObject({ inputTokens: 120, outputTokens: 3, cacheReadTokens: 90 });
    expect(rounds[0]!.usage.cacheCreationTokens).toBeUndefined();
    expect('estimatedCost' in rounds[0]!.usage).toBe(false);
    expect(rounds.every((r) => r.altered.messages.length === 0 && r.altered.injected.length === 0)).toBe(true);
    expect(rounds.every((r) => r.injectedBatch === undefined)).toBe(true);
    expect(contexts[0]!.supportsInjectedMessages).toBe(true);
  });

  it('names only the merged neighbour that lost media, in the consumer\'s coordinates', async () => {
    const adapter = new ScriptedAdapter([finalTurn()]);
    const { rounds } = await drive(new Membrane(adapter), nativeRequest([
      { participant: 'Alice', content: [{ type: 'text', text: 'first, intact' }] },
      { participant: 'Bob', content: [{ type: 'text', text: 'second, with a picture' }, svgImage] },
    ]));
    // Both are user-role and travel in one merged provider message.
    expect(adapter.requests[0]!.messages).toHaveLength(1);
    expect(rounds[0]!.altered).toEqual({ messages: [1], injected: [] });
    expect(rounds[0]!.fidelity).toBe('established');
  });

  it('reports an injected message that lost media, and keeps reporting it while the batch is retained', async () => {
    const adapter = new ScriptedAdapter([toolUseTurn('t1'), toolUseTurn('t2'), finalTurn()]);
    const { rounds } = await drive(new Membrane(adapter), nativeRequest([
      { participant: 'User', content: [{ type: 'text', text: 'go' }] },
    ]), {
      inject: [
        [{ participant: 'Carol', content: [{ type: 'text', text: 'look at this' }, svgImage] }],
        [{ participant: 'Dan', content: [{ type: 'text', text: 'plain' }] }, { participant: 'Erin', content: [{ type: 'text', text: 'also plain' }] }],
      ],
    });
    expect(rounds).toHaveLength(3);
    expect(rounds[0]!.injectedBatch).toBeUndefined();
    expect(rounds[1]!.injectedBatch).toEqual({ batch: 0, applied: 1 });
    expect(rounds[1]!.altered).toEqual({ messages: [], injected: [[0, 0]] });
    // The second batch is the newest now; the first is still in the request and still altered.
    expect(rounds[2]!.injectedBatch).toEqual({ batch: 1, applied: 2 });
    expect(rounds[2]!.altered).toEqual({ messages: [], injected: [[0, 0]] });
  });

  it('reports the attempt that stands after a refusal retry, as one round', async () => {
    const adapter = new ScriptedAdapter([
      { content: [{ type: 'text', text: 'no' }], stopReason: 'refusal', usage: { inputTokens: 50, outputTokens: 1 } },
      finalTurn({ usage: { inputTokens: 51, outputTokens: 4 } }),
    ]);
    const { rounds } = await drive(new Membrane(adapter), nativeRequest([
      { participant: 'User', content: [{ type: 'text', text: 'hello' }] },
    ]), { streamOptions: { refusalRetries: 1 } });
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({ index: 0, stopReason: 'end_turn', usage: { inputTokens: 51, outputTokens: 4 } });
  });

  it('is unknown when the adapter reports altering content without naming a block', async () => {
    const adapter = new ScriptedAdapter([toolUseTurn('t1', { alterContent: true }), finalTurn()]);
    const { rounds } = await drive(new Membrane(adapter), nativeRequest([
      { participant: 'User', content: [{ type: 'text', text: 'hello' }] },
    ]));
    expect(rounds.map((r) => r.fidelity)).toEqual(['unknown', 'established']);
  });

  it('is unknown through an adapter that does not declare it reports alterations', async () => {
    const adapter = new ScriptedAdapter([finalTurn()], { instrumented: false });
    const { rounds } = await drive(new Membrane(adapter), nativeRequest([
      { participant: 'User', content: [{ type: 'text', text: 'hello' }] },
    ]));
    expect(rounds[0]!.fidelity).toBe('unknown');
    expect(rounds[0]!.altered).toEqual({ messages: [], injected: [] });
  });

  it('is unknown when opt-in image shedding removed something', async () => {
    const big = Buffer.alloc(6 * 1024 * 1024, 7).toString('base64');
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');
    const adapter = new ScriptedAdapter([finalTurn()]);
    const huge: ContentBlock = { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: pngHeader + big } } as ContentBlock;
    const request = nativeRequest(Array.from({ length: 8 }, (_, i) => ({
      participant: 'User', content: [{ type: 'text', text: `picture ${i}` }, huge],
    })));
    request.shedOversizeImages = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { rounds } = await drive(new Membrane(adapter), request);
    expect(rounds[0]!.fidelity).toBe('unknown');
  });

  it('stays established when opt-in image shedding has nothing to shed', async () => {
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');
    const small: ContentBlock = { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: pngHeader } } as ContentBlock;
    const request = nativeRequest([{ participant: 'User', content: [{ type: 'text', text: 'picture' }, small] }]);
    request.shedOversizeImages = true;
    const { rounds } = await drive(new Membrane(new ScriptedAdapter([finalTurn()])), request);
    expect(rounds[0]!.fidelity).toBe('established');
    expect(rounds[0]!.altered).toEqual({ messages: [], injected: [] });
  });

  it('emits no round reports when usage events are off', async () => {
    const adapter = new ScriptedAdapter([finalTurn()]);
    const { rounds, events } = await drive(new Membrane(adapter), nativeRequest([
      { participant: 'User', content: [{ type: 'text', text: 'hello' }] },
    ]), { streamOptions: { emitUsage: false } });
    expect(events.some((e) => e.type === 'usage')).toBe(false);
    expect(rounds).toHaveLength(0);
  });
});

describe('beforeRequest hooks', () => {
  const messages: NormalizedRequest['messages'] = [{ participant: 'User', content: [{ type: 'text', text: 'hello' }] }];

  it('a hook that mutates the request in place and returns nothing makes the round unknown', async () => {
    const adapter = new ScriptedAdapter([finalTurn()]);
    const membrane = new Membrane(adapter, {
      hooks: {
        beforeRequest: (_normalized, provider) => {
          const request = provider as { messages: Array<{ content: Array<{ text?: string }> }> };
          request.messages[0]!.content[0]!.text += ' (edited)';
          return undefined;
        },
      },
    });
    const { rounds } = await drive(membrane, nativeRequest(messages));
    expect(rounds[0]!.fidelity).toBe('unknown');
  });

  it('an observer hook keeps fidelity established', async () => {
    const adapter = new ScriptedAdapter([finalTurn()]);
    const seen: unknown[] = [];
    const membrane = new Membrane(adapter, {
      hooks: { beforeRequest: (_normalized, provider) => { seen.push(provider); return undefined; } },
    });
    const { rounds } = await drive(membrane, nativeRequest(messages));
    expect(seen).toHaveLength(1);
    expect(rounds[0]!.fidelity).toBe('established');
  });

  it('a hook returning an equal replacement keeps fidelity established', async () => {
    const adapter = new ScriptedAdapter([finalTurn()]);
    const membrane = new Membrane(adapter, {
      hooks: { beforeRequest: (_normalized, provider) => JSON.parse(JSON.stringify(provider)) },
    });
    const { rounds } = await drive(membrane, nativeRequest(messages));
    expect(rounds[0]!.fidelity).toBe('established');
  });
});

describe('XML prefill rounds', () => {
  function xmlRequest(messages: NormalizedRequest['messages']): NormalizedRequest {
    return { messages, config: { model: 'test-model', maxTokens: 1000 }, toolMode: 'xml', tools: [noopTool] };
  }
  const toolRound = '<function_calls><invoke name="noop"></invoke></function_calls>';

  it('carries no injected message: applied 0, and the context says so', async () => {
    const adapter = new MockAdapter({ streamChunkDelayMs: 0, completeDelayMs: 0, responseQueue: [toolRound, 'done.'] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { rounds, contexts } = await drive(new Membrane(adapter), xmlRequest([
      { participant: 'User', content: [{ type: 'text', text: 'go' }] },
    ]), { inject: [[{ participant: 'Carol', content: [{ type: 'text', text: 'arrived mid-turn' }] }]] });
    expect(contexts[0]!.supportsInjectedMessages).toBe(false);
    expect(rounds).toHaveLength(2);
    expect(rounds[0]!.injectedBatch).toBeUndefined();
    expect(rounds[1]!.injectedBatch).toEqual({ batch: 0, applied: 0 });
    expect(rounds.map((r) => r.fidelity)).toEqual(['established', 'established']);
  });

  it('reports the initial build\'s alterations on every round, continuations included', async () => {
    const adapter = new MockAdapter({ streamChunkDelayMs: 0, completeDelayMs: 0, responseQueue: [toolRound, 'done.'] });
    const { rounds } = await drive(new Membrane(adapter), xmlRequest([
      { participant: 'Alice', content: [{ type: 'text', text: 'intact' }] },
      { participant: 'Bob', content: [{ type: 'text', text: 'with a picture' }, svgImage] },
      { participant: 'Alice', content: [{ type: 'text', text: 'go' }] },
    ]));
    expect(rounds.map((r) => r.altered.messages)).toEqual([[1], [1]]);
  });

  it('reports a false-stop resumption as its own round', async () => {
    let calls = 0;
    const script = [
      { text: '<function_calls>\n<invoke name="foo">', stopReason: 'stop_sequence' },
      { text: 'a long enough stretch of resumed output to count as progress, then done', stopReason: 'end_turn' },
    ];
    const adapter: ProviderAdapter = {
      name: 'scripted-xml',
      reportsContentAlterations: true,
      supportsModel: () => true,
      complete: async () => { throw new Error('not used'); },
      stream: async (request, callbacks) => {
        const round = script[calls++]!;
        callbacks.onChunk(round.text);
        return {
          content: [{ type: 'text', text: round.text }],
          stopReason: round.stopReason,
          usage: { inputTokens: 100 + calls, outputTokens: 5 },
          model: request.model,
          raw: {},
        };
      },
    };
    const membrane = new Membrane(adapter, { logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
    const { rounds } = await drive(membrane, { messages: [{ participant: 'User', content: [{ type: 'text', text: 'hi' }] }], config: { model: 'test', maxTokens: 100 }, toolMode: 'xml' });
    expect(rounds.map((r) => [r.index, r.usage.inputTokens, r.fidelity])).toEqual([
      [0, 101, 'established'],
      [1, 102, 'established'],
    ]);
  });
});

describe('usage at the adapter boundary: a reported 0 is 0, an unreported count is absent', () => {
  it('OpenAI chat completions (streamed)', async () => {
    const adapter = new OpenAIAdapter({ apiKey: 'zz-not-a-key', baseURL: 'http://localhost:9/v1' });
    const request = { model: 'gpt-zz', maxTokens: 16, messages: [{ role: 'user', content: 'hi' }] } as any;
    stubFetchWithSseLines([
      '{"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}',
      '{"choices":[],"usage":{"prompt_tokens":40,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":0}}}',
      '[DONE]',
    ]);
    const zero = await adapter.stream(request, { onChunk: () => {} } as any);
    expect(zero.usage.cacheReadTokens).toBe(0);
    stubFetchWithSseLines([
      '{"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}',
      '{"choices":[],"usage":{"prompt_tokens":40,"completion_tokens":2}}',
      '[DONE]',
    ]);
    const absent = await adapter.stream(request, { onChunk: () => {} } as any);
    expect('cacheReadTokens' in absent.usage).toBe(false);
  });

  it('OpenAI Responses API', async () => {
    const respond = (usage: unknown) => vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 'resp_1', model: 'gpt-zz', status: 'completed',
      output: [{ type: 'message', id: 'm1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok', annotations: [] }] }],
      usage,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const adapter = new OpenAIResponsesAPIAdapter({ apiKey: 'sk-test' });
    const request = { model: 'gpt-zz', maxTokens: 16, messages: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] } as any;
    vi.stubGlobal('fetch', respond({ input_tokens: 40, output_tokens: 2, input_tokens_details: { cached_tokens: 0 } }));
    expect((await adapter.complete(request)).usage.cacheReadTokens).toBe(0);
    vi.stubGlobal('fetch', respond({ input_tokens: 40, output_tokens: 2 }));
    expect('cacheReadTokens' in (await adapter.complete(request)).usage).toBe(false);
  });

  it('Gemini: proto3 omits a zero count, so a count missing from a present usageMetadata is a reported 0', async () => {
    const respond = (usageMetadata: unknown) => vi.fn().mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      ...(usageMetadata ? { usageMetadata } : {}),
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const adapter = new GeminiAdapter({ apiKey: 'zz-key-not-used' });
    const request = { model: 'gemini-zz', maxTokens: 16, messages: [{ role: 'user', content: 'hi' }] } as any;
    vi.stubGlobal('fetch', respond({ promptTokenCount: 40, candidatesTokenCount: 2, totalTokenCount: 42, cachedContentTokenCount: 0 }));
    expect((await adapter.complete(request)).usage.cacheReadTokens).toBe(0);
    // The shape real no-cache-hit calls return: the field is omitted.
    vi.stubGlobal('fetch', respond({ promptTokenCount: 40, candidatesTokenCount: 2, totalTokenCount: 42 }));
    const omitted = await adapter.complete(request);
    expect(omitted.usage.cacheReadTokens).toBe(0);
    expect(omitted.unreportedUsage).toBeUndefined();
    vi.stubGlobal('fetch', respond(undefined));
    const unreported = await adapter.complete(request);
    expect('cacheReadTokens' in unreported.usage).toBe(false);
    expect(unreported.unreportedUsage).toEqual(['inputTokens', 'outputTokens']);
    // Streamed: the usageMetadata on the last chunk is read the same way.
    stubFetchWithSseLines([
      '{"candidates":[{"content":{"parts":[{"text":"o"}]}}]}',
      '{"candidates":[{"content":{"parts":[{"text":"k"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":40,"candidatesTokenCount":2,"totalTokenCount":42}}',
    ]);
    expect((await adapter.stream(request, { onChunk: () => {} } as any)).usage.cacheReadTokens).toBe(0);
    // A stream that never carries usageMetadata reports nothing.
    stubFetchWithSseLines([
      '{"candidates":[{"content":{"parts":[{"text":"o"}]}}]}',
      '{"candidates":[{"content":{"parts":[{"text":"k"}]},"finishReason":"STOP"}]}',
    ]);
    const unreportedStream = await adapter.stream(request, { onChunk: () => {} } as any);
    expect(unreportedStream.unreportedUsage).toEqual(['inputTokens', 'outputTokens']);
    expect('cacheReadTokens' in unreportedStream.usage).toBe(false);
  });
});

describe('adapters report the content they leave out', () => {
  it('Anthropic: a nested tool-result block with no Anthropic form, or whitespace text cleaned away, but not an exactly empty block', () => {
    const adapter = new AnthropicAdapter({ apiKey: 'test', cacheKeepalive: { enabled: false } }) as any;
    const request = (nested: unknown[]) => ({
      model: 'claude-sonnet-4-5', maxTokens: 64,
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'noop', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: nested }] },
      ],
    });
    let altered = 0;
    adapter.buildRequest(request([{ type: 'text', text: 'result' }, { type: 'text', text: '' }]), () => altered++);
    expect(altered).toBe(0);
    adapter.buildRequest(request([{ type: 'text', text: 'result' }, { type: 'text', text: ' ' }]), () => altered++);
    expect(altered).toBe(1);
    adapter.buildRequest(request([{ type: 'text', text: 'result' }, { type: 'document', source: { type: 'base64', mediaType: 'application/pdf', data: 'JVBERi0=' } }]), () => altered++);
    expect(altered).toBe(2);
  });

  it('Responses input normalization: an assistant image and a non-object block', () => {
    let dropped = 0;
    normalizeResponsesInput([
      { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image', source: { type: 'url', url: 'https://example.invalid/a.png' } }] },
    ] as any, () => dropped++);
    expect(dropped).toBe(0);
    normalizeResponsesInput([
      { role: 'assistant', content: [{ type: 'text', text: 'see' }, { type: 'image', source: { type: 'url', url: 'https://example.invalid/a.png' } }, 'stray'] },
    ] as any, () => dropped++);
    expect(dropped).toBe(2);
  });
});

/** The real Anthropic request builder; only the network response is scripted. */
class ScriptedAnthropic extends AnthropicAdapter {
  sent: any[] = [];
  constructor(private turns: Array<{ content: unknown[]; stopReason: string; usage?: Record<string, unknown> }>) {
    super({ apiKey: 'test', cacheKeepalive: { enabled: false } });
  }
  override async stream(request: ProviderRequest, callbacks: StreamCallbacks, options?: ProviderRequestOptions): Promise<ProviderResponse> {
    const wire = (this as any).buildRequest(request, options?.onContentAltered);
    this.sent.push(JSON.parse(JSON.stringify(wire)));
    options?.onRequest?.(wire);
    const turn = this.turns.shift()!;
    for (const b of turn.content as Array<{ type: string; text?: string }>) if (b.type === 'text') callbacks.onChunk(b.text!);
    return { content: turn.content, stopReason: turn.stopReason, usage: { inputTokens: 10, outputTokens: 2 }, model: request.model, rawRequest: wire, raw: {} };
  }
}

describe('producer-boundary losses', () => {
  const nativeAnthropicRequest = (extra: Partial<NormalizedRequest> = {}): NormalizedRequest => ({
    messages: [{ participant: 'User', content: [{ type: 'text', text: 'ORIGINAL' }] }],
    config: { model: 'claude-sonnet-4-5', maxTokens: 1000 },
    tools: [noopTool], toolMode: 'native', promptCaching: false, ...extra,
  });

  it('a hook\'s in-place edit that continuations keep carrying stays unknown on later rounds (XML)', async () => {
    const adapter = new MockAdapter({ streamChunkDelayMs: 0, completeDelayMs: 0, responseQueue: ['<function_calls><invoke name="noop"></invoke></function_calls>', 'done.'] });
    const sent: string[] = [];
    let calls = 0;
    const membrane = new Membrane(adapter, {
      hooks: {
        beforeRequest: (_normalized, provider: any) => {
          if (calls++ === 0) provider.messages.find((m: any) => m.role === 'user').content = 'CHANGED';
          sent.push(JSON.stringify(provider.messages));
          return undefined;
        },
      },
    });
    const { rounds } = await drive(membrane, {
      messages: [{ participant: 'User', content: [{ type: 'text', text: 'ORIGINAL' }] }],
      config: { model: 'test-model', maxTokens: 1000 }, toolMode: 'xml', tools: [noopTool], promptCaching: false,
    });
    expect(sent.every((m) => m.includes('CHANGED'))).toBe(true);
    expect(rounds.map((r) => r.fidelity)).toEqual(['unknown', 'unknown']);
  });

  it('a passthrough that replaces the built messages makes the round unknown (Anthropic, Bedrock)', async () => {
    const adapter = new ScriptedAnthropic([{ content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' }]);
    const { rounds } = await drive(new Membrane(adapter), nativeAnthropicRequest({
      providerParams: { messages: [{ role: 'user', content: [{ type: 'text', text: 'REPLACEMENT' }] }] },
    }));
    expect(adapter.sent[0].messages[0].content[0].text).toBe('REPLACEMENT');
    expect(rounds[0]!.fidelity).toBe('unknown');

    const { BedrockAdapter } = await import('../../src/providers/bedrock.js');
    const bedrock = new BedrockAdapter({ accessKeyId: 'test', secretAccessKey: 'test', region: 'us-west-2' }) as any;
    let altered = 0;
    bedrock.buildRequest({ model: 'claude', maxTokens: 10, messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], extra: { messages: [] } }, undefined, () => altered++);
    expect(altered).toBe(1);
  });

  it('whitespace text the Anthropic cleanup removes is reported against the injected message that held it', async () => {
    const adapter = new ScriptedAnthropic([
      { content: [{ type: 'tool_use', id: 't1', name: 'noop', input: {} }], stopReason: 'tool_use' },
      { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' },
    ]);
    const { rounds } = await drive(new Membrane(adapter), nativeAnthropicRequest(), {
      inject: [[{ participant: 'Visitor', content: [{ type: 'text', text: 'body' }, { type: 'text', text: '   ' }] }]],
    });
    expect(JSON.stringify(adapter.sent[1].messages)).not.toContain('"   "');
    expect(rounds[1]!.injectedBatch).toEqual({ batch: 0, applied: 1 });
    expect(rounds[1]!.altered).toEqual({ messages: [], injected: [[0, 0]] });
    expect(rounds[1]!.fidelity).toBe('established');
  });

  it('whitespace removal is attributed for compiled messages too, and an exactly empty block is not a loss', async () => {
    const adapter = new ScriptedAnthropic([{ content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' }]);
    const { rounds } = await drive(new Membrane(adapter), nativeAnthropicRequest({
      messages: [
        { participant: 'Alice', content: [{ type: 'text', text: 'kept' }, { type: 'text', text: '' }] },
        { participant: 'Bob', content: [{ type: 'text', text: 'kept' }, { type: 'text', text: ' \n' }] },
      ],
    }));
    expect(rounds[0]!.altered).toEqual({ messages: [1], injected: [] });
    expect(rounds[0]!.fidelity).toBe('established');
  });

  it('XML history: nested tool-result media rendered as a note is reported against its message', async () => {
    const adapter = new MockAdapter({ streamChunkDelayMs: 0, completeDelayMs: 0, responseQueue: ['done.'] });
    const { rounds } = await drive(new Membrane(adapter), {
      config: { model: 'test-model', maxTokens: 1000 }, toolMode: 'xml', promptCaching: false,
      messages: [
        { participant: 'Claude', content: [{ type: 'tool_use', id: 't1', name: 'noop', input: {} }] },
        { participant: 'User', content: [{ type: 'tool_result', toolUseId: 't1', content: [{ type: 'text', text: 'picture' }, { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'iVBORw0KGgo=' } }] }] },
        { participant: 'User', content: [{ type: 'text', text: 'continue' }] },
      ],
    } as NormalizedRequest);
    expect(rounds[0]!.altered.messages).toEqual([1]);
    expect(rounds[0]!.fidelity).toBe('established');
  });

  it('an unreported count is absent from the round\'s usage, though accounting keeps its 0', async () => {
    const adapter = new OpenAIResponsesAPIAdapter({ apiKey: 'test' }) as any;
    const parsed = adapter.parseResponse({ id: 'r', model: 'gpt-test', status: 'completed', output: [] }, 'gpt-test', {});
    expect(parsed.usage).toMatchObject({ inputTokens: 0, outputTokens: 0 });
    expect(parsed.unreportedUsage).toEqual(['inputTokens', 'outputTokens']);
    const reported = adapter.parseResponse({ id: 'r', model: 'gpt-test', status: 'completed', output: [], usage: { input_tokens: 0, output_tokens: 3 } }, 'gpt-test', {});
    expect(reported.unreportedUsage).toBeUndefined();

    const silent = new ScriptedAdapter([finalTurn()]);
    const origStream = silent.stream.bind(silent);
    silent.stream = async (...args: Parameters<ScriptedAdapter['stream']>) => ({ ...(await origStream(...args)), unreportedUsage: ['inputTokens'] });
    const { rounds } = await drive(new Membrane(silent), nativeRequest([{ participant: 'User', content: [{ type: 'text', text: 'hi' }] }]));
    expect('inputTokens' in rounds[0]!.usage).toBe(false);
    expect(rounds[0]!.usage.outputTokens).toBe(10);
  });

  it('a block object reused in two messages is emitted once per occurrence: removing both alters both; a report about the consumer\'s own object is unknown', async () => {
    const shared = { type: 'text', text: '   ' } as ContentBlock;
    const messages = (): NormalizedRequest['messages'] => [
      { participant: 'Claude', content: [{ type: 'tool_use', id: 't1', name: 'noop', input: {} }] },
      { participant: 'User', content: [{ type: 'tool_result', toolUseId: 't1', content: [{ type: 'text', text: 'first' }, shared] }] },
      { participant: 'Claude', content: [{ type: 'tool_use', id: 't2', name: 'noop', input: {} }] },
      { participant: 'User', content: [{ type: 'tool_result', toolUseId: 't2', content: [{ type: 'text', text: 'second' }, shared] }] },
    ];
    // The real Bedrock request builder and cleanup; only transport is scripted.
    const { BedrockAdapter } = await import('../../src/providers/bedrock.js');
    class ScriptedBedrock extends BedrockAdapter {
      sent: any;
      constructor() { super({ accessKeyId: 'test', secretAccessKey: 'test', region: 'us-east-1' }); }
      override async stream(request: ProviderRequest, callbacks: StreamCallbacks, options?: ProviderRequestOptions): Promise<ProviderResponse> {
        this.sent = (this as any).buildRequest(request, request.model, options?.onContentAltered);
        callbacks.onChunk('done');
        return { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 2 }, model: request.model, rawRequest: this.sent, raw: {} };
      }
    }
    const bedrock = new ScriptedBedrock();
    const both = await drive(new Membrane(bedrock), nativeAnthropicRequest({ messages: messages() }));
    expect(JSON.stringify(bedrock.sent.messages)).not.toContain('"   "');
    expect(both.rounds[0]!.altered.messages).toEqual([1, 3]);
    expect(both.rounds[0]!.fidelity).toBe('established');

    // A report naming the consumer's own object, which membrane never emitted:
    // which occurrence is unknowable.
    const once = new ScriptedAdapter([finalTurn()]);
    const original = once.stream.bind(once);
    once.stream = async (request, callbacks, options) => {
      options?.onContentAltered?.(shared);
      return original(request, callbacks, options);
    };
    const ambiguous = await drive(new Membrane(once), nativeRequest(messages()));
    expect(ambiguous.rounds[0]!.fidelity).toBe('unknown');
  });

  it('only the attempt that stands reports: a refused attempt\'s alteration is discarded, the standing attempt\'s kept', async () => {
    const messages = (): NormalizedRequest['messages'] => [
      { participant: 'Claude', content: [{ type: 'tool_use', id: 't1', name: 'noop', input: {} }] },
      { participant: 'User', content: [{ type: 'tool_result', toolUseId: 't1', content: [{ type: 'text', text: 'first' }] }] },
    ];
    /** Reports the nested block membrane emitted for message 1, on the attempts named. */
    const reporting = (reportOn: number[]) => {
      let attempt = 0;
      return {
        name: 'retrying', reportsContentAlterations: true,
        supportsModel: () => true, complete: async () => { throw new Error('unused'); },
        stream: async (request: ProviderRequest, callbacks: StreamCallbacks, options?: ProviderRequestOptions): Promise<ProviderResponse> => {
          const now = attempt++;
          const toolResult = (request.messages as any[]).flatMap((m) => m.content).find((b: any) => b.type === 'tool_result');
          if (reportOn.includes(now)) options?.onContentAltered?.(toolResult.content[0]);
          callbacks.onChunk('answer');
          return { content: [{ type: 'text', text: 'answer' }], stopReason: now === 0 ? 'refusal' : 'end_turn', usage: { inputTokens: 10, outputTokens: 2 }, model: request.model, rawRequest: request, raw: {} };
        },
      } as ProviderAdapter;
    };
    const discarded = await drive(new Membrane(reporting([0])), nativeRequest(messages()), { streamOptions: { refusalRetries: 1 } });
    expect(discarded.rounds).toHaveLength(1);
    expect(discarded.rounds[0]!.altered.messages).toEqual([]);
    expect(discarded.rounds[0]!.fidelity).toBe('established');
    const kept = await drive(new Membrane(reporting([1])), nativeRequest(messages()), { streamOptions: { refusalRetries: 1 } });
    expect(kept.rounds[0]!.altered.messages).toEqual([1]);
    expect(kept.rounds[0]!.fidelity).toBe('established');
  });
});

describe('Greptile\'s review of #104', () => {
  const text = (value: string): ContentBlock => ({ type: 'text', text: value });
  const toolUse = (id: string): ContentBlock => ({ type: 'tool_use', id, name: 'noop', input: {} }) as ContentBlock;
  const toolResult = (toolUseId: string | undefined, content: unknown = 'stray'): ContentBlock =>
    ({ type: 'tool_result', toolUseId, content }) as ContentBlock;
  const sorted = (indices: Iterable<number>) => [...indices].sort((a, b) => a - b);

  describe('injected messages keep the consumer\'s coordinates through provideToolResults\' cleaning', () => {
    it('native: positions and applied as supplied; a stripped tool block is an alteration, an empty message is not', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const adapter = new ScriptedAdapter([toolUseTurn('t1'), finalTurn()]);
      const { rounds } = await drive(new Membrane(adapter), nativeRequest([
        { participant: 'User', content: [text('go')] },
      ]), {
        inject: [[
          { participant: 'Ann', content: [] },
          { participant: 'Bo', content: [text('a picture'), svgImage] },
          { participant: 'Cy', content: [text('kept'), toolResult('x')] },
        ]],
      });
      expect(rounds[1]!.injectedBatch).toEqual({ batch: 0, applied: 3 });
      expect(rounds[1]!.altered).toEqual({ messages: [], injected: [[0, 1], [0, 2]] });
      expect(rounds[1]!.fidelity).toBe('established');
    });

    it('native: a wholly stripped batch keeps its number and stays altered while retained', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const adapter = new ScriptedAdapter([toolUseTurn('t1'), toolUseTurn('t2'), finalTurn()]);
      const { rounds } = await drive(new Membrane(adapter), nativeRequest([
        { participant: 'User', content: [text('go')] },
      ]), {
        inject: [
          [{ participant: 'Ann', content: [toolResult('x')] }],
          [{ participant: 'Bo', content: [text('a picture'), svgImage, toolUse('y')] }],
        ],
      });
      expect(rounds[1]!.injectedBatch).toEqual({ batch: 0, applied: 1 });
      expect(rounds[1]!.altered.injected).toEqual([[0, 0]]);
      expect(rounds[2]!.injectedBatch).toEqual({ batch: 1, applied: 1 });
      // [1, 0] lost its image to the builder and its tool block to the cleaning: one entry.
      expect(rounds[2]!.altered.injected).toEqual([[0, 0], [1, 0]]);
    });

    it('XML: a wholly stripped batch still takes its number', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const toolRound = '<function_calls><invoke name="noop"></invoke></function_calls>';
      const adapter = new MockAdapter({ streamChunkDelayMs: 0, completeDelayMs: 0, responseQueue: [toolRound, toolRound, 'done.'] });
      const { rounds } = await drive(new Membrane(adapter), {
        messages: [{ participant: 'User', content: [text('go')] }],
        config: { model: 'test-model', maxTokens: 1000 }, toolMode: 'xml', tools: [noopTool],
      }, {
        inject: [
          [{ participant: 'Ann', content: [toolResult('x')] }],
          [{ participant: 'Bo', content: [text('arrived mid-turn')] }],
        ],
      });
      expect(rounds.map((r) => r.injectedBatch)).toEqual([undefined, { batch: 0, applied: 0 }, { batch: 1, applied: 0 }]);
    });
  });

  describe('XML: a message the transcript leaves out is reported if it held anything', () => {
    async function xmlRound(messages: NormalizedRequest['messages']) {
      const adapter = new MockAdapter({ streamChunkDelayMs: 0, completeDelayMs: 0, responseQueue: ['done.'] });
      const { rounds } = await drive(new Membrane(adapter), {
        messages, config: { model: 'test-model', maxTokens: 1000 }, toolMode: 'xml', promptCaching: false,
      });
      return { round: rounds[0]!, sent: JSON.stringify(adapter.getLastRequest()?.messages) };
    }

    it('a trailing assistant message after another is left out of the transcript, and reported', async () => {
      const { round, sent } = await xmlRound([
        { participant: 'User', content: [text('hi')] },
        { participant: 'Claude', content: [text('first')] },
        { participant: 'Claude', content: [text('second')] },
      ]);
      expect(sent).toContain('first');
      expect(sent).not.toContain('second');
      expect(round.altered.messages).toEqual([2]);
      expect(round.fidelity).toBe('established');
    });

    it('a whitespace-only last message is reported; an exactly empty one is not', async () => {
      expect((await xmlRound([
        { participant: 'User', content: [text('hi')] },
        { participant: 'User', content: [text('  ')] },
      ])).round.altered.messages).toEqual([1]);
      expect((await xmlRound([
        { participant: 'User', content: [text('hi')] },
        { participant: 'Claude', content: [text('')] },
      ])).round.altered.messages).toEqual([]);
      expect((await xmlRound([
        { participant: 'User', content: [text('hi')] },
        { participant: 'Claude', content: [text('first')] },
        { participant: 'Claude', content: [text('')] },
      ])).round.altered.messages).toEqual([]);
    });
  });

  describe.each([
    {
      name: 'the same orphan id in two messages',
      messages: (): NormalizedRequest['messages'] => [
        { participant: 'User', content: [text('start')] },
        { participant: 'User', content: [toolResult('gone', 'one')] },
        { participant: 'Claude', content: [text('noted')] },
        { participant: 'User', content: [toolResult('gone', 'two')] },
        { participant: 'User', content: [text('go')] },
      ],
      altered: [1, 3],
    },
    {
      // A result with no id is textified as '<missing>'; a separate result whose
      // id is literally '<missing>' is paired and carried.
      name: 'a missing id beside a literal \'<missing>\' id',
      messages: (): NormalizedRequest['messages'] => [
        { participant: 'User', content: [toolResult(undefined, 'no id')] },
        { participant: 'Claude', content: [toolUse('<missing>')] },
        { participant: 'User', content: [toolResult('<missing>', 'paired')] },
        { participant: 'User', content: [text('go')] },
      ],
      altered: [0],
    },
    {
      // A second result for a call that was already answered is textified too.
      name: 'a duplicate result for an answered call',
      messages: (): NormalizedRequest['messages'] => [
        { participant: 'User', content: [text('start')] },
        { participant: 'Claude', content: [toolUse('c1')] },
        { participant: 'User', content: [toolResult('c1', 'first')] },
        { participant: 'Claude', content: [text('noted')] },
        { participant: 'User', content: [toolResult('c1', 'again')] },
        { participant: 'User', content: [text('go')] },
      ],
      altered: [4],
    },
    {
      // A second result for the call in the same message is textified too.
      name: 'a duplicate result beside the one that answered its call',
      messages: (): NormalizedRequest['messages'] => [
        { participant: 'User', content: [text('start')] },
        { participant: 'Claude', content: [toolUse('c1')] },
        { participant: 'User', content: [toolResult('c1', 'first'), toolResult('c1', 'again')] },
        { participant: 'User', content: [text('go')] },
      ],
      altered: [2],
    },
  ])('a textified tool_result alters exactly the message it came from: $name', ({ messages, altered }) => {
    it('the yielding native loop', async () => {
      const { rounds } = await drive(new Membrane(new ScriptedAdapter([finalTurn()])), nativeRequest(messages()));
      expect(rounds[0]!.altered.messages).toEqual(altered);
      expect(rounds[0]!.fidelity).toBe('established');
    });

    it('NativeFormatter.buildMessages', () => {
      const notes = new FidelityNotes();
      new NativeFormatter().buildMessages(messages(), { assistantParticipant: 'Claude', participantMode: 'multiuser', fidelity: notes } as any);
      expect(sorted(notes.altered)).toEqual(altered);
      expect(notes.established).toBe(true);
    });

    it('the replacement keeps its owner, so a later report about it names the same message', () => {
      const notes = new FidelityNotes();
      const built = new NativeFormatter().buildMessages(messages(), { assistantParticipant: 'Claude', participantMode: 'multiuser', fidelity: notes } as any);
      const replacements = (built.messages as Array<{ content: unknown }>)
        .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
        .filter((b: any) => b.type === 'text' && /^\[(orphan|duplicate) tool_result for /.test(b.text));
      expect(replacements.length).toBeGreaterThan(0);
      for (const replacement of replacements) notes.alterBlock(replacement);
      expect(sorted(notes.altered)).toEqual(altered);
      expect(notes.established).toBe(true);
    });
  });


  describe('a stranded call\'s round reports the breakpoint block the Anthropic cleanup removes', () => {
    // The stranded tool_use gets a synthetic [pending] result in the next user
    // envelope. The breakpoint sits on a whitespace-only last block, which the
    // Anthropic cleanup then removes, and its report names that block's message.
    const messages = (): NormalizedRequest['messages'] => [
      { participant: 'User', content: [text('start')] },
      { participant: 'Claude', content: [toolUse('stranded')] },
      { participant: 'User', content: [text('later'), text('  ')], cacheBreakpoint: true },
    ];

    it('through the yielding native loop and the real Anthropic cleanup', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const adapter = new ScriptedAnthropic([{ content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' }]);
      const { rounds } = await drive(new Membrane(adapter), {
        messages: messages(), config: { model: 'claude-sonnet-4-5', maxTokens: 1000 },
        tools: [noopTool], toolMode: 'native', promptCaching: true,
      });
      const sent = JSON.stringify(adapter.sent[0].messages);
      expect(sent).toContain('[pending]');
      expect(sent).not.toContain('"  "');
      expect(rounds[0]!.altered.messages).toEqual([2]);
      expect(rounds[0]!.fidelity).toBe('established');
    });
  });

  it('Responses subscription normalization reports a tool result whose nested content it can\'t carry, wrapped or standalone', () => {
    let dropped = 0;
    const lossy = [{ type: 'text', text: 'result' }, { type: 'document', source: { type: 'base64', mediaType: 'application/pdf', data: 'JVBERi0=' } }];
    normalizeResponsesInput([{ role: 'user', content: [{ type: 'tool_result', toolUseId: 'c1', content: lossy }] }] as any, () => dropped++);
    expect(dropped).toBe(1);
    normalizeResponsesInput([{ type: 'tool_result', toolUseId: 'c2', content: lossy }] as any, () => dropped++);
    expect(dropped).toBe(2);
    // Text-only and string results lose nothing.
    normalizeResponsesInput([{ role: 'user', content: [
      { type: 'tool_result', toolUseId: 'c3', content: [{ type: 'text', text: 'ok' }] },
      { type: 'tool_result', toolUseId: 'c4', content: 'ok' },
    ] }] as any, () => dropped++);
    expect(dropped).toBe(2);
  });

  it('completions: a skipped message is altered only if a block held something (two \'\' blocks join to \'\\n\')', () => {
    const notes = new FidelityNotes();
    new CompletionsFormatter().buildMessages([
      { participant: 'User', content: [text(''), text('')] },
      { participant: 'User', content: [text(' ')] },
      { participant: 'User', content: [text('go')] },
    ], { assistantParticipant: 'Claude', participantMode: 'multiuser', fidelity: notes } as any);
    expect(sorted(notes.altered)).toEqual([1]);
  });
});

describe('slimepriestess\'s review of #104', () => {
  const text = (value: string): ContentBlock => ({ type: 'text', text: value });
  const sorted = (indices: Iterable<number>) => [...indices].sort((a, b) => a - b);

  describe('a beforeRequest hook that changes the normalized request in place', () => {
    const anthropicTurns = () => [
      { content: [{ type: 'tool_use', id: 't1', name: 'noop', input: {} }], stopReason: 'tool_use' },
      { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' },
    ];
    const nativeAnthropic = (): NormalizedRequest => ({
      messages: [{ participant: 'User', content: [{ type: 'text', text: 'ORIGINAL' }] }],
      config: { model: 'claude-sonnet-4-5', maxTokens: 1000 },
      tools: [noopTool], toolMode: 'native', promptCaching: false,
    });
    /** A hook that edits the consumer's first message in the given rounds. */
    const editing = (rounds: number[]) => {
      let call = 0;
      return {
        beforeRequest: (normalized: NormalizedRequest) => {
          if (rounds.includes(call++)) (normalized.messages[0]!.content[0] as { text: string }).text = 'HOOK-EDIT';
          return undefined;
        },
      };
    };

    it('native: the next round is built from the edit, so that round and every later one are unknown', async () => {
      const adapter = new ScriptedAnthropic(anthropicTurns());
      const { rounds } = await drive(new Membrane(adapter, { hooks: editing([0]) }), nativeAnthropic());
      expect(JSON.stringify(adapter.sent[0].messages)).toContain('ORIGINAL');
      expect(JSON.stringify(adapter.sent[1].messages)).toContain('HOOK-EDIT');
      expect(rounds.map((r) => r.fidelity)).toEqual(['unknown', 'unknown']);
    });

    it('native: rounds before the edit stay established', async () => {
      const adapter = new ScriptedAnthropic(anthropicTurns());
      const { rounds } = await drive(new Membrane(adapter, { hooks: editing([1]) }), nativeAnthropic());
      expect(rounds.map((r) => r.fidelity)).toEqual(['established', 'unknown']);
    });

    it('native: a hook that only reads both arguments keeps every round established', async () => {
      const adapter = new ScriptedAnthropic(anthropicTurns());
      const seen: string[] = [];
      const membrane = new Membrane(adapter, {
        hooks: { beforeRequest: (normalized, provider) => { seen.push(JSON.stringify([normalized, provider])); return undefined; } },
      });
      const { rounds } = await drive(membrane, nativeAnthropic());
      expect(seen).toHaveLength(2);
      expect(rounds.map((r) => r.fidelity)).toEqual(['established', 'established']);
    });

    it('XML: an edit to the config, which continuations reuse, makes the rounds unknown', async () => {
      const adapter = new MockAdapter({ streamChunkDelayMs: 0, completeDelayMs: 0, responseQueue: ['<function_calls><invoke name="noop"></invoke></function_calls>', 'done.'] });
      const maxTokens: number[] = [];
      const stream = adapter.stream.bind(adapter);
      adapter.stream = (request, callbacks, options) => { maxTokens.push(request.maxTokens); return stream(request, callbacks, options); };
      let call = 0;
      const membrane = new Membrane(adapter, {
        hooks: { beforeRequest: (normalized) => { if (call++ === 0) normalized.config.maxTokens = 7; return undefined; } },
      });
      const { rounds } = await drive(membrane, {
        messages: [{ participant: 'User', content: [{ type: 'text', text: 'go' }] }],
        config: { model: 'test-model', maxTokens: 1000 }, toolMode: 'xml', tools: [noopTool], promptCaching: false,
      });
      expect(maxTokens).toEqual([1000, 7]);
      expect(rounds.map((r) => r.fidelity)).toEqual(['unknown', 'unknown']);
    });
  });

  /** The real Responses API request builder (API-key mode); only the network is scripted. */
  class ScriptedResponses extends OpenAIResponsesAPIAdapter {
    sent: any[] = [];
    constructor() { super({ apiKey: 'sk-test' }); }
    override async stream(request: ProviderRequest, callbacks: StreamCallbacks, options?: ProviderRequestOptions): Promise<any> {
      const wire = (this as any).buildRequest(request, options?.onContentAltered);
      this.sent.push(JSON.parse(JSON.stringify(wire)));
      callbacks.onChunk('done');
      return { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 2 }, model: request.model, rawRequest: wire, raw: {} };
    }
  }
  const responsesRound = async (messages: NormalizedRequest['messages']) => {
    const adapter = new ScriptedResponses();
    const { rounds } = await drive(new Membrane(adapter, { formatter: new OpenAIResponsesFormatter() }), {
      messages, config: { model: 'gpt-test', maxTokens: 100 },
    });
    return { round: rounds[0]!, wire: JSON.stringify(adapter.sent[0].input) };
  };

  describe('a raw form its path sends is the block\'s content: what ships, and what counts as carried', () => {
    it('Responses formatter: a block\'s rawItem goes out in place of its text, once for the blocks that share it', async () => {
      const item = { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'ITEM-TEXT' }] };
      const { round, wire } = await responsesRound([
        { participant: 'User', content: [{ type: 'text', text: 'hi' }] },
        { participant: 'Claude', content: [{ type: 'text', text: 'EDITED', rawItem: item }, { type: 'text', text: 'ALSO-EDITED', rawItem: item }] as ContentBlock[] },
        { participant: 'User', content: [{ type: 'text', text: 'go on' }] },
      ]);
      expect(wire.match(/ITEM-TEXT/g)).toHaveLength(1);
      expect(wire).not.toContain('EDITED');
      expect(round.altered.messages).toEqual([]);
      expect(round.fidelity).toBe('established');
    });

    it('Responses formatter: a message\'s openaiResponsesItems go out in place of its content; an empty array sends nothing', async () => {
      const { round, wire } = await responsesRound([
        { participant: 'User', content: [{ type: 'text', text: '(imported)' }], metadata: { openaiResponsesItems: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'IMPORTED-TURN' }] }] } },
        { participant: 'User', content: [{ type: 'text', text: '(nothing native)' }], metadata: { openaiResponsesItems: [] } },
        { participant: 'User', content: [{ type: 'text', text: 'new turn' }] },
      ]);
      expect(wire).toContain('IMPORTED-TURN');
      expect(wire).not.toContain('(imported)');
      expect(wire).not.toContain('(nothing native)');
      expect(round.altered.messages).toEqual([]);
      expect(round.fidelity).toBe('established');
    });

    it('XML prefill: a tool_result\'s rawXml goes out in place of its content', async () => {
      const adapter = new MockAdapter({ streamChunkDelayMs: 0, completeDelayMs: 0, responseQueue: ['done.'] });
      const { rounds } = await drive(new Membrane(adapter), {
        config: { model: 'test-model', maxTokens: 1000 }, toolMode: 'xml', promptCaching: false,
        messages: [
          { participant: 'User', content: [{ type: 'text', text: 'run it' }] },
          { participant: 'Claude', content: [{ type: 'tool_use', id: 't1', name: 'noop', input: {} } as ContentBlock] },
          { participant: 'User', content: [{ type: 'tool_result', toolUseId: 't1', content: 'TRUNCATED', rawXml: '<function_results><result>RAW-RESULT</result></function_results>' } as ContentBlock] },
          { participant: 'User', content: [{ type: 'text', text: 'continue' }] },
        ],
      });
      const sent = JSON.stringify(adapter.getLastRequest()?.messages);
      expect(sent).toContain('RAW-RESULT');
      expect(sent).not.toContain('TRUNCATED');
      expect(rounds[0]!.altered.messages).toEqual([]);
      expect(rounds[0]!.fidelity).toBe('established');
    });
  });

  describe('a zero-width carrier is all raw form: a path that leaves it out alters its message, and one that sends its item carries it', () => {
    // How Anthropic's unconvertible response blocks (server-tool results) are kept.
    const carrier = (): ContentBlock => ({ type: 'text', text: '', rawItem: { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [] } }) as ContentBlock;
    // The call the result answers: the API takes a result only after its call.
    const callCarrier = (): ContentBlock => ({ type: 'text', text: '', rawItem: { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'zz' } } }) as ContentBlock;
    const conversations = {
      'beside text': (): NormalizedRequest['messages'] => [
        { participant: 'User', content: [text('search for it')] },
        { participant: 'Claude', content: [text('found it'), callCarrier(), carrier()] },
        { participant: 'User', content: [text('go on')] },
      ],
      alone: (): NormalizedRequest['messages'] => [
        { participant: 'User', content: [text('search for it')] },
        { participant: 'Claude', content: [callCarrier(), carrier()] },
        { participant: 'User', content: [text('go on')] },
      ],
    };

    it('the yielding native loop with the real Anthropic builder sends a server block in its turn, and names nothing; plain \'\' text is still no loss', async () => {
      for (const messages of Object.values(conversations)) {
        const adapter = new ScriptedAnthropic([{ content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' }]);
        const { rounds } = await drive(new Membrane(adapter), {
          messages: messages(), config: { model: 'claude-sonnet-4-5', maxTokens: 1000 }, tools: [noopTool], toolMode: 'native', promptCaching: false,
        });
        expect(adapter.sent[0].messages[1].role).toBe('assistant');
        expect(JSON.stringify(adapter.sent[0].messages[1].content)).toContain('web_search_tool_result');
        expect(rounds[0]!.altered.messages).toEqual([]);
        expect(rounds[0]!.fidelity).toBe('established');
      }
      const plain = new ScriptedAnthropic([{ content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' }]);
      const { rounds } = await drive(new Membrane(plain), {
        messages: [{ participant: 'User', content: [text('hi')] }, { participant: 'Claude', content: [text('ok'), text('')] }, { participant: 'User', content: [text('go on')] }],
        config: { model: 'claude-sonnet-4-5', maxTokens: 1000 }, tools: [noopTool], toolMode: 'native', promptCaching: false,
      });
      expect(rounds[0]!.altered.messages).toEqual([]);
    });

    it('BedrockAdapter doesn\'t declare that it replays server blocks', async () => {
      const { BedrockAdapter } = await import('../../src/providers/bedrock.js');
      const bedrock = new BedrockAdapter({ accessKeyId: 'test', secretAccessKey: 'test', region: 'us-west-2' });
      expect((bedrock as { replaysAnthropicServerBlocks?: boolean }).replaysAnthropicServerBlocks).not.toBe(true);
      expect(new AnthropicAdapter({ apiKey: 'zz-key', cacheKeepalive: { enabled: false } }).replaysAnthropicServerBlocks).toBe(true);
    });

    it('an Anthropic-shaped build that doesn\'t replay server blocks leaves the block out, and names its message', async () => {
      for (const messages of Object.values(conversations)) {
        const adapter = new ScriptedAnthropic([{ content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' }]);
        (adapter as { replaysAnthropicServerBlocks: boolean }).replaysAnthropicServerBlocks = false; // as a build that doesn't declare it
        const { rounds } = await drive(new Membrane(adapter), {
          messages: messages(), config: { model: 'claude-sonnet-4-5', maxTokens: 1000 }, tools: [noopTool], toolMode: 'native', promptCaching: false,
        });
        expect(JSON.stringify(adapter.sent[0].messages)).not.toContain('web_search_tool_result');
        expect(rounds[0]!.altered.messages).toEqual([1]);
        expect(rounds[0]!.fidelity).toBe('established');
      }
    });

    it.each([
      ['AnthropicXmlFormatter', () => new AnthropicXmlFormatter(), {}],
      ['CompletionsFormatter', () => new CompletionsFormatter(), {}],
      ['NativeFormatter, not replaying server blocks', () => new NativeFormatter(), { anthropicServerBlocks: false }],
    ] as const)('%s leaves it out', (_name, formatter, extra) => {
      for (const messages of Object.values(conversations)) {
        const notes = new FidelityNotes();
        const built = formatter().buildMessages(messages(), { assistantParticipant: 'Claude', participantMode: 'multiuser', fidelity: notes, ...extra } as any);
        expect(JSON.stringify(built.messages)).not.toContain('web_search_tool_result');
        expect(sorted(notes.altered)).toEqual([1]);
      }
    });

    it('NativeFormatter sends a server block in the assistant turn that holds it, and names nothing; in a user turn it leaves it out, and names that message', () => {
      for (const messages of Object.values(conversations)) {
        const notes = new FidelityNotes();
        const built = new NativeFormatter().buildMessages(messages(), { assistantParticipant: 'Claude', participantMode: 'multiuser', fidelity: notes, anthropicServerBlocks: true } as any);
        expect(JSON.stringify(built.messages)).toContain('web_search_tool_result');
        expect(sorted(notes.altered)).toEqual([]);
      }
      const notes = new FidelityNotes();
      const built = new NativeFormatter().buildMessages([
        { participant: 'User', content: [text('search for it'), carrier()] },
        { participant: 'Claude', content: [text('found it')] },
      ], { assistantParticipant: 'Claude', participantMode: 'multiuser', fidelity: notes, anthropicServerBlocks: true } as any);
      expect(JSON.stringify(built.messages)).not.toContain('web_search_tool_result');
      expect(sorted(notes.altered)).toEqual([0]);
    });

    it('NativeFormatter leaves out a carrier of another wire\'s item, even in an assistant turn, and names its message', () => {
      const reasoning = { type: 'reasoning', id: 'rs_1', summary: [] };
      const notes = new FidelityNotes();
      const built = new NativeFormatter().buildMessages([
        { participant: 'User', content: [text('think about it')] },
        { participant: 'Claude', content: [text('thought'), { type: 'text', text: '', rawItem: reasoning } as ContentBlock] },
        { participant: 'User', content: [text('go on')] },
      ], { assistantParticipant: 'Claude', participantMode: 'multiuser', fidelity: notes } as any);
      expect(JSON.stringify(built.messages)).not.toContain('rs_1');
      expect(sorted(notes.altered)).toEqual([1]);
    });

    it('the Responses formatter leaves an Anthropic server block out, and names its message', async () => {
      const { round, wire } = await responsesRound([
        { participant: 'User', content: [text('search for it')] },
        { participant: 'Claude', content: [text('found it'), carrier()] },
        { participant: 'User', content: [text('go on')] },
      ]);
      expect(wire).not.toContain('web_search_tool_result');
      expect(wire).toContain('found it');
      expect(round.altered.messages).toEqual([1]);
      expect(round.fidelity).toBe('established');
    });

    it('the Responses input normalization leaves an Anthropic server block out, and hears it as the request\'s own block', () => {
      const block = carrier();
      const dropped: unknown[] = [];
      const items = normalizeResponsesInput([
        { role: 'assistant', content: [{ type: 'text', text: 'found it' }, block] },
      ] as any, (b) => dropped.push(b));
      expect(JSON.stringify(items)).not.toContain('web_search_tool_result');
      expect(dropped).toEqual([block]);
      expect(dropped[0]).toBe(block);
    });

    it('the Responses formatter sends the carrier\'s item, and names nothing', async () => {
      const developer = { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'DEVELOPER-ITEM' }] };
      const { round, wire } = await responsesRound([
        { participant: 'User', content: [{ type: 'text', text: '', rawItem: developer } as ContentBlock] },
        { participant: 'User', content: [text('new turn')] },
      ]);
      expect(wire).toContain('DEVELOPER-ITEM');
      expect(round.altered.messages).toEqual([]);
      expect(round.fidelity).toBe('established');
    });
  });
});

describe('an automated review of #104\'s own range', () => {
  const text = (value: string): ContentBlock => ({ type: 'text', text: value });
  const buildOptions = (notes: FidelityNotes) => ({ assistantParticipant: 'Claude', participantMode: 'multiuser', fidelity: notes }) as any;

  /** Reports the usage it's given, refusing the first `refusals` attempts. */
  class UsageAdapter implements ProviderAdapter {
    readonly name = 'zz-usage';
    readonly reportsContentAlterations = true;
    calls = 0;
    constructor(private usage: ProviderResponse['usage'], private refusals = 0) {}
    supportsModel(): boolean { return true; }
    private respond(): ProviderResponse {
      const refusing = this.calls <= this.refusals;
      return { content: [{ type: 'text', text: refusing ? 'no' : 'done.' }], stopReason: refusing ? 'refusal' : 'end_turn', usage: { ...this.usage }, raw: {} } as ProviderResponse;
    }
    async complete(): Promise<ProviderResponse> { this.calls++; return this.respond(); }
    async stream(_request: ProviderRequest, callbacks: StreamCallbacks): Promise<ProviderResponse> {
      this.calls++;
      const response = this.respond();
      callbacks.onChunk((response.content[0] as { text: string }).text);
      return response;
    }
  }

  it('turn totals and a refused attempt\'s record keep a reported 0, and leave an unreported count absent', async () => {
    const request = nativeRequest([{ participant: 'User', content: [text('hi')] }]);
    const zero = { inputTokens: 40, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 };
    const completed = await new Membrane(new UsageAdapter(zero, 1)).complete(request, { refusalRetries: 1 });
    expect(completed.usage).toMatchObject({ cacheReadTokens: 0, cacheCreationTokens: 0 });
    expect(completed.details.usage.discardedAttempts).toMatchObject({ attempts: 1, cacheReadTokens: 0, cacheCreationTokens: 0 });
    const streamed = await drive(new Membrane(new UsageAdapter(zero)), request);
    const usageEvent = streamed.events.find((e) => e.type === 'usage') as Extract<StreamEvent, { type: 'usage' }>;
    expect(usageEvent.usage).toMatchObject({ cacheReadTokens: 0, cacheCreationTokens: 0 });
    expect(streamed.rounds[0]!.usage).toMatchObject({ cacheReadTokens: 0, cacheCreationTokens: 0 });
    // Unreported, the count is absent from the totals (complete() copies the
    // provider's own fields, so there it reads undefined).
    const unreported = await new Membrane(new UsageAdapter({ inputTokens: 40, outputTokens: 2 })).complete(request);
    expect(unreported.usage.cacheReadTokens).toBeUndefined();
    expect(unreported.usage.cacheCreationTokens).toBeUndefined();
    const streamedUnreported = await drive(new Membrane(new UsageAdapter({ inputTokens: 40, outputTokens: 2 })), request);
    const unreportedEvent = streamedUnreported.events.find((e) => e.type === 'usage') as Extract<StreamEvent, { type: 'usage' }>;
    expect('cacheReadTokens' in unreportedEvent.usage).toBe(false);
    expect('cacheCreationTokens' in unreportedEvent.usage).toBe(false);
  });

  it('turn totals keep a reported thinkingTokens 0', async () => {
    const request = nativeRequest([{ participant: 'User', content: [text('hi')] }]);
    const streamed = await drive(new Membrane(new UsageAdapter({ inputTokens: 40, outputTokens: 2, thinkingTokens: 0 })), request);
    const usageEvent = streamed.events.find((e) => e.type === 'usage') as Extract<StreamEvent, { type: 'usage' }>;
    expect(usageEvent.usage).toMatchObject({ thinkingTokens: 0 });
  });

  it('a round\'s usage is in membrane\'s convention: a cache-inclusive input count is restated without its cache reads', async () => {
    class InclusiveAdapter extends ScriptedAdapter {
      readonly usageCacheConvention = 'cache-inclusive' as const;
    }
    const adapter = new InclusiveAdapter([finalTurn({ usage: { inputTokens: 1000, outputTokens: 5, cacheReadTokens: 800 } })]);
    const { rounds } = await drive(new Membrane(adapter), nativeRequest([{ participant: 'User', content: [text('hi')] }]));
    expect(rounds[0]!.usage).toMatchObject({ inputTokens: 200, cacheReadTokens: 800 });
  });

  it('Responses formatter: a block whose item differs under the same type and id isn\'t carried; an equal copy is', () => {
    const item = { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'FIRST' }] };
    const copy = JSON.parse(JSON.stringify(item));
    const edited = { ...item, content: [{ type: 'output_text', text: 'REDACTED' }] };
    const notes = new FidelityNotes();
    const built = new OpenAIResponsesFormatter().buildMessages([
      { participant: 'Claude', content: [{ type: 'text', text: 'a', rawItem: item }, { type: 'text', text: 'b', rawItem: copy }] as ContentBlock[] },
      { participant: 'Claude', content: [{ type: 'text', text: 'a', rawItem: item }, { type: 'text', text: 'b', rawItem: edited }] as ContentBlock[] },
    ], buildOptions(notes));
    expect(JSON.stringify(built.messages)).not.toContain('REDACTED');
    expect([...notes.altered]).toEqual([1]);
    expect(notes.established).toBe(true);
  });

  it('Responses input normalization names the block it changed: an assistant image, a non-object input, a failed result', () => {
    const image = { type: 'image', source: { type: 'url', url: 'https://example.invalid/a.png' } };
    const call = { type: 'tool_use', id: 'c1', name: 'noop', input: 'not-an-object' };
    const failed = { type: 'tool_result', toolUseId: 'c1', content: 'boom', isError: true };
    const fine = { type: 'tool_result', toolUseId: 'c2', content: 'ok', isError: false };
    const notes = new FidelityNotes();
    notes.own(image, 0);
    notes.own(call, 0);
    notes.own(failed, 1);
    notes.own(fine, 2);
    const heard: unknown[] = [];
    normalizeResponsesInput([
      { role: 'assistant', content: [{ type: 'text', text: 'see' }, image, call] },
      { role: 'user', content: [failed] },
      { role: 'user', content: [fine] },
    ] as any, (block) => { heard.push(block); notes.alterBlock(block); });
    expect(heard).toHaveLength(3);
    expect(heard[0]).toBe(image);
    expect(heard[1]).toBe(call);
    expect(heard[2]).toBe(failed);
    expect([...notes.altered].sort()).toEqual([0, 1]);
    expect(notes.established).toBe(true);
    // A standalone (top-level) failed result is reported too.
    let standalone = 0;
    normalizeResponsesInput([{ type: 'tool_result', toolUseId: 'c3', content: 'boom', is_error: true }] as any, () => standalone++);
    expect(standalone).toBe(1);
  });

  it('Responses formatter: a failed tool result alters its message, since a function_call_output has no error flag', () => {
    const notes = new FidelityNotes();
    new OpenAIResponsesFormatter().buildMessages([
      { participant: 'Claude', content: [{ type: 'tool_use', id: 'c1', name: 'noop', input: {} }] },
      { participant: 'User', content: [{ type: 'tool_result', toolUseId: 'c1', content: 'boom', isError: true }] },
      { participant: 'Claude', content: [{ type: 'tool_use', id: 'c2', name: 'noop', input: {} }] },
      { participant: 'User', content: [{ type: 'tool_result', toolUseId: 'c2', content: 'ok' }] },
    ] as NormalizedRequest['messages'], buildOptions(notes));
    expect([...notes.altered]).toEqual([1]);
  });

  it('a hook that returns a different provider request makes that round unknown, and the next, built afresh, established', async () => {
    const adapter = new ScriptedAdapter([toolUseTurn('t1'), finalTurn()]);
    let call = 0;
    const membrane = new Membrane(adapter, {
      hooks: { beforeRequest: (_normalized, provider) => (call++ === 0 ? { ...(provider as object), maxTokens: 7 } : undefined) as any },
    });
    const { rounds } = await drive(membrane, nativeRequest([{ participant: 'User', content: [text('hello')] }]));
    expect(adapter.requests[0]!.maxTokens).toBe(7);
    expect(rounds.map((r) => r.fidelity)).toEqual(['unknown', 'established']);
  });

  it('without usage events, a hooked stream doesn\'t serialize its request to compare it', async () => {
    let serialized = 0;
    const probe = { toJSON: () => { serialized++; return 'probe'; } };
    const request = nativeRequest([{ participant: 'User', content: [text('hi')], metadata: { probe } }]);
    const hooked = () => new Membrane(new ScriptedAdapter([finalTurn()]), { hooks: { beforeRequest: () => undefined } });
    await drive(hooked(), request, { streamOptions: { emitUsage: false } });
    expect(serialized).toBe(0);
    await drive(hooked(), request);
    expect(serialized).toBeGreaterThan(0);
  });

  it('OpenAI chat completions (complete): a reported 0 is 0, an unreported count absent', async () => {
    const respond = (usage: unknown) => vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 'cc_1', object: 'chat.completion', created: 0, model: 'gpt-zz',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const adapter = new OpenAIAdapter({ apiKey: 'zz-not-a-key', baseURL: 'http://localhost:9/v1' });
    const request = { model: 'gpt-zz', maxTokens: 16, messages: [{ role: 'user', content: 'hi' }] } as any;
    vi.stubGlobal('fetch', respond({ prompt_tokens: 40, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0 } }));
    expect((await adapter.complete(request)).usage.cacheReadTokens).toBe(0);
    vi.stubGlobal('fetch', respond({ prompt_tokens: 40, completion_tokens: 2 }));
    expect('cacheReadTokens' in (await adapter.complete(request)).usage).toBe(false);
  });

  it('XML history: a result sent as its rawXml is carried, nested media and all', async () => {
    const adapter = new MockAdapter({ streamChunkDelayMs: 0, completeDelayMs: 0, responseQueue: ['done.'] });
    const { rounds } = await drive(new Membrane(adapter), {
      config: { model: 'test-model', maxTokens: 1000 }, toolMode: 'xml', promptCaching: false,
      messages: [
        { participant: 'Claude', content: [{ type: 'tool_use', id: 't1', name: 'noop', input: {}, rawXml: '<function_calls><invoke name="noop"></invoke></function_calls>' }] },
        { participant: 'User', content: [{ type: 'tool_result', toolUseId: 't1', rawXml: '<function_results><result>picture [Image]</result></function_results>', content: [{ type: 'text', text: 'picture' }, { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'iVBORw0KGgo=' } }] }] },
        { participant: 'User', content: [{ type: 'text', text: 'continue' }] },
      ],
    } as NormalizedRequest);
    expect(rounds[0]!.altered.messages).toEqual([]);
    expect(rounds[0]!.fidelity).toBe('established');
  });

  it('XML prefill: opt-in image shedding in the initial build makes the round unknown', async () => {
    const big = Buffer.alloc(6 * 1024 * 1024, 7).toString('base64');
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');
    const huge: ContentBlock = { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: pngHeader + big } } as ContentBlock;
    const adapter = new MockAdapter({ streamChunkDelayMs: 0, completeDelayMs: 0, responseQueue: ['done.'] });
    const request: NormalizedRequest = {
      config: { model: 'test-model', maxTokens: 1000 }, toolMode: 'xml', tools: [noopTool], promptCaching: false,
      messages: Array.from({ length: 8 }, (_, i) => ({ participant: 'User', content: [text(`picture ${i}`), huge] })),
    };
    request.shedOversizeImages = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { rounds } = await drive(new Membrane(adapter), request);
    expect(rounds[0]!.fidelity).toBe('unknown');
  });

  it('a copy of the notes keeps an in-place hook change', () => {
    const notes = new FidelityNotes();
    notes.mutatedInPlace = true;
    expect(notes.copy().mutatedInPlace).toBe(true);
  });
});

describe.each([
  { name: 'an audio block without a base64 source', block: { type: 'audio', source: { type: 'url', url: 'https://example.test/a.mp3' } } },
  { name: 'a video block', block: { type: 'video', source: { type: 'base64', mediaType: 'video/mp4', data: 'AAAA' } } },
  { name: 'a generated image', block: { type: 'generated_image', data: 'AAAA', mimeType: 'image/png' } },
  { name: 'an unaccepted image nested in a tool result', nested: true },
])('NativeFormatter reports what it leaves out: $name', ({ block, nested }) => {
  const text = (value: string): ContentBlock => ({ type: 'text', text: value });
  const toolUse = (id: string): ContentBlock => ({ type: 'tool_use', id, name: 'noop', input: {} }) as ContentBlock;
  const sorted = (indices: Iterable<number>) => [...indices].sort((x, y) => x - y);
  it('names the message it came from', () => {
    const notes = new FidelityNotes();
    const messages: NormalizedRequest['messages'] = nested
      ? [
        { participant: 'User', content: [text('start')] },
        { participant: 'Claude', content: [toolUse('c1')] },
        { participant: 'User', content: [{ type: 'tool_result', toolUseId: 'c1', content: [text('picture'), svgImage] } as ContentBlock] },
        { participant: 'User', content: [text('go')] },
      ]
      : [
        { participant: 'User', content: [text('start')] },
        { participant: 'User', content: [text('listen'), block as unknown as ContentBlock] },
      ];
    new NativeFormatter().buildMessages(messages, { assistantParticipant: 'Claude', participantMode: 'multiuser', fidelity: notes } as any);
    expect(sorted(notes.altered)).toEqual([nested ? 2 : 1]);
    expect(notes.established).toBe(true);
  });
});
