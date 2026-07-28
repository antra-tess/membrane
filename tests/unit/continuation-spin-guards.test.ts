/**
 * Continuation spin guards (issue #39): no-progress abort, continuation
 * round cap, and round telemetry. Reproduces the Ash 2026-07-26 shape —
 * a stream that stops on 'stop_sequence' with the stopSequence field
 * missing, inside a model-opened block, making ~1 char of progress per
 * round — and asserts the turn now ends with stopReason 'no_progress'
 * instead of re-sending the full context forever.
 */

import { describe, it, expect, vi } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import type { NormalizedRequest } from '../../src/types/index.js';
import type {
  ProviderAdapter,
  ProviderRequest,
  ProviderRequestOptions,
  ProviderResponse,
} from '../../src/types/provider.js';
import type { StreamCallbacks } from '../../src/types/streaming.js';

interface ScriptedRound {
  text: string;
  stopReason: string;
  stopSequence?: string;
}

/** Plays back a fixed script of stream rounds; repeats the last round if
 *  the loop asks for more than scripted (that's the spin). */
class ScriptedAdapter implements ProviderAdapter {
  readonly name = 'scripted';
  streamCalls = 0;
  constructor(private script: ScriptedRound[]) {}

  supportsModel(): boolean {
    return true;
  }

  async complete(): Promise<ProviderResponse> {
    throw new Error('not used in these tests');
  }

  async stream(
    request: ProviderRequest,
    callbacks: StreamCallbacks,
    _options?: ProviderRequestOptions,
  ): Promise<ProviderResponse> {
    const round = this.script[Math.min(this.streamCalls, this.script.length - 1)]!;
    this.streamCalls++;
    callbacks.onChunk(round.text);
    return {
      content: [{ type: 'text', text: round.text }],
      stopReason: round.stopReason,
      stopSequence: round.stopSequence,
      usage: { inputTokens: 100, outputTokens: 5 },
      model: request.model,
      rawRequest: request,
      raw: {},
    };
  }
}

const REQUEST: NormalizedRequest = {
  messages: [{ participant: 'User', content: [{ type: 'text', text: 'hi' }] }],
  config: { model: 'test', maxTokens: 100 },
};

function mockLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

// The Ash shape: round 1 opens a block and stops on a stop sequence the
// adapter failed to report; every later round streams ~1 char and stops
// identically. Without guards this loops until something external stops it.
const ASH_SPIN: ScriptedRound[] = [
  { text: '<function_calls>\n<invoke name="foo">', stopReason: 'stop_sequence' },
  { text: 'x', stopReason: 'stop_sequence' },
];

describe('no-progress guard', () => {
  it('ends the spin with stopReason no_progress on stream()', async () => {
    const adapter = new ScriptedAdapter(ASH_SPIN);
    const logger = mockLogger();
    const membrane = new Membrane(adapter, { logger });
    const response = await membrane.stream(REQUEST, {});
    expect('stopReason' in response && response.stopReason).toBe('no_progress');
    // Round 1 + one continuation that made no progress. Not 43.
    expect(adapter.streamCalls).toBe(2);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('no progress'));
  });

  it('ends the spin on the yielding path too (where Ash actually ran)', async () => {
    const adapter = new ScriptedAdapter(ASH_SPIN);
    const logger = mockLogger();
    const membrane = new Membrane(adapter, { logger });
    const stream = membrane.streamYielding(REQUEST);
    let finalStopReason: string | undefined;
    for await (const event of stream) {
      if (event.type === 'complete') {
        finalStopReason = (event as { response: { stopReason: string } }).response.stopReason;
      }
    }
    expect(finalStopReason).toBe('no_progress');
    expect(adapter.streamCalls).toBe(2);
  });

  it('does not fire while rounds are making progress', async () => {
    // Progressing rounds inside a model-opened block, then a natural finish.
    // (No </function_calls> in the text — that would engage the real
    // tool-stop machinery and, amusingly, re-create the exact spin shape
    // this suite exists to kill.)
    const adapter = new ScriptedAdapter([
      { text: '<function_calls>\n<invoke name="foo">', stopReason: 'stop_sequence' },
      { text: 'a real paragraph of continued output, well past the threshold', stopReason: 'stop_sequence' },
      { text: 'and another long stretch of output before finishing naturally', stopReason: 'end_turn' },
    ]);
    const membrane = new Membrane(adapter, { logger: mockLogger() });
    const response = await membrane.stream(REQUEST, {});
    expect('stopReason' in response && response.stopReason).toBe('end_turn');
    expect(adapter.streamCalls).toBe(3);
  });
});

describe('continuation round cap', () => {
  // Every round opens ANOTHER block with >16 chars of content: always
  // "progressing", always resuming — only the cap stops it.
  const EVER_DEEPER: ScriptedRound[] = [
    { text: '<function_calls>\n<invoke name="round-content-padding">', stopReason: 'stop_sequence' },
  ];

  it('bounds rounds independently of maxToolDepth', async () => {
    const adapter = new ScriptedAdapter(EVER_DEEPER);
    const logger = mockLogger();
    const membrane = new Membrane(adapter, { logger });
    const response = await membrane.stream(REQUEST, { maxContinuationRounds: 2, maxToolDepth: 50 });
    expect('stopReason' in response && response.stopReason).toBe('no_progress');
    // Initial round + 2 permitted continuations; the 3rd registration trips the cap.
    expect(adapter.streamCalls).toBe(3);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('round cap'));
  });

  it('bounds the yielding path even though its tool depth is unlimited by design', async () => {
    const adapter = new ScriptedAdapter(EVER_DEEPER);
    const membrane = new Membrane(adapter, { logger: mockLogger() });
    const stream = membrane.streamYielding(REQUEST, { maxContinuationRounds: 3 });
    let finalStopReason: string | undefined;
    for await (const event of stream) {
      if (event.type === 'complete') {
        finalStopReason = (event as { response: { stopReason: string } }).response.stopReason;
      }
    }
    expect(finalStopReason).toBe('no_progress');
    expect(adapter.streamCalls).toBe(4);
  });
});

describe('round telemetry', () => {
  it('warns once when rounds reach the visibility threshold', async () => {
    const adapter = new ScriptedAdapter([
      { text: '<function_calls>\n<invoke name="keeps-on-opening-blocks">', stopReason: 'stop_sequence' },
    ]);
    const logger = mockLogger();
    const membrane = new Membrane(adapter, { logger });
    await membrane.stream(REQUEST, { maxContinuationRounds: 7 });
    const roundWarnings = logger.warn.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('at round 5'),
    );
    expect(roundWarnings.length).toBe(1);
  });
});
