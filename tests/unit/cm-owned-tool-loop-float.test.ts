import { describe, it, expect, vi, afterEach } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { computeCacheWireReceipt, type CacheWireReceipt } from '../../src/cache-wire-receipt.js';
import type {
  NormalizedMessage,
  NormalizedRequest,
  NormalizedResponse,
  ProviderAdapter,
  ProviderRequest,
  ProviderRequestOptions,
  ProviderResponse,
  RoundReport,
  StreamCallbacks,
  ToolResult,
} from '../../src/types/index.js';

const text = (t: string) => ({ type: 'text' as const, text: t });

const user = (t: string, breakpoint = false): NormalizedMessage => ({
  participant: 'User',
  content: [text(t)],
  ...(breakpoint ? { cacheBreakpoint: true } : {}),
});
const reply = (t: string): NormalizedMessage => ({ participant: 'Claude', content: [text(t)] });

function input(userMessages: number, marked: number[]): NormalizedMessage[] {
  const messages: NormalizedMessage[] = [];
  for (let i = 0; i < userMessages; i++) {
    if (i > 0) messages.push(reply(`reply ${i}`));
    messages.push(user(`message ${i}`, marked.includes(i)));
  }
  return messages;
}

function scriptedAdapter(options: { alter?: { call: number; block: (request: any) => unknown } } = {}): { adapter: ProviderAdapter; requests: any[] } {
  const requests: any[] = [];
  const respond = (n: number, request: ProviderRequest): ProviderResponse => ({
    content: n < 2
      ? [{ type: 'tool_use', id: `call-${n + 1}`, name: 'shell', input: { cmd: 'ls' } }]
      : [{ type: 'text', text: 'done' }],
    stopReason: n < 2 ? 'tool_use' : 'end_turn',
    usage: { inputTokens: 1, outputTokens: 1 },
    model: 'claude-sonnet-5',
    rawRequest: request,
    raw: {},
  } as ProviderResponse);
  const adapter = {
    name: 'anthropic',
    reportsContentAlterations: options.alter !== undefined,
    supportsModel: () => true,
    async complete(request: ProviderRequest) { requests.push(request); return respond(requests.length - 1, request); },
    async stream(request: ProviderRequest, callbacks: StreamCallbacks, requestOptions?: ProviderRequestOptions) {
      requests.push(request);
      const n = requests.length - 1;
      if (n === options.alter?.call) requestOptions?.onContentAltered?.(options.alter.block(request));
      if (n >= 2) callbacks.onChunk('done');
      return respond(n, request);
    },
  } as unknown as ProviderAdapter;
  return { adapter, requests };
}

function request(messages: NormalizedMessage[], overrides: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    messages,
    system: 'You are a test agent.',
    config: { model: 'claude-sonnet-5', maxTokens: 128 },
    tools: [{ name: 'shell', description: 'run a command', inputSchema: { type: 'object' } }],
    toolMode: 'native',
    promptCaching: true,
    cacheTtl: '1h',
    cacheMarkers: 'cm-owned',
    assistantParticipant: 'Claude',
    ...overrides,
  } as NormalizedRequest;
}

const results = (calls: Array<{ id: string }>): ToolResult[] =>
  calls.map((c) => ({ toolUseId: c.id, content: 'ok', isError: false }));

type Ended = { outcome: string; response?: NormalizedResponse; rounds: RoundReport[] };
type Drive = (membrane: Membrane, req: NormalizedRequest) => Promise<Ended>;
const paths: Array<[string, Drive]> = [
  ['stream()', async (membrane, req) => {
    try {
      const response = await membrane.stream(req, { onToolCalls: async (calls) => results(calls) });
      return 'aborted' in response ? { outcome: 'aborted', rounds: [] } : { outcome: `ended ${response.stopReason}`, response, rounds: [] };
    } catch (error) {
      return { outcome: `error: ${(error as Error).message}`, rounds: [] };
    }
  }],
  ['streamYielding()', async (membrane, req) => {
    const stream = membrane.streamYielding(req, {});
    const rounds: RoundReport[] = [];
    for await (const event of stream) {
      if (event.type === 'usage' && event.round) rounds.push(event.round);
      if (event.type === 'tool-calls') stream.provideToolResults(results(event.calls));
      else if (event.type === 'complete') return { outcome: `ended ${event.response.stopReason}`, response: event.response, rounds };
      else if (event.type === 'aborted') return { outcome: 'aborted', rounds };
      else if (event.type === 'error') return { outcome: `error: ${event.error.message}`, rounds };
    }
    return { outcome: 'no end', rounds };
  }],
];

function markers(sent: any): string[] {
  const at: string[] = [];
  if (Array.isArray(sent.tools)) sent.tools.forEach((t: any) => { if (t.cache_control) at.push('tools'); });
  if (Array.isArray(sent.system)) sent.system.forEach((b: any) => { if (b.cache_control) at.push('system'); });
  sent.messages.forEach((m: any, mi: number) => {
    (Array.isArray(m.content) ? m.content : []).forEach((b: any) => { if (b.cache_control) at.push(`m${mi}`); });
  });
  return at;
}

const newestMarker = (sent: any) => {
  const content = sent.messages[sent.messages.length - 1].content;
  return content.find((b: any) => b.cache_control)?.cache_control;
};

async function attempt(
  drive: Drive,
  req: NormalizedRequest,
  config: Record<string, unknown> = {},
  adapterOptions: Parameters<typeof scriptedAdapter>[0] = {},
) {
  const { adapter, requests } = scriptedAdapter(adapterOptions);
  const ended = await drive(new Membrane(adapter, config as any), req);
  return { ...ended, requests };
}

async function run(drive: Drive, req: NormalizedRequest, config: Record<string, unknown> = {}): Promise<any[]> {
  const { outcome, requests } = await attempt(drive, req, config);
  expect(outcome).toBe('ended end_turn');
  expect(requests).toHaveLength(3);
  return requests;
}

const markSystemOnLaterCalls = (messagesInFirstCall: number) => ({
  beforeRequest: (_normalized: unknown, provider: any) => {
    if (provider.messages.length <= messagesInFirstCall) return provider;
    const system = typeof provider.system === 'string' ? [{ type: 'text', text: provider.system }] : provider.system;
    return { ...provider, system: system.map((b: any, i: number) => (i === 0 ? { ...b, cache_control: { type: 'ephemeral', ttl: '1h' } } : b)) };
  },
});

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
};

afterEach(() => { vi.restoreAllMocks(); });

describe('cm-owned: the tool loop\'s later calls mark their newest message', () => {
  for (const [path, drive] of paths) {
    it(`${path}: the first call carries only the caller's markers, and each later call adds its newest message, then the previous call's`, async () => {
      const sent = await run(drive, request(input(2, [0, 1])));
      expect(markers(sent[0])).toEqual(['m0', 'm2']);
      expect(markers(sent[1])).toEqual(['m0', 'm2', 'm4']);
      expect(markers(sent[2])).toEqual(['m0', 'm2', 'm4', 'm6']);
    });

    it(`${path}: each call's cache receipt, and the turn's reported marker count, describe the request that call sent, the float included`, async () => {
      const receipts: CacheWireReceipt[] = [];
      const { outcome, response, requests: sent } = await attempt(drive, request(input(2, [0, 1]), { onCacheWireReceipt: (receipt) => { receipts.push(receipt); } }));
      expect(outcome).toBe('ended end_turn');
      expect(receipts.map((receipt) => receipt.markers.length)).toEqual([2, 3, 4]);
      expect(receipts).toEqual(sent.map((call) => computeCacheWireReceipt(call)));
      expect(response?.details?.cache?.markersInRequest).toBe(4);
    });

    it(`${path}: the newest message's marker has the request's cache TTL`, async () => {
      for (const cacheTtl of ['1h', '5m'] as const) {
        const sent = await run(drive, request(input(2, [0, 1]), { cacheTtl }));
        expect(newestMarker(sent[1])).toEqual({ type: 'ephemeral', ttl: cacheTtl });
        expect(newestMarker(sent[2])).toEqual({ type: 'ephemeral', ttl: cacheTtl });
      }
    });

    it(`${path}: with all four slots held by the caller, a later call takes the earliest message marker's slot, and only that one`, async () => {
      const sent = await run(drive, request(input(4, [0, 1, 2, 3])));
      expect(markers(sent[0])).toEqual(['m0', 'm2', 'm4', 'm6']);
      expect(markers(sent[1])).toEqual(['m2', 'm4', 'm6', 'm8']);
      expect(markers(sent[2])).toEqual(['m2', 'm4', 'm6', 'm10']);
    });

    it(`${path}: counts the markers a beforeRequest hook adds, so a hook that marks the system prompt still runs the loop, and the hook is handed the request without the float`, async () => {
      const handed: string[][] = [];
      const hooks = {
        beforeRequest: (_normalized: unknown, provider: any) => {
          handed.push(markers(provider));
          const system = typeof provider.system === 'string' ? [{ type: 'text', text: provider.system }] : provider.system;
          return { ...provider, system: system.map((b: any, i: number) => (i === 0 ? { ...b, cache_control: { type: 'ephemeral', ttl: '1h' } } : b)) };
        },
      };
      const sent = await run(drive, request(input(3, [0, 1, 2])), { hooks });
      expect(markers(sent[0])).toEqual(['system', 'm0', 'm2', 'm4']);
      expect(markers(sent[1])).toEqual(['system', 'm2', 'm4', 'm6']);
      expect(markers(sent[2])).toEqual(['system', 'm2', 'm4', 'm8']);
      expect(handed).toEqual([['m0', 'm2', 'm4'], ['m0', 'm2', 'm4'], ['m0', 'm2', 'm4']]);
    });

    it(`${path}: refuses a later call whose hook takes the caller's markers past four, as it refuses a first call`, async () => {
      const { outcome, requests } = await attempt(drive, request(input(4, [0, 1, 2, 3])), { hooks: markSystemOnLaterCalls(7) });
      expect(outcome).toMatch(/cache_control limit exceeded: 5 markers/);
      expect(requests).toHaveLength(1);
    });

    it(`${path}: refuses a later call whose hook puts its earliest marker on a thinking block, as it refuses a first call`, async () => {
      const hooks = {
        beforeRequest: (_normalized: unknown, provider: any) => {
          if (provider.messages.length <= 7) return provider;
          const messages = provider.messages.map((m: any, mi: number) => {
            if (mi === 0) return { ...m, content: m.content.map(({ cache_control: _dropped, ...b }: any) => b) };
            if (mi === 1) return { ...m, content: [{ type: 'thinking', thinking: 'considered', signature: 'sig', cache_control: { type: 'ephemeral', ttl: '1h' } }, ...m.content] };
            return m;
          });
          return { ...provider, messages };
        },
      };
      const { outcome, requests } = await attempt(drive, request(input(4, [0, 1, 2, 3])), { hooks });
      expect(outcome).toMatch(/cannot be attached to thinking\/redacted_thinking blocks/);
      expect(requests).toHaveLength(1);
    });

    it(`${path}: with all four markers on the system prompt, a later call keeps them and gets no float, with a withheld warning`, async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const hooks = {
        beforeRequest: (_normalized: unknown, provider: any) => ({
          ...provider,
          system: [0, 1, 2, 3].map((i) => ({ type: 'text', text: `part ${i}`, cache_control: { type: 'ephemeral', ttl: '1h' } })),
        }),
      };
      const sent = await run(drive, request(input(1, [])), { hooks });
      for (const call of sent) expect(markers(call)).toEqual(['system', 'system', 'system', 'system']);
      expect(warn.mock.calls.filter((args) => String(args[0]).includes('withheld')).length).toBeGreaterThan(0);
    });

    it(`${path}: places the float on copies, leaving the message objects a hook returned unchanged`, async () => {
      const hooks = { beforeRequest: (_normalized: unknown, provider: any) => ({ ...provider, messages: deepFreeze(structuredClone(provider.messages)) }) };
      const sent = await run(drive, request(input(4, [0, 1, 2, 3])), { hooks });
      expect(markers(sent[1])).toEqual(['m2', 'm4', 'm6', 'm8']);
      expect(markers(sent[2])).toEqual(['m2', 'm4', 'm6', 'm10']);
    });

    it(`${path}: gives no withheld warning when a hook has already marked the newest message`, async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const hooks = {
        beforeRequest: (_normalized: unknown, provider: any) => {
          if (provider.messages.length <= 5) return provider;
          const last = provider.messages.length - 1;
          const messages = provider.messages.map((m: any, mi: number) => (mi === last
            ? { ...m, content: m.content.map((b: any, bi: number) => (bi === m.content.length - 1 ? { ...b, cache_control: { type: 'ephemeral', ttl: '1h' } } : b)) }
            : m));
          return { ...provider, messages };
        },
      };
      const sent = await run(drive, request(input(3, [0, 1, 2])), { hooks });
      expect(markers(sent[1])).toEqual(['m0', 'm2', 'm4', 'm6']);
      expect(warn.mock.calls.filter((args) => String(args[0]).includes('withheld'))).toEqual([]);
    });

    it(`${path}: adds no tools or system marker of its own on any call`, async () => {
      const sent = await run(drive, request(input(1, [])));
      expect(markers(sent[0])).toEqual([]);
      for (const call of sent.slice(1)) {
        expect(markers(call)).not.toContain('tools');
        expect(markers(call)).not.toContain('system');
        expect(markers(call)).toContain(`m${call.messages.length - 1}`);
      }
    });

    it(`${path}: places no float when the request turns it off, or turns prompt caching off`, async () => {
      const off = await run(drive, request(input(2, [0, 1]), { floatingCacheMarker: false }));
      expect(off.map(markers)).toEqual([['m0', 'm2'], ['m0', 'm2'], ['m0', 'm2']]);
      const configOff = await run(drive, request(input(2, [0, 1])), { defaultFloatingCacheMarker: false });
      expect(configOff.map(markers)).toEqual([['m0', 'm2'], ['m0', 'm2'], ['m0', 'm2']]);
      const uncached = await run(drive, request(input(2, [0, 1]), { promptCaching: false }));
      expect(uncached.map(markers)).toEqual([[], [], []]);
    });

    it(`${path}: places no float on a call whose normalizer rewrote the prefix`, async () => {
      const orphan: NormalizedMessage = {
        participant: 'User',
        content: [{ type: 'tool_result' as const, toolUseId: 'never-called', content: 'stray' }],
      };
      const messages = [user('message 0', true), reply('reply 1'), orphan, reply('reply 2'), user('message 2', true)];
      const sent = await run(drive, request(messages));
      expect(markers(sent[1])).toEqual(markers(sent[0]));
      expect(markers(sent[2])).toEqual(markers(sent[0]));
    });
  }
});

describe('cm-owned: fidelity on a floated call', () => {
  it('streamYielding(): an adapter\'s report about a block it was handed on a floated call is attributed to that block\'s message', async () => {
    const { outcome, rounds, requests: sent } = await attempt(paths[1]![1], request(input(2, [0, 1])), {}, { alter: { call: 1, block: (r) => r.messages[0].content[0] } });
    expect(outcome).toBe('ended end_turn');
    expect(markers(sent[1])).toEqual(['m0', 'm2', 'm4']);
    expect(rounds[1]!.fidelity).toBe('established');
    expect(rounds[1]!.altered).toEqual({ messages: [0], injected: [] });
  });

  it('streamYielding(): a report about a block nested in a floated call\'s tool result keeps the round established', async () => {
    const { adapter, requests: sent } = scriptedAdapter({ alter: { call: 1, block: (r) => r.messages.at(-1).content[0].content[0] } });
    const stream = new Membrane(adapter).streamYielding(request(input(2, [0, 1])), {});
    const rounds: RoundReport[] = [];
    let outcome = 'no end';
    for await (const event of stream) {
      if (event.type === 'usage' && event.round) rounds.push(event.round);
      if (event.type === 'tool-calls') {
        stream.provideToolResults(event.calls.map((c) => ({ toolUseId: c.id, content: [{ type: 'text' as const, text: 'ok' }], isError: false })));
      } else if (event.type === 'complete' || event.type === 'aborted' || event.type === 'error') {
        outcome = event.type;
        break;
      }
    }
    expect(outcome).toBe('complete');
    expect(markers(sent[1])).toEqual(['m0', 'm2', 'm4']);
    expect(sent[1].messages.at(-1).content[0].content[0]).toMatchObject({ type: 'text', text: 'ok' });
    expect(rounds[1]!.fidelity).toBe('established');
  });
});

describe('membrane-system keeps its promise', () => {
  for (const [path, drive] of paths) {
    it(`${path}: with all four slots held upstream, the float is withheld and no upstream marker is displaced`, async () => {
      const sent = await run(drive, request(input(4, [0, 1, 2, 3]), { cacheMarkers: 'membrane-system' }));
      for (const call of sent) expect(markers(call)).toEqual(['m0', 'm2', 'm4', 'm6']);
    });
  }
});
