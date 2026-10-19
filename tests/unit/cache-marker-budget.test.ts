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
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { BedrockAdapter } from '../../src/providers/bedrock.js';
import { toolResultContentForRequest } from '../../src/utils/image-media.js';
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

/** A document whose content source holds two text blocks, its last marked
 *  when `markLast`: the API takes a breakpoint there and counts it toward
 *  the four. */
const contentSourceDocument = (markLast: boolean) => ({
  type: 'document',
  source: { type: 'content', content: [
    { type: 'text', text: 'zz part 1' },
    { type: 'text', text: 'zz part 2', ...(markLast ? { cache_control: marked } : {}) },
  ] },
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

  it("sees a marker in a document's content source, at the top and inside a tool_result", () => {
    expect(countWireCacheMarkers({ messages: [
      { role: 'user', content: [contentSourceDocument(true)] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'zz-t1', content: [contentSourceDocument(true)] }] },
    ] })).toBe(2);
    // On any of its blocks, including one whose breakpoint the adapters will
    // strip, since it isn't the source's last.
    expect(countWireCacheMarkers({ messages: [{ role: 'user', content: [{
      type: 'document',
      source: { type: 'content', content: [{ type: 'text', text: 'zz first', cache_control: marked }, { type: 'text', text: 'zz last' }] },
    }] }] })).toBe(1);
    // A document's blocks are its content source's: a `content` of its own
    // is nothing the API reads on one.
    expect(countWireCacheMarkers({ messages: [{ role: 'user', content: [{
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: 'zz' },
      content: [{ type: 'text', text: 'zz stray', cache_control: marked }],
    }] }] })).toBe(0);
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

  it("withholds both fallbacks when the only marker sits in a document's content source in a tool result", async () => {
    const messages: NormalizedMessage[] = [
      user('zz go'),
      assistantToolCall('zz-t1'),
      { participant: 'zzOperator', content: [{ type: 'tool_result', toolUseId: 'zz-t1', content: [contentSourceDocument(true)] }] as any },
    ];
    // The native tool loop's gates.
    const providerRequest = build(makeRequest(), messages);
    expect(providerRequest.tools.some((t: any) => t.cache_control)).toBe(false);
    expect(JSON.stringify(providerRequest.system)).not.toContain('cache_control');
    expect(countWireCacheMarkers(providerRequest)).toBe(1);
    // The native formatter's, through complete().
    const { adapter, captured } = captureAdapter();
    await new Membrane(adapter as any).complete(makeRequest({ messages }));
    expect(JSON.stringify(captured[0].system)).not.toContain('cache_control');
    expect(countWireCacheMarkers(captured[0])).toBe(1);
  });

  it("counts a breakpoint the adapters will leave out of a content source: both gates stand down, and neither wire carries one", () => {
    // A breakpoint on a source block that isn't its last, which the API refuses there.
    const leftOut = { type: 'document', source: { type: 'content', content: [
      { type: 'text', text: 'zz part 1', cache_control: marked },
      { type: 'text', text: 'zz part 2' },
    ] } };
    const messages: NormalizedMessage[] = [
      user('zz go'),
      assistantToolCall('zz-t1'),
      { participant: 'zzOperator', content: [{ type: 'tool_result', toolUseId: 'zz-t1', content: [leftOut] }] as any },
    ];
    const providerRequest = build(makeRequest(), messages);
    expect(countWireCacheMarkers(providerRequest)).toBe(1);
    expect(providerRequest.tools.some((t: any) => t.cache_control)).toBe(false);
    expect(JSON.stringify(providerRequest.system)).not.toContain('cache_control');
    const anthropic = (new AnthropicAdapter({ apiKey: 'zz', cacheKeepalive: { enabled: false } }) as any).buildRequest(providerRequest);
    const bedrock = (new BedrockAdapter({ accessKeyId: 'zz', secretAccessKey: 'zz', region: 'us-west-2' }) as any).buildRequest(providerRequest, undefined);
    expect(JSON.stringify(anthropic.messages)).toContain('zz part 1');
    expect(wireMarkerCensus(anthropic)).toBe(0);
    expect(JSON.stringify(bedrock.messages)).toContain('zz part 1');
    expect(wireMarkerCensus(bedrock)).toBe(0);
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

  it("drops a marker in a document's content source when it is shallowest", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const document = contentSourceDocument(true);
    const wire = {
      messages: [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'zz-t1', content: [document] }] },
        ...[1, 2, 3, 4].map((n) => ({ role: 'user', content: [{ type: 'text', text: `zz m${n}`, cache_control: marked }] })),
      ],
    };
    expect(clampCacheMarkers(wire, 'zz-test-site')).toEqual({ total: MAX_CACHE_BREAKPOINTS, dropped: 1, strippedFromThinking: 0 });
    expect((document.source.content[1] as any).cache_control).toBeUndefined();
    expect(wireMarkerCensus(wire)).toBe(MAX_CACHE_BREAKPOINTS);
    expect(warn).toHaveBeenCalledTimes(1);
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


  it("leaves a tool result's caller-owned blocks intact when the clamp drops their markers: a search result's content, a document's content source", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { adapter, captured } = captureAdapter();
    const membrane = new Membrane(adapter as any);
    // Stored blocks a caller hands in turn after turn: an in-place strip of
    // either would delete its breakpoint for good.
    const hit = { type: 'text', text: 'zz hit', cache_control: marked };
    const document = contentSourceDocument(true);
    const messages: NormalizedMessage[] = [
      user('zz go'),
      {
        participant: 'Claude',
        content: [
          { type: 'tool_use' as const, id: 'zz-t1', name: 'zz_shell', input: {} },
          { type: 'tool_use' as const, id: 'zz-t2', name: 'zz_shell', input: {} },
        ],
      },
      {
        participant: 'zzOperator',
        content: [
          { type: 'tool_result', toolUseId: 'zz-t1', content: [{ type: 'search_result', source: 'zz', title: 'zz', content: [hit] }] },
          { type: 'tool_result', toolUseId: 'zz-t2', content: [document] },
        ] as any,
      },
      ...[1, 2, 3, 4].map((n) => ({
        participant: 'zzOperator',
        content: [{ type: 'text', text: `zz later ${n}`, cache_control: marked } as any],
      })),
    ];

    await membrane.complete(makeRequest({ messages }));

    // The two nested markers are the shallowest of six, and the clamp drops
    // them from its own copies, which still go.
    expect(countWireCacheMarkers(captured[0])).toBe(MAX_CACHE_BREAKPOINTS);
    const results = captured[0].messages
      .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
      .filter((b: any) => b.type === 'tool_result');
    const [sentHit] = results[0].content[0].content;
    const sentPart = results[1].content[0].source.content[1];
    expect(sentHit).toEqual({ type: 'text', text: 'zz hit' });
    expect(sentPart).toEqual({ type: 'text', text: 'zz part 2' });
    expect(hit.cache_control).toEqual(marked);
    expect((document.source.content[1] as any).cache_control).toEqual(marked);
  });

  it("copies a tool result's blocks as deep as the walk reaches, an image's own content included", () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
    const given: any[] = [
      { type: 'search_result', source: 'zz', title: 'zz', content: [{ type: 'text', text: 'zz hit', cache_control: marked }] },
      contentSourceDocument(true),
      { type: 'image', source: { type: 'base64', data: png, mediaType: 'image/png' }, content: [{ type: 'text', text: 'zz odd', cache_control: marked }] },
    ];
    const copied = toolResultContentForRequest(given) as any[];
    expect(copied[0].content[0]).toEqual(given[0].content[0]);
    expect(copied[0].content[0]).not.toBe(given[0].content[0]);
    expect(copied[1].source.content[1]).toEqual(given[1].source.content[1]);
    expect(copied[1].source.content[1]).not.toBe(given[1].source.content[1]);
    expect(copied[2].content[0]).toEqual(given[2].content[0]);
    expect(copied[2].content[0]).not.toBe(given[2].content[0]);
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
