import { describe, it, expect, vi, afterEach } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { computeCacheWireReceipt, type CacheWireReceipt } from '../../src/cache-wire-receipt.js';
import { OpenRouterAdapter } from '../../src/providers/openrouter.js';
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
    floatingCacheMarker: true,
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

function markerTtls(sent: any): string[] {
  const at: string[] = [];
  const ttl = (b: any) => b.cache_control.ttl ?? '5m';
  if (Array.isArray(sent.tools)) sent.tools.forEach((t: any) => { if (t.cache_control) at.push(`tools:${ttl(t)}`); });
  if (Array.isArray(sent.system)) sent.system.forEach((b: any) => { if (b.cache_control) at.push(`system:${ttl(b)}`); });
  sent.messages.forEach((m: any, mi: number) => {
    (Array.isArray(m.content) ? m.content : []).forEach((b: any) => { if (b.cache_control) at.push(`m${mi}:${ttl(b)}`); });
  });
  return at;
}

const ttlHook = (system: '5m' | '1h' | undefined, messageTtl: (mi: number) => '5m' | '1h') => ({
  beforeRequest: (_normalized: unknown, provider: any) => {
    const sys = typeof provider.system === 'string' ? [{ type: 'text', text: provider.system }] : provider.system;
    return {
      ...provider,
      system: system ? sys.map((b: any, i: number) => (i === 0 ? { ...b, cache_control: { type: 'ephemeral', ttl: system } } : b)) : provider.system,
      messages: provider.messages.map((m: any, mi: number) => ({
        ...m,
        content: Array.isArray(m.content)
          ? m.content.map((b: any) => (b.cache_control ? { ...b, cache_control: { type: 'ephemeral', ttl: messageTtl(mi) } } : b))
          : m.content,
      })),
    };
  },
});

function ttlOrderHolds(sent: any): boolean {
  let shortSeen = false;
  const visit = (b: any): boolean => {
    if (!b || typeof b !== 'object') return true;
    if (b.cache_control) {
      const long = b.cache_control.ttl === '1h';
      if (long && shortSeen) return false;
      if (!long) shortSeen = true;
    }
    return Array.isArray(b.content) ? b.content.every(visit) : true;
  };
  return [...(sent.tools ?? []), ...(Array.isArray(sent.system) ? sent.system : []), ...sent.messages.flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))].every(visit);
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
      const configOff = await run(drive, request(input(2, [0, 1]), { floatingCacheMarker: undefined }), { defaultFloatingCacheMarker: false });
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

describe('cm-owned: the float is the caller\'s to ask for', () => {
  for (const [path, drive] of paths) {
    it(`${path}: left unset, every call carries only the caller's markers, all four of them when it placed four`, async () => {
      const sent = await run(drive, request(input(2, [0, 1]), { floatingCacheMarker: undefined }));
      for (const call of sent) expect(markers(call)).toEqual(['m0', 'm2']);
      const four = await run(drive, request(input(4, [0, 1, 2, 3]), { floatingCacheMarker: undefined }));
      for (const call of four) expect(markers(call)).toEqual(['m0', 'm2', 'm4', 'm6']);
    });

    it(`${path}: a config default of true asks for it, and a request's false turns it off again`, async () => {
      const on = await run(drive, request(input(2, [0, 1]), { floatingCacheMarker: undefined }), { defaultFloatingCacheMarker: true });
      expect(markers(on[1])).toEqual(['m0', 'm2', 'm4']);
      const off = await run(drive, request(input(2, [0, 1]), { floatingCacheMarker: false }), { defaultFloatingCacheMarker: true });
      for (const call of off) expect(markers(call)).toEqual(['m0', 'm2']);
    });
  }
});

describe('the float never puts a longer TTL after a shorter one', () => {
  for (const [path, drive] of paths) {
    it(`${path}: cm-owned, free slots: behind a 5m system marker the floats go at 5m, though the request's cacheTtl is 1h`, async () => {
      const sent = await run(drive, request(input(2, [])), { hooks: ttlHook('5m', () => '1h') });
      expect(markerTtls(sent[0])).toEqual(['system:5m']);
      expect(markerTtls(sent[1])).toEqual(['system:5m', 'm2:5m', 'm4:5m']);
      expect(markerTtls(sent[2])).toEqual(['system:5m', 'm4:5m', 'm6:5m']);
    });

    it(`${path}: cm-owned, all four slots: taking the 1h marker leaves 5m ones, so the float goes at 5m`, async () => {
      const sent = await run(drive, request(input(4, [0, 1, 2, 3])), { hooks: ttlHook(undefined, (mi) => (mi === 0 ? '1h' : '5m')) });
      expect(markerTtls(sent[0])).toEqual(['m0:1h', 'm2:5m', 'm4:5m', 'm6:5m']);
      expect(markerTtls(sent[1])).toEqual(['m2:5m', 'm4:5m', 'm6:5m', 'm8:5m']);
      expect(markerTtls(sent[2])).toEqual(['m2:5m', 'm4:5m', 'm6:5m', 'm10:5m']);
    });

    it(`${path}: cm-owned, every marker at the request's 1h: the float keeps 1h`, async () => {
      const sent = await run(drive, request(input(2, [0, 1])));
      expect(markerTtls(sent[1])).toEqual(['m0:1h', 'm2:1h', 'm4:1h']);
    });

    it(`${path}: cm-owned: each float takes its TTL from the markers before it, so a 1h marker after the earlier float keeps that float at 1h`, async () => {
      const hooks = {
        beforeRequest: (_normalized: unknown, provider: any) => {
          if (provider.messages.length <= 3) return provider;
          const last = provider.messages.length - 1;
          const messages = provider.messages.map((m: any, mi: number) => {
            if (mi === last - 1) return { ...m, content: m.content.map((b: any) => ({ ...b, cache_control: { type: 'ephemeral', ttl: '1h' } })) };
            if (mi === last) return { ...m, content: m.content.map((b: any) => ({ ...b, content: [{ type: 'text', text: 'ok', cache_control: { type: 'ephemeral', ttl: '5m' } }] })) };
            return m;
          });
          return { ...provider, messages };
        },
      };
      const sent = await run(drive, request(input(2, [])), { hooks });
      expect(markerTtls(sent[1])).toEqual(['m2:1h', 'm3:1h', 'm4:1h']);
      for (const call of sent) expect(ttlOrderHolds(call)).toBe(true);
    });

    it(`${path}: cm-owned: with a 5m cacheTtl, no float goes where a 1h marker would follow it`, async () => {
      const hooks = {
        beforeRequest: (_normalized: unknown, provider: any) => {
          if (provider.messages.length <= 3) return provider;
          const last = provider.messages.length - 1;
          return { ...provider, messages: provider.messages.map((m: any, mi: number) => (mi === last - 1 ? { ...m, content: m.content.map((b: any) => ({ ...b, cache_control: { type: 'ephemeral', ttl: '1h' } })) } : m)) };
        },
      };
      const sent = await run(drive, request(input(2, []), { cacheTtl: '5m' }), { hooks });
      expect(markerTtls(sent[1])).toEqual(['m3:1h', 'm4:5m']);
      expect(markerTtls(sent[2])).toEqual(['m5:1h', 'm6:5m']);
      for (const call of sent) expect(ttlOrderHolds(call)).toBe(true);
    });

    it(`${path}: cm-owned, all four slots: no caller marker is taken for a newest float that couldn't be placed`, async () => {
      const hooks = {
        beforeRequest: (_normalized: unknown, provider: any) => {
          const last = provider.messages.length - 1;
          const messages = provider.messages.map((m: any, mi: number) => ({
            ...m,
            content: m.content.map((b: any) => {
              if (b.cache_control) return { ...b, cache_control: { type: 'ephemeral', ttl: '1h' } };
              if (mi === last && provider.messages.length > 7 && b.type === 'tool_result') {
                return { ...b, content: [{ type: 'text', text: 'ok', cache_control: { type: 'ephemeral', ttl: '1h' } }] };
              }
              return b;
            }),
          }));
          return { ...provider, messages };
        },
      };
      const sent = await run(drive, request(input(4, [0, 1, 2]), { cacheTtl: '5m' }), { hooks });
      expect(markers(sent[1])).toEqual(['m0', 'm2', 'm4']);
      expect(markers(sent[2])).toEqual(['m0', 'm2', 'm4']);
      for (const call of sent.slice(1)) expect(JSON.stringify(call).match(/"cache_control"/g)).toHaveLength(4);
      for (const call of sent) expect(ttlOrderHolds(call)).toBe(true);
    });

    it(`${path}: membrane-system: behind a message block that carries its own marker with no ttl, the floats go at 5m`, async () => {
      const messages = input(2, []);
      messages[0] = { ...messages[0]!, content: [{ type: 'text', text: 'message 0', cache_control: { type: 'ephemeral' } }] };
      const sent = await run(drive, request(messages, { cacheMarkers: 'membrane-system' }));
      for (const call of sent.slice(1)) {
        const floats = markerTtls(call).filter((m) => /^m[1-9]/.test(m));
        expect(floats.length).toBeGreaterThan(0);
        for (const m of floats) expect(m).toMatch(/:5m$/);
      }
    });
  }
});

describe('an adapter that sends no marker on a tool result (OpenRouter)', () => {
  const real = new OpenRouterAdapter({ apiKey: 'test' });
  const openRouterRun = async (drive: Drive, req: NormalizedRequest) => {
    const { adapter, requests } = scriptedAdapter();
    Object.assign(adapter, { sendsCacheMarkersOn: real.sendsCacheMarkersOn });
    const receipts: CacheWireReceipt[] = [];
    const ended = await drive(new Membrane(adapter, {} as any), { ...req, onCacheWireReceipt: (receipt: CacheWireReceipt) => { receipts.push(receipt); } } as NormalizedRequest);
    expect(ended.outcome).toBe('ended end_turn');
    const sentByOpenRouter = requests.map((call) => (JSON.stringify((real as any).buildRequest(call)).match(/"cache_control"/g) ?? []).length);
    return { requests, receipts, sentByOpenRouter };
  };

  for (const [path, drive] of paths) {
    it(`${path}: with all four slots held, a later call takes nothing, and OpenRouter's body sends the caller's four markers, as the receipt says`, async () => {
      const { requests, receipts, sentByOpenRouter } = await openRouterRun(drive, request(input(4, [0, 1, 2, 3])));
      for (const call of requests) expect(markers(call)).toEqual(['m0', 'm2', 'm4', 'm6']);
      expect(sentByOpenRouter).toEqual([4, 4, 4]);
      expect(receipts.map((receipt) => receipt.markers.length)).toEqual([4, 4, 4]);
    });

    it(`${path}: with free slots, a message before the calling turn that ends in an image gets no float either`, async () => {
      const messages = input(2, [0]);
      messages[2] = { ...messages[2]!, content: [text('message 1'), { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'iVBORw0KGgo=' } } as any] };
      const { requests, receipts, sentByOpenRouter } = await openRouterRun(drive, request(messages));
      for (const call of requests) expect(markers(call)).toEqual(['m0']);
      expect(sentByOpenRouter).toEqual([1, 1, 1]);
      expect(receipts.map((receipt) => receipt.markers.length)).toEqual([1, 1, 1]);
    });

    it(`${path}: with free slots, the tool-results message gets no float, while the message before the calling turn still gets one it can carry`, async () => {
      const { requests, receipts, sentByOpenRouter } = await openRouterRun(drive, request(input(2, [0])));
      expect(markers(requests[0])).toEqual(['m0']);
      expect(markers(requests[1])).toEqual(['m0', 'm2']);
      expect(markers(requests[2])).toEqual(['m0']);
      expect(sentByOpenRouter).toEqual([1, 2, 1]);
      expect(receipts.map((receipt) => receipt.markers.length)).toEqual([1, 2, 1]);
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
