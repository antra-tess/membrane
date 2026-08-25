/**
 * Regression matrix for `normalizeToolPairs`.
 *
 * Each test in this file corresponds to one row of the matrix in
 * `membrane/docs/normalize-tool-pairs-plan.md` § "Regression test matrix".
 *
 * The normalizer is Membrane's wire-boundary safety net for Anthropic's
 * tool-cycle structural rules. The bug family this guards against:
 *   - 2026-05-22 miner stall (postmortem)
 *   - agent-framework issue #37
 *   - compression-bug 5/6/7/8/9
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeToolPairs,
  mergeConsecutiveRoles,
  MembraneNormalizerError,
  type ProviderBlock,
} from '../../src/formatters/normalize-tool-pairs.js';
import type { NormalizeEvent } from '../../src/formatters/types.js';

// Test-local strict alias. The public `ProviderMessage` in
// `src/formatters/types.ts` has `content: unknown` so the formatter
// pipeline can carry arbitrary provider-shaped blocks without
// committing to a runtime schema. Within these tests we always
// construct ProviderBlock arrays, so a stricter alias keeps the
// assertions readable without spreading `as ProviderBlock[]` everywhere.
type ProviderMessage = { role: 'user' | 'assistant'; content: ProviderBlock[] };

// ============================================================================
// Helpers (mirror the shorthand used in context-manager tests)
// ============================================================================

const t = (text: string): ProviderBlock => ({ type: 'text', text });
const u = (id: string, name = 'fn'): ProviderBlock => ({
  type: 'tool_use',
  id,
  name,
  input: {},
});
const r = (id: string, content = 'ok'): ProviderBlock => ({
  type: 'tool_result',
  tool_use_id: id,
  content,
  is_error: false,
});
const think = (text = 'thinking'): ProviderBlock => ({ type: 'thinking', thinking: text });

function user(...content: ProviderBlock[]): ProviderMessage {
  return { role: 'user', content };
}
function assistant(...content: ProviderBlock[]): ProviderMessage {
  return { role: 'assistant', content };
}

function collectEvents(): { events: NormalizeEvent[]; onEvent: (e: NormalizeEvent) => void } {
  const events: NormalizeEvent[] = [];
  return { events, onEvent: (e) => events.push(e) };
}

function resultIds(content: ProviderBlock[]): string[] {
  return content
    .filter((b) => b.type === 'tool_result')
    .map((b) => (b as ProviderBlock & { tool_use_id: string }).tool_use_id);
}

function useIds(content: ProviderBlock[]): string[] {
  return content
    .filter((b) => b.type === 'tool_use')
    .map((b) => (b as ProviderBlock & { id: string }).id);
}

/**
 * Wrap normalizeToolPairs so tests see the strict ProviderMessage
 * shape on the result side. The public boundary returns the loose
 * type from `./types.js` (content: unknown), which is correct for
 * production but verbose to assert against — every test would
 * otherwise need to cast `out.messages[i].content` before reading
 * blocks. This wrapper is the one place the strict-vs-loose
 * bridge lives.
 */
function normalize(
  input: ProviderMessage[],
  options?: Parameters<typeof normalizeToolPairs>[1],
): { messages: ProviderMessage[]; ready: boolean } {
  const out = normalizeToolPairs(input, options);
  return out as { messages: ProviderMessage[]; ready: boolean };
}

function blockTypes(msg: ProviderMessage): string[] {
  return msg.content.map((b) => b.type);
}

// ============================================================================
// Tests
// ============================================================================

describe('normalizeToolPairs', () => {
  describe('#1 — the smoking gun (postmortem 35-block user envelope)', () => {
    it('splits a single user-roled mega-message into alternating valid envelopes', () => {
      // Exact pattern from the postmortem (counts match: 4t, 3u, 3r, 5t, 7u, 7r, 1t, 2u, 2r, 1t).
      const blocks: ProviderBlock[] = [
        t('a'), t('b'), t('c'), t('d'),
        u('U0'), u('U1'), u('U2'),
        r('U0'), r('U1'), r('U2'),
        t('e'), t('f'), t('g'), t('h'), t('i'),
        u('U3'), u('U4'), u('U5'), u('U6'), u('U7'), u('U8'), u('U9'),
        r('U3'), r('U4'), r('U5'), r('U6'), r('U7'), r('U8'), r('U9'),
        t('j'),
        u('U10'), u('U11'),
        r('U10'), r('U11'),
        t('k'),
      ];
      const { events, onEvent } = collectEvents();
      const out = normalize([user(...blocks)], { onEvent });

      // Should produce alternating user/assistant envelopes, every
      // tool_use immediately followed by a user envelope containing
      // matching tool_results.
      expect(out.ready).toBe(true);
      const roles = out.messages.map((m) => m.role);
      // Must start with user, must end legally, must alternate.
      expect(roles[0]).toBe('user');
      for (let i = 1; i < roles.length; i++) {
        expect(roles[i]).not.toBe(roles[i - 1]);
      }
      // For every assistant envelope with tool_use, the next user
      // envelope must contain matching tool_results.
      for (let i = 0; i < out.messages.length; i++) {
        const msg = out.messages[i]!;
        if (msg.role !== 'assistant') continue;
        const ids = useIds(msg.content);
        if (ids.length === 0) continue;
        const next = out.messages[i + 1];
        expect(next).toBeDefined();
        expect(next!.role).toBe('user');
        for (const id of ids) {
          expect(resultIds(next!.content)).toContain(id);
        }
      }
      // Only the 12 tool_use blocks are role-misplaced (they were in a
      // user-roled message, must be assistant). The 12 tool_results were
      // already in a user-roled message — they just had wrong-role
      // siblings; phase 1+2 splits them out without re-roling.
      const reRoled = events.filter((e) => e.kind === 'block_re_roled');
      expect(reRoled.length).toBe(12);
    });
  });

  describe('#2 — interloper between tool_use and tool_result', () => {
    it('defers the interloper after the matching tool_result (never drops)', () => {
      // A mid-cycle user event must survive normalization — losing it
      // would mean the agent permanently forgets a message that did
      // happen. Deferring it past the tool_result is fine; the
      // summarizer can handle slight temporal reordering, but cannot
      // reconstruct a discarded message.
      const input: ProviderMessage[] = [
        user(t('hi')),
        assistant(u('A')),
        user(t('mid-cycle event')),
        user(r('A')),
      ];
      const { events, onEvent } = collectEvents();
      const out = normalize(input, { onEvent });

      // The two user envelopes will be re-tagged correctly during
      // phase 2 walking; phase 3 will hoist the r(A). The interloper
      // should land AFTER r(A) within the user envelope, not before.
      const assistantIdx = out.messages.findIndex((m) => m.role === 'assistant');
      expect(assistantIdx).toBeGreaterThanOrEqual(0);
      const after = out.messages[assistantIdx + 1];
      expect(after).toBeDefined();
      expect(after!.role).toBe('user');
      expect(after!.content[0]!.type).toBe('tool_result');
      // The mid-cycle event must still be present somewhere in the
      // output, after the tool_result.
      const seen = out.messages.flatMap((m) =>
        m.content.map((b) => (b as { text?: string }).text ?? ''),
      );
      expect(seen.some((s) => s.includes('mid-cycle event'))).toBe(true);
      // At least one deferred event should have been emitted.
      expect(events.some((e) => e.kind === 'interloper_deferred')).toBe(true);
    });
  });

  describe('#3 — partial result (one of two tool_uses unmatched)', () => {
    it('injects a synthetic [pending] for the missing id', () => {
      const input: ProviderMessage[] = [
        user(t('go')),
        assistant(u('A'), u('B')),
        user(r('B')),
      ];
      const { events, onEvent } = collectEvents();
      const out = normalize(input, { onEvent });

      // The user envelope following the assistant must contain BOTH r(A) and r(B).
      const assistantIdx = out.messages.findIndex((m) => m.role === 'assistant');
      const after = out.messages[assistantIdx + 1]!;
      expect(resultIds(after.content).sort()).toEqual(['A', 'B']);
      const aResult = after.content.find(
        (b) => b.type === 'tool_result' && (b as ProviderBlock & { tool_use_id?: string }).tool_use_id === 'A',
      ) as { content: string; is_error: boolean } | undefined;
      expect(aResult?.content).toBe('[pending]');
      expect(aResult?.is_error).toBe(false);
      expect(events.some(
        (e) => e.kind === 'synthetic_pending_result' && e.toolUseId === 'A',
      )).toBe(true);
    });
  });

  describe('#4 — in-flight: pending id signals not-ready', () => {
    it('returns ready=false and does NOT synthesize when id is pending', () => {
      const input: ProviderMessage[] = [
        user(t('go')),
        assistant(u('A')),
      ];
      const { events, onEvent } = collectEvents();
      const out = normalize(input, {
        pendingToolCallIds: new Set(['A']),
        onEvent,
      });

      expect(out.ready).toBe(false);
      // No synthetic in the messages.
      expect(out.messages.some((m) => resultIds(m.content).includes('A'))).toBe(false);
      // pending_in_flight event fired.
      expect(events.some(
        (e) => e.kind === 'pending_in_flight' && e.toolUseId === 'A',
      )).toBe(true);
      // No synthetic_pending_result emitted for this id.
      expect(events.some(
        (e) => e.kind === 'synthetic_pending_result' && e.toolUseId === 'A',
      )).toBe(false);
    });
  });

  describe('#5 — abandoned: trailing tool_use without pending status', () => {
    it('synthesizes [pending] result at a new trailing user envelope', () => {
      const input: ProviderMessage[] = [
        user(t('go')),
        assistant(u('A')),
      ];
      const { events, onEvent } = collectEvents();
      const out = normalize(input, { onEvent });

      expect(out.ready).toBe(true);
      const last = out.messages[out.messages.length - 1]!;
      expect(last.role).toBe('user');
      expect(resultIds(last.content)).toEqual(['A']);
      const ev = events.find(
        (e) => e.kind === 'synthetic_pending_result',
      ) as { kind: string; toolUseId: string; reason: string } | undefined;
      expect(ev?.reason).toBe('trailing');
    });
  });

  describe('#6 — orphan tool_result with no preceding tool_use', () => {
    it('textifies the orphan and fires telemetry', () => {
      const input: ProviderMessage[] = [
        user(r('GHOST', 'something')),
        assistant(t('ok')),
      ];
      const { events, onEvent } = collectEvents();
      const out = normalize(input, { onEvent });

      // The orphan should be turned into a text block somewhere in
      // the user envelope.
      const firstUser = out.messages.find((m) => m.role === 'user')!;
      const hasOrphanText = firstUser.content.some(
        (b) => b.type === 'text' && /orphan tool_result/.test((b as ProviderBlock & { text?: string }).text ?? ''),
      );
      expect(hasOrphanText).toBe(true);
      expect(events.some((e) => e.kind === 'orphan_tool_result_textified')).toBe(true);
    });
  });

  describe('#7 — well-formed input passes through unchanged', () => {
    it('no events, no role changes, no synthetics', () => {
      const input: ProviderMessage[] = [
        user(t('hello')),
        assistant(think('reasoning'), t('here you go'), u('A')),
        user(r('A')),
        assistant(t('done')),
      ];
      const { events, onEvent } = collectEvents();
      const out = normalize(input, { onEvent });

      expect(out.ready).toBe(true);
      expect(out.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
      expect(blockTypes(out.messages[1]!)).toEqual(['thinking', 'text', 'tool_use']);
      expect(blockTypes(out.messages[2]!)).toEqual(['tool_result']);
      expect(events).toEqual([]);
    });
  });

  describe('#8 — misplaced thinking block (users do not think)', () => {
    it('moves thinking to a new assistant envelope before the user text', () => {
      const input: ProviderMessage[] = [
        user(think('user is thinking???'), t('hello')),
        assistant(t('hi')),
      ];
      const { events, onEvent } = collectEvents();
      const out = normalize(input, { onEvent });

      // The thinking block must end up on the assistant side.
      const assistantEnvs = out.messages.filter((m) => m.role === 'assistant');
      expect(assistantEnvs.some((m) => blockTypes(m).includes('thinking'))).toBe(true);
      expect(events.some(
        (e) => e.kind === 'block_re_roled' && e.blockType === 'thinking',
      )).toBe(true);
    });
  });

  describe('#9 — adjacent assistant envelopes with bundled results downstream', () => {
    it('hoists each tool_result to immediately follow its tool_use', () => {
      const input: ProviderMessage[] = [
        user(t('q')),
        assistant(u('A')),
        user(t('mid')),
        assistant(u('B')),
        user(r('A'), r('B')),
      ];
      const out = normalize(input);

      // Each tool_use should be followed by a user envelope containing
      // ITS specific tool_result.
      for (let i = 0; i < out.messages.length; i++) {
        const msg = out.messages[i]!;
        if (msg.role !== 'assistant') continue;
        const ids = useIds(msg.content);
        if (ids.length === 0) continue;
        const next = out.messages[i + 1];
        expect(next).toBeDefined();
        expect(next!.role).toBe('user');
        for (const id of ids) {
          expect(resultIds(next!.content)).toContain(id);
        }
      }
    });
  });

  describe('#10 — first message is assistant: synthesize [continuing] + warn', () => {
    it('prepends a user envelope and fires leading_user_synthesized with originalFirstRole=assistant', () => {
      const input: ProviderMessage[] = [
        assistant(t('I greet first')),
        user(t('hi')),
      ];
      const { events, onEvent } = collectEvents();
      const out = normalize(input, { onEvent });

      // First envelope must now be user-role with the [continuing] literal.
      expect(out.messages[0]!.role).toBe('user');
      expect(out.messages[0]!.content).toHaveLength(1);
      const firstBlock = out.messages[0]!.content[0]!;
      expect(firstBlock.type).toBe('text');
      expect((firstBlock as ProviderBlock & { text: string }).text).toBe('[continuing]');

      // Original assistant envelope is preserved at index 1 (no content loss).
      expect(out.messages[1]!.role).toBe('assistant');
      expect((out.messages[1]!.content[0]! as ProviderBlock & { text: string }).text).toBe(
        'I greet first',
      );

      // Telemetry distinguishes producer-bug from re-roling.
      const ev = events.find((e) => e.kind === 'leading_user_synthesized');
      expect(ev).toBeDefined();
      expect(ev).toMatchObject({
        kind: 'leading_user_synthesized',
        originalFirstRole: 'assistant',
        leadingBlockTypes: ['text'],
      });
    });

    it('is idempotent: re-running on the output is a no-op for this gate', () => {
      const input: ProviderMessage[] = [
        assistant(t('I greet first')),
        user(t('hi')),
      ];
      const first = normalize(input);
      const { events, onEvent } = collectEvents();
      const second = normalize(first.messages, { onEvent });

      expect(second.messages).toEqual(first.messages);
      expect(events.some((e) => e.kind === 'leading_user_synthesized')).toBe(false);
    });
  });

  describe('#10b — re-roled leading assistant (thinking block under user)', () => {
    it('synthesizes [continuing] with originalFirstRole=user (preserves re-roled content)', () => {
      // A producer ships a user-role message whose only content is a
      // thinking block. rebuildEnvelopes moves it to a new assistant
      // envelope, leaving the input's first envelope effectively
      // assistant-roled. Repair must engage AND must not drop the
      // thinking block.
      const input: ProviderMessage[] = [
        user(think('user is thinking???')),
        assistant(t('hi')),
      ];
      const { events, onEvent } = collectEvents();
      const out = normalize(input, { onEvent });

      expect(out.messages[0]!.role).toBe('user');
      expect((out.messages[0]!.content[0]! as ProviderBlock & { text: string }).text).toBe(
        '[continuing]',
      );

      // The thinking block survives on the assistant side.
      const assistantEnvs = out.messages.filter((m) => m.role === 'assistant');
      expect(assistantEnvs.some((m) => blockTypes(m).includes('thinking'))).toBe(true);

      const ev = events.find((e) => e.kind === 'leading_user_synthesized');
      expect(ev).toBeDefined();
      expect(ev).toMatchObject({
        kind: 'leading_user_synthesized',
        originalFirstRole: 'user',
      });
      expect((ev as { leadingBlockTypes: string[] }).leadingBlockTypes).toContain('thinking');
    });
  });

  describe('#10c — producer-bug case from 2026-05-26 reviewer postmortem', () => {
    it('repairs a passthrough-style assistant-first cut without dropping tool cycles', () => {
      // Mirrors the reviewer-recipe failure: PassthroughStrategy.selectFromEnd
      // cut on an assistant turn that opens a tool_use cycle. The leading
      // envelope has [text, tool_use], followed by a user envelope with
      // the matching tool_result. Repair must prepend [continuing] AND
      // leave the tool_use → tool_result pair intact.
      const input: ProviderMessage[] = [
        assistant(t('Now I have all the material I need...'), u('A')),
        user(r('A')),
        assistant(t('Now let me check...'), u('B')),
        user(r('B')),
      ];
      const { events, onEvent } = collectEvents();
      const out = normalize(input, { onEvent });

      // Synthetic prepended.
      expect(out.messages[0]!.role).toBe('user');
      expect((out.messages[0]!.content[0]! as ProviderBlock & { text: string }).text).toBe(
        '[continuing]',
      );

      // Original tool cycles preserved in order.
      expect(out.messages[1]!.role).toBe('assistant');
      expect(useIds(out.messages[1]!.content)).toEqual(['A']);
      expect(out.messages[2]!.role).toBe('user');
      expect(resultIds(out.messages[2]!.content)).toEqual(['A']);
      expect(out.messages[3]!.role).toBe('assistant');
      expect(useIds(out.messages[3]!.content)).toEqual(['B']);
      expect(out.messages[4]!.role).toBe('user');
      expect(resultIds(out.messages[4]!.content)).toEqual(['B']);

      // No spurious orphan synthesis — the pairs were well-formed,
      // just shifted by the leading-edge cut.
      expect(events.some((e) => e.kind === 'synthetic_pending_result')).toBe(false);
      expect(events.some((e) => e.kind === 'orphan_tool_result_textified')).toBe(false);

      // Telemetry classes this as a producer bug.
      const ev = events.find((e) => e.kind === 'leading_user_synthesized') as
        | { originalFirstRole: string }
        | undefined;
      expect(ev?.originalFirstRole).toBe('assistant');
    });
  });

  describe('#11 — mid-stream unmatched tool_use', () => {
    it('synthesizes [pending] result in the immediately-following user envelope', () => {
      const input: ProviderMessage[] = [
        user(t('q')),
        assistant(u('A')),
        user(t('forward-going text after orphan tool_use')),
        assistant(t('continuing')),
      ];
      const { events, onEvent } = collectEvents();
      const out = normalize(input, { onEvent });

      // A synthetic should have been inserted; since there's a next
      // assistant envelope after the user envelope, the synthesis is
      // 'mid_stream' (not trailing).
      const ev = events.find((e) => e.kind === 'synthetic_pending_result') as
        | { kind: string; reason: string }
        | undefined;
      expect(ev).toBeDefined();
      // Either trailing OR mid_stream is acceptable here depending on
      // exact placement; the important thing is that synthesis happened.
      expect(['trailing', 'mid_stream']).toContain(ev!.reason);
      // The synthetic must precede the next assistant envelope.
      const assistantIdx = out.messages.findIndex((m) => m.role === 'assistant');
      const after = out.messages[assistantIdx + 1]!;
      expect(resultIds(after.content)).toContain('A');
    });
  });

  describe('cache markers survive stranded-call synthesis (F17)', () => {
    const cached = (block: ProviderBlock): ProviderBlock => ({
      ...block,
      cache_control: { type: 'ephemeral' },
    });

    it('keeps cache_control at and after a synthetic-bearing envelope', () => {
      // The strip's premise was that synthetic bytes get rewritten when the
      // real result lands. Phase 5 only ever synthesizes for an id the caller
      // did NOT declare pending — i.e. a stranded call — and its `[pending]`
      // payload is a fixed literal reproduced identically on every later
      // compile. Nothing invalidates, so nothing needed protecting, and the
      // strip cost the whole remaining conversation's prompt cache for as
      // long as the stranded tool_use stayed in the window.
      const input: ProviderMessage[] = [
        user(t('go')),
        assistant(u('ite1')),
        user(cached(t('this is a cache breakpoint'))),
        assistant(t('continuing')),
      ];
      const out = normalize(input);

      const surviving = out.messages
        .flatMap((m) => m.content)
        .filter((b) => 'cache_control' in b);
      expect(surviving).toHaveLength(1);
    });

    it('emits no cache-suppression telemetry', () => {
      const input: ProviderMessage[] = [
        user(t('go')),
        assistant(u('ite1')),
        user(cached(t('this is a cache breakpoint'))),
        assistant(t('continuing')),
      ];
      const { events, onEvent } = collectEvents();
      normalize(input, { onEvent });

      expect(events.map((e) => e.kind)).not.toContain('cache_suppressed_for_synthetic');
      expect(events.some((e) => e.kind === 'synthetic_pending_result')).toBe(true);
    });

    it('the synthetic payload is byte-stable across compiles', () => {
      // The property the strip was defending against the absence of.
      const input: ProviderMessage[] = [
        user(t('go')),
        assistant(u('ite1')),
        user(cached(t('this is a cache breakpoint'))),
        assistant(t('continuing')),
      ];
      const first = normalize(input);
      const second = normalize(input);

      expect(JSON.stringify(first.messages)).toBe(JSON.stringify(second.messages));
    });

    it('leaves cache_control alone when no synthetic was needed', () => {
      const input: ProviderMessage[] = [
        user(cached(t('cache me'))),
        assistant(t('ok')),
      ];
      const out = normalize(input);

      const firstBlock = out.messages[0]!.content[0]! as ProviderBlock & { cache_control?: unknown };
      expect(firstBlock.cache_control).toBeDefined();
    });
  });

  describe('empty input', () => {
    it('returns empty messages and ready=true', () => {
      const out = normalize([]);
      expect(out.messages).toEqual([]);
      expect(out.ready).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Coverage-gap tests flagged in PR #22 QA — these guard the narrow checks
  // in validate() and the synthetic write format.
  // --------------------------------------------------------------------------

  describe('validate: pending exemption is narrow', () => {
    it('still synthesizes (and validates) non-pending unmatched ids when one id is pending', () => {
      // A is pending — must NOT be synthesized; ready=false expected.
      // B is NOT pending — phase 5 must synthesize it. Validate's
      // pending-exemption must NOT cover B; if a hypothetical phase-5
      // bug failed to synthesize B, validate must still throw.
      const input: ProviderMessage[] = [
        user(t('go')),
        assistant(u('A'), u('B')),
        // No following user envelope: A trailing+pending, B trailing+abandoned.
      ];
      const { events, onEvent } = collectEvents();
      const out = normalize(input, {
        pendingToolCallIds: new Set(['A']),
        onEvent,
      });

      expect(out.ready).toBe(false);
      // B must have been synthesized despite A being pending.
      const userEnvWithResults = out.messages.find((m) => m.role === 'user' && resultIds(m.content).length > 0);
      expect(userEnvWithResults).toBeDefined();
      expect(resultIds(userEnvWithResults!.content)).toContain('B');
      expect(resultIds(userEnvWithResults!.content)).not.toContain('A');
      // pending_in_flight for A; synthetic_pending_result for B.
      expect(events.some((e) => e.kind === 'pending_in_flight' && e.toolUseId === 'A')).toBe(true);
      expect(events.some((e) => e.kind === 'synthetic_pending_result' && e.toolUseId === 'B')).toBe(true);
    });
  });

  describe('synthetic result canonical field names', () => {
    it('writes tool_use_id (snake_case) — never toolUseId (camelCase)', () => {
      // Anthropic API requires snake_case on the wire. The dual-form
      // read in getToolUseId is defensive against producers, but
      // synthetics are produced *by* this module and must lock down
      // to the canonical form so a "drive-by camelCase fix" can't
      // regress us silently.
      const input: ProviderMessage[] = [
        user(t('go')),
        assistant(u('A')),
      ];
      const out = normalize(input);
      // Find the synthetic tool_result.
      const userWithSynth = out.messages.find(
        (m) => m.role === 'user' && m.content.some((b) => b.type === 'tool_result'),
      );
      const synth = userWithSynth!.content.find((b) => b.type === 'tool_result') as Record<string, unknown>;
      expect(synth).toBeDefined();
      expect(synth.tool_use_id).toBe('A');
      expect(synth).not.toHaveProperty('toolUseId');
      expect(synth.content).toBe('[pending]');
      expect(synth.is_error).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // A synthetic [pending] belongs at its own tool_use's position (F18).
  // --------------------------------------------------------------------------

  describe('synthetic placement follows call order (F18)', () => {
    it('inserts the synthetic after the real result of an earlier call', () => {
      // Two calls in one turn; the SECOND is unmatched. Unshifting the
      // synthetic to position 0 put call #2's [pending] ahead of call #1's
      // real result — wire-valid, but the model reads results in an order
      // that does not match the order it made the calls.
      const input: ProviderMessage[] = [
        user(t('go')),
        assistant(u('ite1'), u('ite2')),
        user(r('ite1', 'zz-first landed')),
      ];
      const out = normalize(input);

      const cycle = out.messages[2]!;
      expect(resultIds(cycle.content)).toEqual(['ite1', 'ite2']);
    });

    it('still fronts the synthetic when the unmatched call came first', () => {
      const input: ProviderMessage[] = [
        user(t('go')),
        assistant(u('ite1'), u('ite2')),
        user(r('ite2', 'zz-second landed')),
      ];
      const out = normalize(input);

      const cycle = out.messages[2]!;
      expect(resultIds(cycle.content)).toEqual(['ite1', 'ite2']);
    });

    it('orders three synthetics among two landed results by call order', () => {
      const input: ProviderMessage[] = [
        user(t('go')),
        assistant(u('ite1'), u('ite2'), u('ite3'), u('ite4'), u('ite5')),
        user(r('ite2', 'zz-two landed'), r('ite4', 'zz-four landed')),
      ];
      const out = normalize(input);

      const cycle = out.messages[2]!;
      expect(resultIds(cycle.content)).toEqual(['ite1', 'ite2', 'ite3', 'ite4', 'ite5']);
    });
  });

  // --------------------------------------------------------------------------
  // A re-roled thinking block must never be welded into an assistant envelope
  // that already holds a tool_use (F7). rebuildEnvelopes opened a new envelope
  // on ROLE change only, so a thinking block under a user message landed in
  // the PREVIOUS assistant turn — signature and all — after its tool_use.
  // --------------------------------------------------------------------------

  describe('re-roled thinking is never welded after a tool_use (F7)', () => {
    const signedThinking = (signature: string): ProviderBlock => ({
      type: 'thinking',
      thinking: 'zz-reasoning',
      signature,
    });
    const redactedThinking = (data: string): ProviderBlock => ({
      type: 'redacted_thinking',
      data,
    });

    // Both reasoning variants, spelled out. `startsWith('thinking')` — the
    // shape the guard itself once used — silently excludes
    // `redacted_thinking`, so a detector written that way cannot see the
    // very weld this block is here to forbid.
    const isReasoningType = (type: string): boolean =>
      type === 'thinking' || type === 'redacted_thinking';

    /** Assistant envelopes holding a reasoning block positioned after a tool_use. */
    function weldedEnvelopes(messages: ProviderMessage[]): number[] {
      const welded: number[] = [];
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i]!;
        if (msg.role !== 'assistant') continue;
        const types = blockTypes(msg);
        const firstUse = types.indexOf('tool_use');
        if (firstUse < 0) continue;
        if (types.slice(firstUse).some(isReasoningType)) welded.push(i);
      }
      return welded;
    }

    it('opens a fresh envelope rather than appending past the previous turn tool_use', () => {
      const input: ProviderMessage[] = [
        user(t('go')),
        assistant(signedThinking('zz-sig-1'), u('ite1')),
        user(signedThinking('zz-sig-2'), r('ite1')),
      ];
      const out = normalize(input);

      expect(weldedEnvelopes(out.messages)).toEqual([]);

      // The second signature must not have moved into the first turn.
      const firstToolTurn = out.messages.find(
        (m) => m.role === 'assistant' && useIds(m.content).includes('ite1'),
      )!;
      const signatures = firstToolTurn.content.map(
        (b) => (b as ProviderBlock & { signature?: string }).signature,
      );
      expect(signatures).not.toContain('zz-sig-2');

      // ...and must not be lost either.
      const allSignatures = out.messages
        .flatMap((m) => m.content)
        .map((b) => (b as ProviderBlock & { signature?: string }).signature)
        .filter(Boolean);
      expect(allSignatures).toContain('zz-sig-2');
    });

    it('opens a fresh envelope for a re-roled redacted_thinking too', () => {
      // The guard tested above keyed on `block.type.startsWith('thinking')`,
      // which is false for `redacted_thinking` — the one reasoning variant
      // whose payload is opaque, so a misattributed one cannot even be read
      // back out of the transcript. Both strict reasoning variants must
      // break the envelope.
      const input: ProviderMessage[] = [
        user(t('go')),
        assistant(signedThinking('zz-sig-1'), u('ite1')),
        user(redactedThinking('zz-enc-2'), r('ite1')),
      ];
      const out = normalize(input);

      expect(weldedEnvelopes(out.messages)).toEqual([]);

      const firstToolTurn = out.messages.find(
        (m) => m.role === 'assistant' && useIds(m.content).includes('ite1'),
      )!;
      expect(blockTypes(firstToolTurn)).not.toContain('redacted_thinking');

      // Opaque payload preserved, not dropped in the course of moving it.
      const allData = out.messages
        .flatMap((m) => m.content)
        .map((b) => (b as ProviderBlock & { data?: string }).data)
        .filter(Boolean);
      expect(allData).toContain('zz-enc-2');
    });

    it('survives mergeConsecutiveRoles for redacted_thinking as well', () => {
      const input: ProviderMessage[] = [
        user(t('go')),
        assistant(signedThinking('zz-sig-1'), u('ite1')),
        user(redactedThinking('zz-enc-2'), r('ite1')),
      ];
      const merged = mergeConsecutiveRoles(normalize(input).messages) as ProviderMessage[];

      expect(weldedEnvelopes(merged)).toEqual([]);
    });

    it('survives mergeConsecutiveRoles, which every callsite runs next', () => {
      // A fresh envelope is only a repair if the merge that follows
      // normalization at every wire boundary does not concatenate it straight
      // back onto the tool_use turn.
      const input: ProviderMessage[] = [
        user(t('go')),
        assistant(signedThinking('zz-sig-1'), u('ite1')),
        user(signedThinking('zz-sig-2'), r('ite1')),
      ];
      const merged = mergeConsecutiveRoles(normalize(input).messages) as ProviderMessage[];

      expect(weldedEnvelopes(merged)).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // Orphan textification must not destroy structured content (F1).
  // --------------------------------------------------------------------------

  describe('orphan textification preserves array-form content (F1)', () => {
    const arrayResult = (id: string): ProviderBlock => ({
      type: 'tool_result',
      tool_use_id: id,
      content: [
        { type: 'text', text: 'zz-screenshot of the failing chart' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'zzzz'.repeat(512) },
        },
      ],
      is_error: false,
    });

    function orphanText(out: { messages: ProviderMessage[] }): string {
      for (const msg of out.messages) {
        for (const block of msg.content) {
          const text = (block as ProviderBlock & { text?: string }).text ?? '';
          if (block.type === 'text' && text.startsWith('[orphan tool_result')) return text;
        }
      }
      throw new Error('no orphan textification found in output');
    }

    it('flattens text parts and image placeholders instead of emptying the payload', () => {
      // `ToolResult.content` is `string | ToolResultContentBlock[]` and the
      // array form is a first-class feature (tool-result-images). The old
      // recovery was `typeof inner === 'string' ? inner : ''`, so every
      // array-shaped orphan was replaced by the empty string, silently.
      const input: ProviderMessage[] = [user(arrayResult('ite1')), assistant(t('ok'))];
      const out = normalize(input);

      const text = orphanText(out);
      expect(text).toContain('zz-screenshot of the failing chart');
      expect(text).toContain('[Image:');
      expect(text).toContain('image/png');
    });

    it('reports the recovered length on the event so a drop can never be silent', () => {
      const input: ProviderMessage[] = [user(arrayResult('ite1')), assistant(t('ok'))];
      const { events, onEvent } = collectEvents();
      normalize(input, { onEvent });

      const ev = events.find((e) => e.kind === 'orphan_tool_result_textified') as
        | { toolUseId: string; recoveredChars: number }
        | undefined;
      expect(ev).toBeDefined();
      expect(ev!.toolUseId).toBe('ite1');
      expect(ev!.recoveredChars).toBeGreaterThan('zz-screenshot of the failing chart'.length);
    });

    it('keeps the string-content path intact (control)', () => {
      const input: ProviderMessage[] = [
        user(r('ite2', 'zz-plain string payload')),
        assistant(t('ok')),
      ];
      const { events, onEvent } = collectEvents();
      const out = normalize(input, { onEvent });

      expect(orphanText(out)).toContain('zz-plain string payload');
      const ev = events.find((e) => e.kind === 'orphan_tool_result_textified') as
        | { recoveredChars: number }
        | undefined;
      expect(ev!.recoveredChars).toBe('zz-plain string payload'.length);
    });
  });

  // --------------------------------------------------------------------------
  // The pairing invariant runs in BOTH directions (F2). Every tool_result must
  // have its tool_use in the immediately-preceding assistant envelope — the
  // converse of the rule phases 3 and 5 already enforce forward.
  // --------------------------------------------------------------------------

  describe('converse pairing sweep (F2)', () => {
    /** The invariant phases 3/5/validate never checked: result → preceding use. */
    function converseViolations(messages: ProviderMessage[]): string[] {
      const violations: string[] = [];
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i]!;
        if (msg.role !== 'user') continue;
        for (const id of resultIds(msg.content)) {
          const prev = messages[i - 1];
          const paired = prev?.role === 'assistant' && useIds(prev.content).includes(id);
          if (!paired) violations.push(`msg[${i}] tool_result id=${id} unpaired in msg[${i - 1}]`);
        }
      }
      return violations;
    }

    it('shape A — out-of-order append: relocates the result to its own cycle', () => {
      const input: ProviderMessage[] = [
        user(t('go')),
        assistant(u('ite1')),
        user(r('ite2', 'zz-second payload')),
        assistant(u('ite2')),
        user(r('ite1', 'zz-first payload')),
      ];
      const { events, onEvent } = collectEvents();
      const out = normalize(input, { onEvent });

      expect(converseViolations(out.messages)).toEqual([]);
      // Relocation, not textification: the real payload must survive as a
      // tool_result, and no fake [pending] should be synthesized for ite2.
      const allResults = out.messages.flatMap((m) => m.content).filter((b) => b.type === 'tool_result');
      const contents = allResults.map((b) => (b as ProviderBlock & { content?: unknown }).content);
      expect(contents).toContain('zz-second payload');
      expect(contents).toContain('zz-first payload');
      expect(events.some((e) => e.kind === 'synthetic_pending_result')).toBe(false);
    });

    it('shape B — leading result: pairs it with its downstream tool_use', () => {
      const input: ProviderMessage[] = [
        user(r('ite1', 'zz-leading payload')),
        assistant(u('ite1')),
        assistant(t('done')),
      ];
      const out = normalize(input);

      expect(converseViolations(out.messages)).toEqual([]);
      const contents = out.messages
        .flatMap((m) => m.content)
        .filter((b) => b.type === 'tool_result')
        .map((b) => (b as ProviderBlock & { content?: unknown }).content);
      expect(contents).toContain('zz-leading payload');
    });

    it('shape C — duplicate result re-appended after a later turn: textified, not dropped', () => {
      // The module's own doc names cancellations and stream restarts as
      // normal triggers for this shape.
      const input: ProviderMessage[] = [
        user(t('go')),
        assistant(u('ite1')),
        user(r('ite1', 'zz-real payload')),
        assistant(t('thinking about it')),
        user(r('ite1', 'zz-duplicate payload')),
      ];
      const { events, onEvent } = collectEvents();
      const out = normalize(input, { onEvent });

      expect(converseViolations(out.messages)).toEqual([]);
      // Content preserved as text — never silently discarded.
      const allText = out.messages
        .flatMap((m) => m.content)
        .map((b) => (b as ProviderBlock & { text?: string }).text ?? '')
        .join('\n');
      expect(allText).toContain('zz-duplicate payload');
      expect(events.some((e) => e.kind === 'stray_tool_result_textified')).toBe(true);
    });

    it('validate mirrors the assertion: a stray that survived every phase throws', () => {
      // Guards the repair itself. If a future phase reintroduces an unpaired
      // tool_result, validate must fail loudly rather than ship a 400.
      const input: ProviderMessage[] = [
        user(t('go')),
        assistant(u('ite1')),
        user(r('ite1')),
      ];
      expect(() => normalize(input)).not.toThrow();
      expect(converseViolations(normalize(input).messages)).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // Entry guards. A producer defect must refuse BEFORE any phase rebuilds
  // envelopes, so the failure is typed, early, and independent of whether the
  // input happened to need repair. (Review findings F14, F15a, F16.)
  // --------------------------------------------------------------------------

  describe('entry guard — pendingToolCallIds must be set-like (F16)', () => {
    it('refuses an array even when the transcript needs no repair', () => {
      // The sharp part of the original bug: `.has()` is only reached for an
      // unmatched tool_use, so an array sailed through every well-formed
      // transcript and threw mid-pipeline, untyped, the first time the net
      // was actually load-bearing. This input is well-formed on purpose.
      const input: ProviderMessage[] = [
        user(t('go')),
        assistant(u('ite1')),
        user(r('ite1')),
      ];

      expect(() =>
        normalizeToolPairs(input, {
          // Deliberate contract violation: a Set cannot survive a JSON
          // round-trip, so config-driven callers reach for an array.
          pendingToolCallIds: ['ite1'] as unknown as ReadonlySet<string>,
        }),
      ).toThrow(MembraneNormalizerError);
    });

    it('names the option and the received shape in the refusal', () => {
      const input: ProviderMessage[] = [user(t('go'))];
      let caught: unknown;
      try {
        normalizeToolPairs(input, {
          pendingToolCallIds: ['ite1', 'ite2'] as unknown as ReadonlySet<string>,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(MembraneNormalizerError);
      expect((caught as Error).message).toContain('pendingToolCallIds');
      expect((caught as Error).message).toContain('Array(2)');
    });

    it('accepts a real Set and still refuses no repair-free transcript', () => {
      const input: ProviderMessage[] = [
        user(t('go')),
        assistant(u('ite1')),
        user(r('ite1')),
      ];
      const out = normalize(input, { pendingToolCallIds: new Set(['ite1']) });
      expect(out.ready).toBe(true);
    });
  });

  describe('entry guard — duplicate tool_use ids (F14)', () => {
    it('refuses a transcript that reuses one tool_use id across two cycles', () => {
      // Hoisting takes the FIRST id match with no notion of which cycle it
      // belongs to, so the real result of cycle 2 gets reattributed to the
      // tool_use of cycle 1 and cycle 2 gets a [pending]. Wire-valid,
      // silently wrong: always a producer defect.
      const input: ProviderMessage[] = [
        user(t('go')),
        assistant(u('ite1')),
        user(r('ite1', 'first landed')),
        assistant(u('ite1')),
        user(r('ite1', 'second landed')),
      ];

      expect(() => normalize(input)).toThrow(MembraneNormalizerError);
    });

    it('names the duplicated id in the refusal', () => {
      const input: ProviderMessage[] = [
        user(t('go')),
        assistant(u('ite7'), u('ite7')),
      ];
      let caught: unknown;
      try {
        normalize(input);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(MembraneNormalizerError);
      expect((caught as Error).message).toContain('ite7');
    });

    it('leaves distinct ids alone', () => {
      const input: ProviderMessage[] = [
        user(t('go')),
        assistant(u('ite1')),
        user(r('ite1')),
        assistant(u('ite2')),
        user(r('ite2')),
      ];
      expect(normalize(input).ready).toBe(true);
    });
  });

  describe('entry guard — message content shape (F15a)', () => {
    it('refuses object-shaped content instead of writing "[object Object]" to the wire', () => {
      const input = [
        { role: 'user', content: { zz_not_a_block_array: true } },
      ] as unknown as ProviderMessage[];

      expect(() => normalize(input)).toThrow(MembraneNormalizerError);
    });

    it('still accepts plain-string content as a single text block', () => {
      const input = [
        { role: 'user', content: 'plain string turn' },
      ] as unknown as ProviderMessage[];

      const out = normalize(input);
      expect(out.messages[0]!.content).toEqual([{ type: 'text', text: 'plain string turn' }]);
    });
  });
});
