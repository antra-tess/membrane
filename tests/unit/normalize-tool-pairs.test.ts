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

  describe('#10 — first message is assistant: hard fail', () => {
    it('throws MembraneNormalizerError', () => {
      const input: ProviderMessage[] = [
        assistant(t('I greet first')),
        user(t('hi')),
      ];
      expect(() => normalize(input)).toThrow(MembraneNormalizerError);
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

  describe('cache-control suppression', () => {
    it('strips cache_control from blocks at-or-after a synthetic envelope', () => {
      const cached = (block: ProviderBlock): ProviderBlock => ({
        ...block,
        cache_control: { type: 'ephemeral' },
      });
      const input: ProviderMessage[] = [
        user(t('q')),
        assistant(u('A')),
        // No matching result for A → will synthesize at envelope index 2.
        user(cached(t('this would be a cache breakpoint'))),
        assistant(t('continuing')),
      ];
      const { events, onEvent } = collectEvents();
      const out = normalize(input, { onEvent });

      // The synthetic was inserted in the user envelope at index 2.
      // After phase 5.5, no block at index >= 2 should carry cache_control.
      for (let i = 2; i < out.messages.length; i++) {
        for (const block of out.messages[i]!.content) {
          expect(block).not.toHaveProperty('cache_control');
        }
      }
      expect(events.some((e) => e.kind === 'cache_suppressed_for_synthetic')).toBe(true);
    });

    it('leaves cache_control alone when no synthetic was needed', () => {
      const cached = (block: ProviderBlock): ProviderBlock => ({
        ...block,
        cache_control: { type: 'ephemeral' },
      });
      const input: ProviderMessage[] = [
        user(cached(t('cache me'))),
        assistant(t('ok')),
      ];
      const { events, onEvent } = collectEvents();
      const out = normalize(input, { onEvent });

      const firstBlock = out.messages[0]!.content[0]! as ProviderBlock & { cache_control?: unknown };
      expect(firstBlock.cache_control).toBeDefined();
      expect(events.some((e) => e.kind === 'cache_suppressed_for_synthetic')).toBe(false);
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
});
