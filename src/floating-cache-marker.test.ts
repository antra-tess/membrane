/**
 * Floating cache marker: incremental prompt caching inside the native
 * tool loop (see the doctrine block in buildNativeToolRequest).
 *
 * Context strategies place breakpoints once per turn at compile time; the
 * tool loop rebuilds the request every round with an append-only suffix
 * the strategy never saw. The float rides the newest message using only
 * the RESIDUAL breakpoint budget — upstream markers are never displaced.
 * Motivating incident: qa-ops 2026-08-20, ~5.3M uncached tokens in 18min
 * from two subagents whose single marker sat at message 2 of 61.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Membrane } from './membrane.js';
import type { NormalizedRequest, NormalizedMessage } from './types/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const text = (t: string) => ({ type: 'text' as const, text: t });

const user = (t: string, bp = false): NormalizedMessage => ({
  participant: 'User',
  content: [text(t)],
  ...(bp ? { cacheBreakpoint: true } : {}),
});

const assistantToolCall = (id: string): NormalizedMessage => ({
  participant: 'Claude',
  content: [
    text('running a tool'),
    { type: 'tool_use' as const, id, name: 'shell', input: { cmd: 'ls' } },
  ],
});

const toolResults = (id: string, bp = false): NormalizedMessage => ({
  participant: 'User',
  content: [{ type: 'tool_result' as const, toolUseId: id, content: 'ok' }],
  ...(bp ? { cacheBreakpoint: true } : {}),
});

/** A turn: marked kickoff + `rounds` completed tool rounds. */
function turn(rounds: number, kickoffMarked = true): NormalizedMessage[] {
  const messages: NormalizedMessage[] = [user('do the thing', kickoffMarked)];
  for (let i = 1; i <= rounds; i++) {
    messages.push(assistantToolCall(`t${i}`), toolResults(`t${i}`));
  }
  return messages;
}

function makeRequest(overrides: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    messages: [],
    system: 'You are a test agent.',
    config: { model: 'claude-sonnet-5', maxTokens: 128 },
    tools: [{ name: 'shell', description: 'run a command', inputSchema: { type: 'object' } }],
    promptCaching: true,
    cacheTtl: '1h',
    assistantParticipant: 'Claude',
    ...overrides,
  } as NormalizedRequest;
}

function build(request: NormalizedRequest, messages: NormalizedMessage[], rebuild: boolean, membrane?: Membrane) {
  const m = membrane ?? new Membrane({ name: 'anthropic' } as any);
  return (m as any).buildNativeToolRequest(request, messages, rebuild);
}

/** Total cache_control instances across the whole wire request. */
function totalMarkers(pr: any): number {
  let n = 0;
  pr.messages.forEach((m: any) =>
    (Array.isArray(m.content) ? m.content : []).forEach((b: any) => { if (b.cache_control) n++; }));
  if (Array.isArray(pr.tools)) pr.tools.forEach((t: any) => { if (t.cache_control) n++; });
  if (Array.isArray(pr.system)) pr.system.forEach((b: any) => { if (b.cache_control) n++; });
  return n;
}

/** [messageIndex, blockIndex] of every message-level cache_control, plus tools/system markers. */
function markers(pr: any): { messages: Array<[number, number]>; onTools: boolean; onSystem: boolean } {
  const msgs: Array<[number, number]> = [];
  pr.messages.forEach((m: any, mi: number) => {
    (Array.isArray(m.content) ? m.content : []).forEach((b: any, bi: number) => {
      if (b.cache_control) msgs.push([mi, bi]);
    });
  });
  const onTools = Array.isArray(pr.tools) && pr.tools.some((t: any) => t.cache_control);
  const onSystem = Array.isArray(pr.system) && pr.system.some((b: any) => b.cache_control);
  return { messages: msgs, onTools, onSystem };
}

const last = (pr: any) => pr.messages.length - 1;

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('floating cache marker', () => {
  it('does not float on the turn\'s first build', () => {
    const pr = build(makeRequest(), turn(1), false);
    // Only the strategy's kickoff marker; the round's suffix is unmarked.
    expect(markers(pr).messages).toEqual([[0, 0]]);
  });

  it('floats onto the newest message on a tool-loop rebuild', () => {
    const pr = build(makeRequest(), turn(1), true);
    const m = markers(pr);
    // Kickoff marker intact + float on the final tool_result envelope.
    expect(m.messages).toContainEqual([0, 0]);
    expect(m.messages).toContainEqual([last(pr), 0]);
    // Fallback stays suppressed: message markers exist.
    expect(m.onTools).toBe(false);
    expect(m.onSystem).toBe(false);
  });

  it('keeps the previous round\'s endpoint marked when budget allows', () => {
    const pr = build(makeRequest(), turn(2), true);
    const m = markers(pr);
    // kickoff + previous round's results envelope + newest envelope.
    expect(m.messages).toEqual([[0, 0], [last(pr) - 2, 0], [last(pr), 0]]);
  });

  it('never stacks a second marker on an already-marked final message', () => {
    const messages = turn(2);
    (messages[messages.length - 1] as any).cacheBreakpoint = true;
    const pr = build(makeRequest(), messages, true);
    const m = markers(pr);
    const onFinal = m.messages.filter(([mi]) => mi === last(pr));
    expect(onFinal).toHaveLength(1);
    // Budget not consumed by the dedupe: previous endpoint still floated.
    expect(m.messages).toContainEqual([last(pr) - 2, 0]);
  });

  it('withholds the float (with one warning) when upstream markers fill all 4 slots', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const messages = turn(3);
    // Mark every results envelope: 1 kickoff + 3 results = 4 upstream markers.
    for (const msg of messages) {
      if ((msg.content[0] as any).type === 'tool_result') (msg as any).cacheBreakpoint = true;
    }
    const membrane = new Membrane({ name: 'anthropic' } as any);
    const pr = build(makeRequest(), messages, true, membrane);
    expect(markers(pr).messages).toHaveLength(4);
    expect(warn).toHaveBeenCalledTimes(1);
    // Warn-once: a second rebuild does not warn again.
    build(makeRequest(), messages, true, membrane);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('warns again after the rate-limit interval instead of latching for the process lifetime', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValue(1_000_000);

    const messages = turn(3);
    for (const msg of messages) {
      if ((msg.content[0] as any).type === 'tool_result') (msg as any).cacheBreakpoint = true;
    }
    const membrane = new Membrane({ name: 'anthropic' } as any);

    build(makeRequest(), messages, true, membrane);
    build(makeRequest(), messages, true, membrane);
    expect(warn).toHaveBeenCalledTimes(1);

    // A long-lived Membrane must not go permanently quiet about an
    // over-budget wire: past the interval the condition reports again, and
    // says how many occurrences it swallowed meanwhile.
    clock.mockReturnValue(1_000_000 + 61_000);
    build(makeRequest(), messages, true, membrane);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[1]![0])).toContain('1 further occurrences suppressed');
  });

  it('floats from the residuum left after the tools/system fallback on markerless requests', () => {
    const pr = build(makeRequest(), turn(2, false), true);
    const m = markers(pr);
    // Fallback spent 2 (tools + system) → residuum 2 → newest + previous endpoint.
    expect(m.onTools).toBe(true);
    expect(m.onSystem).toBe(true);
    expect(m.messages).toEqual([[last(pr) - 2, 0], [last(pr), 0]]);
  });

  it('steps back off a trailing thinking block', () => {
    const messages = turn(1);
    messages.push({
      participant: 'Claude',
      content: [text('partial'), { type: 'thinking' as const, thinking: 'hmm', signature: 'sig' }],
    } as NormalizedMessage);
    const pr = build(makeRequest(), messages, true);
    const m = markers(pr);
    // Marker lands on the text block, not the thinking block.
    const finalMarks = m.messages.filter(([mi]) => mi === last(pr));
    expect(finalMarks).toHaveLength(1);
    const [, bi] = finalMarks[0]!;
    expect((pr.messages[last(pr)].content[bi] as any).type).toBe('text');
  });

  it('stands down entirely when the normalizer synthesized a [pending] tool_result', () => {
    // Trailing orphan tool_use → normalizer synthesizes its [pending]
    // result, whose bytes change when the real result lands.
    const messages = [user('go', true), assistantToolCall('t1')];
    const pr = build(makeRequest(), messages, true);
    // Only the kickoff marker; nothing floated at or past the synthetic.
    expect(markers(pr).messages).toEqual([[0, 0]]);
  });

  it('respects request-level opt-out', () => {
    const pr = build(makeRequest({ floatingCacheMarker: false }), turn(1), true);
    expect(markers(pr).messages).toEqual([[0, 0]]);
  });

  it('emits no cache_control at all when promptCaching is off', () => {
    const pr = build(makeRequest({ promptCaching: false }), turn(1), true);
    const m = markers(pr);
    expect(m.messages).toEqual([]);
    expect(m.onTools).toBe(false);
    expect(m.onSystem).toBe(false);
  });

  it('counts pre-marked system blocks against the residual budget (never exceeds 4 on the wire)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // System is a block array with one block already carrying cache_control —
    // invisible to the running message tally, but a real wire marker.
    const premarkedSystem = [
      { type: 'text', text: 'You are a test agent.', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'Addendum.' },
    ] as any;
    // 3 message markers + pre-marked system = 4 on the wire: no room to float.
    const full = turn(2);
    for (const msg of full) {
      if ((msg.content[0] as any).type === 'tool_result') (msg as any).cacheBreakpoint = true;
    }
    const prFull = build(makeRequest({ system: premarkedSystem }), full, true);
    expect(totalMarkers(prFull)).toBe(4);
    expect(warn).toHaveBeenCalledTimes(1);
    // 2 message markers + pre-marked system = 3: exactly one slot left — the
    // float takes the newest message and stops.
    const partial = turn(2);
    (partial[2] as any).cacheBreakpoint = true; // first round's results envelope
    const prPartial = build(makeRequest({ system: premarkedSystem }), partial, true);
    expect(totalMarkers(prPartial)).toBe(4);
    expect(markers(prPartial).messages).toContainEqual([last(prPartial), 0]);
  });

  it('counts an overlapping block-level + message-level marker once (one physical marker)', () => {
    // A stale block-level cache_control on the very block the message's
    // cacheBreakpoint lands on is ONE wire marker, not two. Two such
    // messages must leave residuum 2, not 0.
    const staleMarked = (t: string): NormalizedMessage => ({
      participant: 'User',
      content: [{ type: 'text', text: t, cache_control: { type: 'ephemeral' } } as any],
      cacheBreakpoint: true,
    });
    // Results envelope whose message-level breakpoint lands on a text block
    // that already carries stale cache_control — tool pairing stays intact.
    const overlapResults = (id: string): NormalizedMessage => ({
      participant: 'User',
      content: [
        { type: 'tool_result' as const, toolUseId: id, content: 'ok' },
        { type: 'text', text: 'operator note', cache_control: { type: 'ephemeral' } } as any,
      ],
      cacheBreakpoint: true,
    });
    const messages = [staleMarked('do the thing'),
      assistantToolCall('t1'), overlapResults('t1'),
      assistantToolCall('t2'), toolResults('t2')];
    // 2 physical wire markers (the old tally saw 4 and withheld everything).
    const pr = build(makeRequest(), messages, true);
    const m = markers(pr);
    // Float not withheld: newest message marked; previous endpoint already
    // carries its own marker (dedupe, no slot spent).
    expect(m.messages).toContainEqual([last(pr), 0]);
    expect(totalMarkers(pr)).toBeLessThanOrEqual(4);
  });

  it('floated markers carry the request cacheTtl', () => {
    const pr = build(makeRequest(), turn(1), true);
    const [mi, bi] = markers(pr).messages.find(([i]) => i === last(pr))!;
    expect((pr.messages[mi].content[bi] as any).cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });
});
