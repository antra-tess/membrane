/**
 * Confirms the hypothesis from the data-miner postmortem:
 * `streamYielding` defaults `maxToolDepth = 10`. With a scripted model
 * that wants to keep calling tools, the stream emits at most 11 tool
 * rounds (depths 0..10), then emits `complete` regardless of model
 * intent. Bumping `maxToolDepth` raises the cap.
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

describe('streamYielding maxToolDepth cap', () => {
  it('caps tool rounds at 11 with the default maxToolDepth=10', async () => {
    const adapter = new MockAdapter({
      streamChunkDelayMs: 0,
      completeDelayMs: 0,
      // Queue 15 scripted tool-calling responses — more than the cap.
      // The mock will keep handing them out for as long as the loop asks.
      responseQueue: Array.from({ length: 15 }, (_, i) => scriptedToolCall(i + 1)),
    });
    const membrane = new Membrane(adapter);

    const { toolRounds, terminalEvent } = await driveStream(membrane, makeRequest());

    // 11 tool rounds happen (toolDepth iterates 0..10 inclusive)
    expect(toolRounds).toBe(11);
    expect(terminalEvent).toBe('complete');
  });

  it('respects a higher maxToolDepth', async () => {
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
