/**
 * Cache-marker budget: Anthropic accepts at most 4 cache_control breakpoints
 * per request and hard-400s the fifth ("A maximum of 4 blocks with
 * cache_control may be provided. Found 5." — measured live 2026-08-25 against
 * claude-haiku-4-5). Membrane attaches markers at nine sites across three
 * builders; before this suite nothing compared the TOTAL to 4.
 *
 * One wire recount is computed at the three moments that matter:
 *   - before the tools/system fallback decision, so caller-marked system
 *     blocks suppress the fallback instead of stacking on top of it
 *   - inside the XML formatter, which had no budget at all
 *   - as a final clamp at the last exit before every adapter call, which is
 *     also the runtime assertion that no marker ever rides a thinking block
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import {
  countWireCacheMarkers,
  clampCacheMarkers,
  ownSystemBlocks,
  MAX_CACHE_BREAKPOINTS,
  MAX_NESTED_CONTENT_DEPTH,
} from '../../src/utils/cache-marker-budget.js';
import type { NormalizedMessage, NormalizedRequest } from '../../src/types/index.js';

const text = (t: string) => ({ type: 'text' as const, text: t });
const marked = { type: 'ephemeral' as const };

const user = (t: string, bp = false): NormalizedMessage => ({
  participant: 'zzOperator',
  content: [text(t)],
  ...(bp ? { cacheBreakpoint: true } : {}),
});

const assistantToolCall = (id: string): NormalizedMessage => ({
  participant: 'Claude',
  content: [text('zz running a tool'), { type: 'tool_use' as const, id, name: 'zz_shell', input: {} }],
});

const toolResults = (id: string): NormalizedMessage => ({
  participant: 'zzOperator',
  content: [{ type: 'tool_result' as const, toolUseId: id, content: 'zz ok' }],
});

function makeRequest(overrides: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    messages: [],
    system: 'zz system prompt',
    config: { model: 'claude-haiku-4-5-20251001', maxTokens: 128 },
    tools: [{ name: 'zz_shell', description: 'zz run a command', inputSchema: { type: 'object' } }],
    promptCaching: true,
    assistantParticipant: 'Claude',
    ...overrides,
  } as NormalizedRequest;
}

function build(request: NormalizedRequest, messages: NormalizedMessage[], rebuild = false) {
  const membrane = new Membrane({ name: 'zz-fake-adapter' } as any);
  return (membrane as any).buildNativeToolRequest(request, messages, rebuild);
}

/** Capture what the adapter is actually handed by streamOnce. */
function captureAdapter() {
  const captured: any[] = [];
  const adapter = {
    name: 'zz-capture',
    supportsModel: () => true,
    complete: async (request: any) => {
      captured.push(request);
      return { content: [text('zz answer')], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, raw: {} };
    },
    stream: async (request: any, callbacks: any) => {
      captured.push(request);
      callbacks.onChunk('zz answer');
      return { content: [text('zz answer')], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, raw: {} };
    },
  };
  return { adapter, captured };
}

/**
 * Count `cache_control` on the wire WITHOUT asking the module under test —
 * the module's own blindness is the bug, so a test that counted with it could
 * not fail on the unfixed tip.
 */
const wireMarkerCensus = (wire: unknown): number =>
  JSON.stringify(wire).split('"cache_control"').length - 1;

/**
 * Five real wire markers in document order: tools, system, two message text
 * blocks, and a fifth riding a block inside `tool_result.content`. The
 * top-level walk sees only four of them.
 */
const nestedOverBudgetWire = () => ({
  model: 'claude-haiku-4-5-20251001',
  tools: [{ name: 'zz_shell', cache_control: marked }],
  system: [{ type: 'text', text: 'zz s1', cache_control: marked }],
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'zz m1', cache_control: marked }] },
    { role: 'user', content: [{ type: 'text', text: 'zz m2', cache_control: marked }] },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'zz-t1',
          content: [{ type: 'text', text: 'zz nested result', cache_control: marked }],
        },
      ],
    },
  ],
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('countWireCacheMarkers', () => {
  it('counts tools, system blocks and message blocks alike', () => {
    expect(
      countWireCacheMarkers({
        tools: [{ name: 'zz_shell', cache_control: marked }],
        system: [{ type: 'text', text: 'zz s1', cache_control: marked }, { type: 'text', text: 'zz s2' }],
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'zz m1', cache_control: marked }] },
          { role: 'assistant', content: 'zz plain string content' },
        ],
      })
    ).toBe(3);
  });

  it('is zero for an unmarked request', () => {
    expect(countWireCacheMarkers({ system: 'zz plain system', messages: [{ role: 'user', content: 'zz hi' }] })).toBe(0);
  });

  it('sees a marker nested inside tool_result.content, not just top-level blocks', () => {
    // `ToolResultContent.content` is typed `string | ContentBlock[]` and the
    // native builder passes it through verbatim, so a nested marker is a real
    // wire marker. Four top-level plus one nested is five on the wire.
    expect(countWireCacheMarkers(nestedOverBudgetWire())).toBe(5);
  });

  it('stops descending at the nested-content depth cap', () => {
    // The cap is what makes the walk total on caller-built structures
    // (including cyclic ones); a marker below it is out of the belt's reach
    // and this test is the honest record of where that line sits.
    let deepest: Record<string, unknown> = { type: 'text', text: 'zz too deep', cache_control: marked };
    for (let level = 0; level < MAX_NESTED_CONTENT_DEPTH + 1; level++) {
      deepest = { type: 'tool_result', tool_use_id: `zz-t${level}`, content: [deepest] };
    }
    expect(countWireCacheMarkers({ messages: [{ role: 'user', content: [deepest] }] })).toBe(0);

    let atCap: Record<string, unknown> = { type: 'text', text: 'zz at the cap', cache_control: marked };
    for (let level = 0; level < MAX_NESTED_CONTENT_DEPTH; level++) {
      atCap = { type: 'tool_result', tool_use_id: `zz-t${level}`, content: [atCap] };
    }
    expect(countWireCacheMarkers({ messages: [{ role: 'user', content: [atCap] }] })).toBe(1);
  });
});

describe('clampCacheMarkers', () => {
  it('keeps the 4 DEEPEST markers and drops the rest, loudly', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wire = {
      tools: [{ name: 'zz_shell', cache_control: marked }],
      system: [{ type: 'text', text: 'zz s1', cache_control: marked }],
      messages: [1, 2, 3, 4].map((n) => ({
        role: 'user',
        content: [{ type: 'text', text: `zz m${n}`, cache_control: marked }],
      })),
    };
    const result = clampCacheMarkers(wire, 'zz-test-site');

    expect(result.dropped).toBe(2);
    expect(countWireCacheMarkers(wire)).toBe(MAX_CACHE_BREAKPOINTS);
    // The shallowest two (tools, then system) lost theirs; every message kept one.
    expect(wire.tools[0]!.cache_control).toBeUndefined();
    expect((wire.system[0] as any).cache_control).toBeUndefined();
    expect(wire.messages.every((m) => (m.content[0] as any).cache_control)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('strips a marker riding a thinking block before counting (the API rejects it)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wire = {
      messages: [
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'zz reasoning', cache_control: marked }] },
        { role: 'user', content: [{ type: 'text', text: 'zz m1', cache_control: marked }] },
      ],
    };
    const result = clampCacheMarkers(wire, 'zz-test-site');

    expect(result.strippedFromThinking).toBe(1);
    expect(countWireCacheMarkers(wire)).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('is a no-op (and silent) at or under budget', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wire = { messages: [{ role: 'user', content: [{ type: 'text', text: 'zz m1', cache_control: marked }] }] };
    expect(clampCacheMarkers(wire, 'zz-test-site')).toEqual({ total: 1, dropped: 0, strippedFromThinking: 0 });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('tools/system fallback gate (caller-marked system blocks are real wire markers)', () => {
  it('withholds BOTH fallbacks when the caller marked its own system blocks', () => {
    const callerMarkedSystem = [
      { type: 'text', text: 'zz s1', cache_control: marked },
      { type: 'text', text: 'zz s2', cache_control: marked },
      { type: 'text', text: 'zz s3', cache_control: marked },
    ] as any;
    const providerRequest = build(makeRequest({ system: callerMarkedSystem }), [user('zz go')]);

    // 3 caller markers, nothing added: the fallback would have made it 5.
    expect(countWireCacheMarkers(providerRequest)).toBe(3);
    expect(providerRequest.tools.some((t: any) => t.cache_control)).toBe(false);
    expect((providerRequest.system as any[]).filter((b) => b.cache_control)).toHaveLength(3);
  });

  it('still falls back when nothing anywhere is marked', () => {
    const providerRequest = build(makeRequest(), [user('zz go')]);
    expect(providerRequest.tools.some((t: any) => t.cache_control)).toBe(true);
    expect((providerRequest.system as any[]).some((b) => b.cache_control)).toBe(true);
    expect(countWireCacheMarkers(providerRequest)).toBe(2);
  });

  it('withholds the fallback when a stale passthrough marker rides a message block', () => {
    const staleMarked: NormalizedMessage = {
      participant: 'zzOperator',
      content: [{ type: 'text', text: 'zz imported turn', cache_control: marked } as any],
    };
    const providerRequest = build(makeRequest(), [staleMarked, user('zz go')]);
    expect(providerRequest.tools.some((t: any) => t.cache_control)).toBe(false);
    expect(countWireCacheMarkers(providerRequest)).toBe(1);
  });
});

describe('final clamp at the last exit before the adapter', () => {
  it('clamps a request the beforeRequest hook pushed over budget (complete)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { adapter, captured } = captureAdapter();
    const membrane = new Membrane(adapter as any, {
      hooks: {
        beforeRequest: (_normalized: unknown, providerRequest: any) => {
          // A hook that stamps its own prefix markers is invisible to every
          // builder-side budget — only the last-exit clamp can see it.
          providerRequest.system = [1, 2, 3, 4, 5, 6].map((n) => ({
            type: 'text',
            text: `zz hook system ${n}`,
            cache_control: marked,
          }));
          return providerRequest;
        },
      },
    } as any);

    await membrane.complete(makeRequest({ messages: [user('zz one'), user('zz two')] }));

    expect(captured).toHaveLength(1);
    expect(countWireCacheMarkers(captured[0])).toBeLessThanOrEqual(MAX_CACHE_BREAKPOINTS);
    expect(warn).toHaveBeenCalled();
  });

  it('clamps five stale passthrough markers before the adapter sees them (stream)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { adapter, captured } = captureAdapter();
    const membrane = new Membrane(adapter as any);
    const staleRequest = {
      model: 'claude-haiku-4-5-20251001',
      messages: [1, 2, 3, 4, 5].map((n) => ({
        role: 'user',
        content: [{ type: 'text', text: `zz stale ${n}`, cache_control: marked }],
      })),
    };

    await (membrane as any).streamOnce(staleRequest, { onChunk: () => {} }, {
      normalizedRequest: makeRequest(),
    });

    expect(countWireCacheMarkers(captured[0])).toBe(MAX_CACHE_BREAKPOINTS);
    expect(warn).toHaveBeenCalled();
  });
});

describe('nested markers are clamped exactly like top-level ones', () => {
  it('drops the shallowest and keeps the nested marker when it is deepest', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wire = nestedOverBudgetWire();
    const result = clampCacheMarkers(wire, 'zz-test-site');

    // Document order governs wherever the marker sits: the tools marker is
    // shallowest and loses; the nested one is deepest and survives.
    expect(result).toEqual({ total: MAX_CACHE_BREAKPOINTS, dropped: 1, strippedFromThinking: 0 });
    expect(wireMarkerCensus(wire)).toBe(MAX_CACHE_BREAKPOINTS);
    expect((wire.tools[0] as any).cache_control).toBeUndefined();
    expect((wire.messages[2]!.content[0] as any).content[0].cache_control).toBeDefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('clamps the nested marker before the adapter sees it, and tallies the truth', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { adapter, captured } = captureAdapter();
    const membrane = new Membrane(adapter as any);
    const tallies: number[] = [];

    await (membrane as any).streamOnce(nestedOverBudgetWire(), { onChunk: () => {} }, {
      normalizedRequest: makeRequest(),
      onWireCacheMarkers: (n: number) => tallies.push(n),
    });

    // Unfixed, five markers ride to the wire while the tally reports four.
    expect(wireMarkerCensus(captured[0])).toBe(MAX_CACHE_BREAKPOINTS);
    expect(tallies).toEqual([MAX_CACHE_BREAKPOINTS]);
    expect(warn).toHaveBeenCalled();
  });

  it('leaves a request with only top-level markers byte-unchanged', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wire = {
      tools: [{ name: 'zz_shell', cache_control: marked }],
      system: [{ type: 'text', text: 'zz s1', cache_control: marked }],
      messages: [1, 2].map((n) => ({
        role: 'user',
        content: [{ type: 'text', text: `zz m${n}`, cache_control: marked }],
      })),
    };
    const before = JSON.stringify(wire);

    expect(clampCacheMarkers(wire, 'zz-test-site'))
      .toEqual({ total: MAX_CACHE_BREAKPOINTS, dropped: 0, strippedFromThinking: 0 });
    expect(JSON.stringify(wire)).toBe(before);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('the clamp never reaches back into the caller request', () => {
  it('owns caller system blocks down to the nested grain the clamp now reaches', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // A caller system block whose own `content` array carries the marker: the
    // clamp can now see that marker, so ownership has to cover it too, or an
    // over-budget turn deletes the caller's breakpoint permanently.
    const callerSystem = [
      {
        type: 'text',
        text: 'zz caller system',
        content: [{ type: 'text', text: 'zz caller nested', cache_control: marked }],
      },
    ];
    const owned = ownSystemBlocks(callerSystem) as any[];

    const wire = {
      system: owned,
      messages: [1, 2, 3, 4].map((n) => ({
        role: 'user',
        content: [{ type: 'text', text: `zz m${n}`, cache_control: marked }],
      })),
    };
    expect(clampCacheMarkers(wire, 'zz-test-site').dropped).toBe(1);
    expect(callerSystem[0]!.content[0]!.cache_control).toBeDefined();
  });


  it('leaves a caller-owned system array intact when the wire clamp drops markers', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { adapter, captured } = captureAdapter();
    const membrane = new Membrane(adapter as any);
    // A caller that reuses one marked system array across turns: an
    // in-place strip here would silently delete its breakpoints forever.
    const callerSystem = [1, 2, 3, 4, 5].map((n) => ({
      type: 'text',
      text: `zz caller system ${n}`,
      cache_control: marked,
    }));

    const providerRequest = build(makeRequest({ system: callerSystem as any }), [user('zz go')]);
    await (membrane as any).streamOnce(providerRequest, { onChunk: () => {} }, {
      normalizedRequest: makeRequest(),
    });

    expect(countWireCacheMarkers(captured[0])).toBe(MAX_CACHE_BREAKPOINTS);
    expect(callerSystem.filter((b) => b.cache_control)).toHaveLength(5);
  });
});

describe('float stand-down covers every prefix-rewriting normalizer repair', () => {
  it('stands down when a [pending] tool_result was synthesized', () => {
    const providerRequest = build(makeRequest(), [user('zz go', true), assistantToolCall('zz-t1')], true);
    expect(countWireCacheMarkers(providerRequest)).toBe(1);
  });

  it('stands down when an orphan tool_result was textified', () => {
    // The orphan's bytes are REWRITTEN by the normalizer ("[orphan
    // tool_result for …]"), so a marker placed at or past it caches a prefix
    // that changes the moment the real pairing arrives.
    const orphan: NormalizedMessage = {
      participant: 'zzOperator',
      content: [{ type: 'tool_result' as const, toolUseId: 'zz-never-called', content: 'zz stray' }],
    };
    const messages = [user('zz go', true), assistantToolCall('zz-t1'), toolResults('zz-t1'), orphan];
    const providerRequest = build(makeRequest(), messages, true);
    expect(countWireCacheMarkers(providerRequest)).toBe(1);
  });
});
