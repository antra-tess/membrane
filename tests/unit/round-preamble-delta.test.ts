/**
 * ToolContext.roundPreamble — per-round delta text in XML tool mode.
 *
 * Regression for the Evander 2026-08-08 scaffold-leak pyramid: consumers
 * persisting per-round assistant text used `preamble`, which is CUMULATIVE
 * in XML mode (the whole turn so far, including harness-injected
 * <function_results> XML). A 3-call turn therefore stored round-1's text 3×,
 * round-2's 2×, and re-persisted injected results as the agent's own words —
 * which the formatter then replayed to the model as scaffold-in-its-own-voice.
 *
 * `roundPreamble` must contain exactly THIS round's model-authored text:
 *   - never earlier rounds' text,
 *   - never injected <function_results> / result content,
 *   - never the assistant prefill document (the #40 class),
 * while `preamble` keeps its documented cumulative shape for compatibility.
 */

import { describe, it, expect } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { MockAdapter } from '../../src/providers/mock.js';
import type {
  NormalizedRequest,
  ToolResult,
  ToolDefinition,
  ToolContext,
} from '../../src/types/index.js';

const noopTool: ToolDefinition = {
  name: 'noop',
  description: 'A no-op tool used to force tool rounds.',
  inputSchema: { type: 'object', properties: {} },
};

const RESULT_MARKER = 'RESULT_MARKER_ok_7d1';

function makeRequest(): NormalizedRequest {
  return {
    messages: [
      { participant: 'User', content: [{ type: 'text', text: 'PREFILL_DOC_MARKER go' }] },
    ],
    config: { model: 'test-model', maxTokens: 1000 },
    tools: [noopTool],
  };
}

function scriptedRound(n: number): string {
  return (
    `ROUND_${n}_PROSE\n` +
    `<function_calls><invoke name="noop">` +
    `<parameter name="i">${n}</parameter>` +
    `</invoke></function_calls>`
  );
}

function makeAdapter(rounds: number): MockAdapter {
  return new MockAdapter({
    streamChunkDelayMs: 0,
    completeDelayMs: 0,
    responseQueue: [
      ...Array.from({ length: rounds }, (_, i) => scriptedRound(i + 1)),
      'done.',
    ],
  });
}

async function driveYielding(
  membrane: Membrane,
  request: NormalizedRequest,
): Promise<ToolContext[]> {
  const contexts: ToolContext[] = [];
  const stream = membrane.streamYielding(request, {});
  for await (const event of stream) {
    if (event.type === 'tool-calls') {
      contexts.push(event.context);
      const results: ToolResult[] = event.calls.map((c) => ({
        toolUseId: c.id,
        content: RESULT_MARKER,
        isError: false,
      }));
      stream.provideToolResults(results);
    } else if (event.type === 'complete' || event.type === 'aborted' || event.type === 'error') {
      break;
    }
  }
  return contexts;
}

async function driveCallback(
  membrane: Membrane,
  request: NormalizedRequest,
): Promise<ToolContext[]> {
  const contexts: ToolContext[] = [];
  await membrane.stream(request, {
    onToolCalls: async (calls, context) => {
      contexts.push(context);
      return calls.map((c) => ({
        toolUseId: c.id,
        content: RESULT_MARKER,
        isError: false,
      }));
    },
  });
  return contexts;
}

function assertDeltaShape(contexts: ToolContext[]) {
  expect(contexts).toHaveLength(3);

  for (let n = 1; n <= 3; n++) {
    const ctx = contexts[n - 1]!;
    const delta = ctx.roundPreamble;
    expect(delta, `round ${n} roundPreamble present`).toBeDefined();

    // This round's own prose, and only this round's.
    expect(delta).toContain(`ROUND_${n}_PROSE`);
    for (let m = 1; m <= 3; m++) {
      if (m !== n) {
        expect(delta, `round ${n} delta must not contain round ${m} text`).not.toContain(
          `ROUND_${m}_PROSE`,
        );
      }
    }

    // Never injected results, never the prefill document.
    expect(delta).not.toContain('<function_results');
    expect(delta).not.toContain(RESULT_MARKER);
    expect(delta).not.toContain('PREFILL_DOC_MARKER');
  }

  // The pyramid, quantified: across per-round deltas each round's text
  // appears exactly once…
  const allDeltas = contexts.map((c) => c.roundPreamble ?? '').join('\n');
  expect(allDeltas.split('ROUND_1_PROSE').length - 1).toBe(1);

  // …while the legacy cumulative field still repeats it (compatibility —
  // and the measured shape of the bug: r1 in rounds 1, 2 and 3 = 3 copies).
  const allPreambles = contexts.map((c) => c.preamble).join('\n');
  expect(allPreambles.split('ROUND_1_PROSE').length - 1).toBe(3);
  expect(contexts[2]!.preamble).toContain('ROUND_1_PROSE');
  expect(contexts[2]!.preamble).toContain('<function_results');
}

describe('ToolContext.roundPreamble (XML per-round delta)', () => {
  it('yielding path: delta contains exactly this round, no injected results, no prefill', async () => {
    const membrane = new Membrane(makeAdapter(3));
    const contexts = await driveYielding(membrane, makeRequest());
    assertDeltaShape(contexts);
  });

  it('callback path (streamWithXmlTools): same delta contract', async () => {
    const membrane = new Membrane(makeAdapter(3));
    const contexts = await driveCallback(membrane, makeRequest());
    assertDeltaShape(contexts);
  });

  it('single-round turn: delta equals the sliced preamble', async () => {
    const membrane = new Membrane(makeAdapter(1));
    const contexts = await driveYielding(membrane, makeRequest());
    expect(contexts).toHaveLength(1);
    expect(contexts[0]!.roundPreamble).toBe(contexts[0]!.preamble);
  });
});
