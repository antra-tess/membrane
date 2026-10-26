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
    toolMode: 'xml',
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

const ROUNDS = 3;

function assertDeltaShape(contexts: ToolContext[]) {
  expect(contexts).toHaveLength(ROUNDS);

  for (let n = 1; n <= ROUNDS; n++) {
    const ctx = contexts[n - 1]!;
    const delta = ctx.roundPreamble;
    expect(delta, `round ${n} roundPreamble present`).toBeDefined();

    expect(delta).toContain(`ROUND_${n}_PROSE`);
    for (let m = 1; m <= ROUNDS; m++) {
      if (m !== n) {
        expect(delta, `round ${n} delta must not contain round ${m} text`).not.toContain(
          `ROUND_${m}_PROSE`,
        );
      }
    }

    expect(delta).not.toContain('<function_results');
    expect(delta).not.toContain(RESULT_MARKER);
    expect(delta).not.toContain('PREFILL_DOC_MARKER');
  }

  const allDeltas = contexts.map((c) => c.roundPreamble ?? '').join('\n');
  expect(allDeltas.split('ROUND_1_PROSE').length - 1).toBe(1);

  const allPreambles = contexts.map((c) => c.preamble).join('\n');
  expect(allPreambles.split('ROUND_1_PROSE').length - 1).toBe(ROUNDS);
  expect(contexts[2]!.preamble).toContain('ROUND_1_PROSE');
  expect(contexts[2]!.preamble).toContain('<function_results');
}

describe('ToolContext.roundPreamble (XML per-round delta)', () => {
  it('yielding path: delta contains exactly this round, no injected results, no prefill', async () => {
    const membrane = new Membrane(makeAdapter(ROUNDS));
    const contexts = await driveYielding(membrane, makeRequest());
    assertDeltaShape(contexts);
  });

  it('callback path (streamWithXmlTools): same delta contract', async () => {
    const membrane = new Membrane(makeAdapter(ROUNDS));
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
