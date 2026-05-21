/**
 * Coverage for `streamYielding`'s `maxToolDepth` option:
 *   - by default the yielding paths are uncapped (the agent framework
 *     budgets its own work);
 *   - an explicit non-negative cap is honored;
 *   - `-1` is accepted as an "unlimited" sentinel;
 *   - the stream still terminates naturally when the model emits no tool.
 *
 * Background: the original data-miner postmortem traced a stalled agent
 * to the prior default of 10 tool rounds. This test pins the new default
 * and keeps the cap mechanic itself tested for callers that still want it.
 */

import { describe, it, expect } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { MockAdapter } from '../../src/providers/mock.js';
import type {
  NormalizedRequest,
  StreamEvent,
  ToolResult,
  ToolDefinition,
} from '../../src/types/index.js';

const noopTool: ToolDefinition = {
  name: 'noop',
  description: 'A no-op tool used to force tool rounds.',
  inputSchema: { type: 'object', properties: {} },
};

function makeRequest(): NormalizedRequest {
  return {
    messages: [
      { participant: 'User', content: [{ type: 'text', text: 'go' }] },
    ],
    config: { model: 'test-model', maxTokens: 1000 },
    tools: [noopTool],
  };
}

/**
 * Scripted response: a preamble text + one XML tool call.
 * The XML form is what AnthropicXmlFormatter (default for MockAdapter)
 * extracts as a tool round.
 */
function scriptedToolCall(roundIndex: number): string {
  return (
    `preamble ${roundIndex}\n` +
    `<function_calls><invoke name="noop">` +
    `<parameter name="i">${roundIndex}</parameter>` +
    `</invoke></function_calls>`
  );
}

/**
 * Drive the stream end-to-end, auto-answering every tool round with a
 * dummy success result. Returns counts and the terminal event.
 */
async function driveStream(
  membrane: Membrane,
  request: NormalizedRequest,
  options: { maxToolDepth?: number } = {},
): Promise<{ toolRounds: number; terminalEvent: StreamEvent['type'] }> {
  const stream = membrane.streamYielding(request, options);
  let toolRounds = 0;
  let terminalEvent: StreamEvent['type'] = 'complete';

  for await (const event of stream) {
    if (event.type === 'tool-calls') {
      toolRounds++;
      const results: ToolResult[] = event.calls.map((c) => ({
        toolUseId: c.id,
        content: 'ok',
        isError: false,
      }));
      stream.provideToolResults(results);
    } else if (event.type === 'complete' || event.type === 'aborted' || event.type === 'error') {
      terminalEvent = event.type;
      break;
    }
  }

  return { toolRounds, terminalEvent };
}

describe('streamYielding maxToolDepth', () => {
  it('is uncapped by default — runs all scripted tool rounds', async () => {
    const SCRIPTED = 25;
    const adapter = new MockAdapter({
      streamChunkDelayMs: 0,
      completeDelayMs: 0,
      responseQueue: [
        ...Array.from({ length: SCRIPTED }, (_, i) => scriptedToolCall(i + 1)),
        // Final plain-text response so the stream terminates naturally
        // once the scripted tool rounds are exhausted.
        'done.',
      ],
    });
    const membrane = new Membrane(adapter);

    const { toolRounds, terminalEvent } = await driveStream(membrane, makeRequest());

    expect(toolRounds).toBe(SCRIPTED);
    expect(terminalEvent).toBe('complete');
  });

  it('accepts -1 as an explicit "unlimited" sentinel', async () => {
    const SCRIPTED = 25;
    const adapter = new MockAdapter({
      streamChunkDelayMs: 0,
      completeDelayMs: 0,
      responseQueue: [
        ...Array.from({ length: SCRIPTED }, (_, i) => scriptedToolCall(i + 1)),
        'done.',
      ],
    });
    const membrane = new Membrane(adapter);

    const { toolRounds, terminalEvent } = await driveStream(
      membrane,
      makeRequest(),
      { maxToolDepth: -1 },
    );

    expect(toolRounds).toBe(SCRIPTED);
    expect(terminalEvent).toBe('complete');
  });

  it('does NOT treat other negative values as unlimited (-1 is the only sentinel)', async () => {
    // Pre-fix, `< 0` accepted -2, -99, etc. as unlimited. That silently
    // masked computation errors (e.g. `userCap - N` going negative). Now
    // anything other than -1 is taken at face value as the cap, which
    // makes the failure loud — zero tool rounds, stream terminates.
    const adapter = new MockAdapter({
      streamChunkDelayMs: 0,
      completeDelayMs: 0,
      responseQueue: Array.from({ length: 5 }, (_, i) => scriptedToolCall(i + 1)),
    });
    const membrane = new Membrane(adapter);

    const { toolRounds, terminalEvent } = await driveStream(
      membrane,
      makeRequest(),
      { maxToolDepth: -2 },
    );

    expect(toolRounds).toBe(0);
    expect(terminalEvent).toBe('complete');
  });

  it('honors an explicit maxToolDepth=10 (the legacy cap)', async () => {
    const adapter = new MockAdapter({
      streamChunkDelayMs: 0,
      completeDelayMs: 0,
      // Queue 15 scripted tool-calling responses — more than the cap.
      responseQueue: Array.from({ length: 15 }, (_, i) => scriptedToolCall(i + 1)),
    });
    const membrane = new Membrane(adapter);

    const { toolRounds, terminalEvent } = await driveStream(
      membrane,
      makeRequest(),
      { maxToolDepth: 10 },
    );

    // 11 tool rounds happen (toolDepth iterates 0..10 inclusive)
    expect(toolRounds).toBe(11);
    expect(terminalEvent).toBe('complete');
  });

  it('honors a higher explicit maxToolDepth', async () => {
    const adapter = new MockAdapter({
      streamChunkDelayMs: 0,
      completeDelayMs: 0,
      responseQueue: Array.from({ length: 25 }, (_, i) => scriptedToolCall(i + 1)),
    });
    const membrane = new Membrane(adapter);

    const { toolRounds, terminalEvent } = await driveStream(
      membrane,
      makeRequest(),
      { maxToolDepth: 20 },
    );

    // With maxToolDepth=20, the loop allows depths 0..20 → 21 tool rounds.
    expect(toolRounds).toBe(21);
    expect(terminalEvent).toBe('complete');
  });

  it('stops early when the model emits no tool call', async () => {
    const adapter = new MockAdapter({
      streamChunkDelayMs: 0,
      completeDelayMs: 0,
      responseQueue: [
        scriptedToolCall(1),
        scriptedToolCall(2),
        // Plain text response — no tool call. Stream should terminate.
        'I am done.',
      ],
    });
    const membrane = new Membrane(adapter);

    const { toolRounds, terminalEvent } = await driveStream(membrane, makeRequest());

    expect(toolRounds).toBe(2);
    expect(terminalEvent).toBe('complete');
  });
});
