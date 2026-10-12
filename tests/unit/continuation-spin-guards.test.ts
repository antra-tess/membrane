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
  // Continuation/resumption is an XML-prefill mechanism; native is the
  // default tool mode now, so the XML path is an explicit opt-in.
  toolMode: 'xml',
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

describe('stall guard (consecutive no-progress resumptions)', () => {
  it('ends the spin with stopReason no_progress on stream()', async () => {
    const adapter = new ScriptedAdapter(ASH_SPIN);
    const logger = mockLogger();
    const membrane = new Membrane(adapter, { logger });
    const response = await membrane.stream(REQUEST, {});
    expect('stopReason' in response && response.stopReason).toBe('no_progress');
    // Round 1 + three consecutive stalled resumptions. Not 43. (A single
    // short repeated round is low progress, not proof of none — hence 3.)
    expect(adapter.streamCalls).toBe(4);
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
    expect(adapter.streamCalls).toBe(4);
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

  it('CONTROL: two short same-stop resumptions that then complete are not truncated', async () => {
    // The review's counterexample: repeated stop-sequence text inside a
    // legitimate argument can cause a couple of short resumptions on the
    // way to finishing. Two stalls stay under the threshold of three.
    const adapter = new ScriptedAdapter([
      { text: '<function_calls>\n<invoke name="foo">', stopReason: 'stop_sequence' },
      { text: 'x', stopReason: 'stop_sequence' },
      { text: 'y', stopReason: 'stop_sequence' },
      { text: 'and then the block resolves with a full stretch of real output', stopReason: 'end_turn' },
    ]);
    const membrane = new Membrane(adapter, { logger: mockLogger() });
    const response = await membrane.stream(REQUEST, {});
    expect('stopReason' in response && response.stopReason).toBe('end_turn');
    expect(adapter.streamCalls).toBe(4);
    // The stalled rounds' content survives — nothing was truncated.
    expect('rawAssistantText' in response && response.rawAssistantText).toContain('xy');
  });

  it('a progressing round resets the stall count', async () => {
    // stall, stall, progress, stall, stall, finish — never three in a row.
    const adapter = new ScriptedAdapter([
      { text: '<function_calls>\n<invoke name="foo">', stopReason: 'stop_sequence' },
      { text: 'a', stopReason: 'stop_sequence' },
      { text: 'b', stopReason: 'stop_sequence' },
      { text: 'a long progressing stretch that resets the stall counter here', stopReason: 'stop_sequence' },
      { text: 'c', stopReason: 'stop_sequence' },
      { text: 'd', stopReason: 'stop_sequence' },
      { text: 'closing out with another long natural stretch of output now', stopReason: 'end_turn' },
    ]);
    const membrane = new Membrane(adapter, { logger: mockLogger() });
    const response = await membrane.stream(REQUEST, {});
    expect('stopReason' in response && response.stopReason).toBe('end_turn');
    expect(adapter.streamCalls).toBe(7);
  });
});

describe('resumption round cap', () => {
  // Every round opens ANOTHER block with >16 chars of content: always
  // "progressing", always resuming — only the cap stops it.
  const EVER_DEEPER: ScriptedRound[] = [
    { text: '<function_calls>\n<invoke name="round-content-padding">', stopReason: 'stop_sequence' },
  ];

  it('bounds resumptions independently of maxToolDepth, with a truthful reason', async () => {
    const adapter = new ScriptedAdapter(EVER_DEEPER);
    const logger = mockLogger();
    const membrane = new Membrane(adapter, { logger });
    const response = await membrane.stream(REQUEST, { maxResumptionRounds: 2, maxToolDepth: 50 });
    // These rounds progressed — 'no_progress' would be a lie; the cap says
    // what actually happened.
    expect('stopReason' in response && response.stopReason).toBe('round_limit');
    // Initial round + 2 permitted resumptions; the 3rd registration trips the cap.
    expect(adapter.streamCalls).toBe(3);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('resumption cap'));
  });

  it('bounds the yielding path without touching its uncapped tool-loop contract', async () => {
    const adapter = new ScriptedAdapter(EVER_DEEPER);
    const membrane = new Membrane(adapter, { logger: mockLogger() });
    const stream = membrane.streamYielding(REQUEST, { maxResumptionRounds: 3 });
    let finalStopReason: string | undefined;
    for await (const event of stream) {
      if (event.type === 'complete') {
        finalStopReason = (event as { response: { stopReason: string } }).response.stopReason;
      }
    }
    expect(finalStopReason).toBe('round_limit');
    expect(adapter.streamCalls).toBe(4);
  });
});

describe('tool rounds are not resumptions', () => {
  it('a long legitimate tool chain runs past the resumption cap untouched', async () => {
    const TOOL_ROUNDS = 30; // well past the default resumption cap of 24
    const script: ScriptedRound[] = [
      ...Array.from({ length: TOOL_ROUNDS }, (_, i) => ({
        text: `<function_calls>\n<invoke name="step"><parameter name="n">${i}</parameter></invoke>\n`,
        stopReason: 'stop_sequence',
        stopSequence: '</function_calls>',
      })),
      { text: 'done after the full chain of real tool work.', stopReason: 'end_turn' },
    ];
    const adapter = new ScriptedAdapter(script);
    const logger = mockLogger();
    const membrane = new Membrane(adapter, { logger });
    let toolRounds = 0;
    const response = await membrane.stream(REQUEST, {
      maxToolDepth: 50,
      onToolCalls: async (calls) => {
        toolRounds++;
        return calls.map((c) => ({ toolUseId: c.id, content: 'ok', isError: false }));
      },
    });
    // The final provider round streamed and the turn ended naturally:
    // no cap, no stall, no mislabeled 'no_progress' on real work.
    expect('stopReason' in response && response.stopReason).toBe('end_turn');
    expect('rawAssistantText' in response && response.rawAssistantText).toContain('done after the full chain');
    expect(toolRounds).toBe(TOOL_ROUNDS);
    expect(adapter.streamCalls).toBe(TOOL_ROUNDS + 1);
    // And no spin telemetry fired for it.
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('round telemetry', () => {
  it('warns once when resumptions reach the visibility threshold', async () => {
    const adapter = new ScriptedAdapter([
      { text: '<function_calls>\n<invoke name="keeps-on-opening-blocks">', stopReason: 'stop_sequence' },
    ]);
    const logger = mockLogger();
    const membrane = new Membrane(adapter, { logger });
    await membrane.stream(REQUEST, { maxResumptionRounds: 7 });
    const roundWarnings = logger.warn.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('at round 5'),
    );
    expect(roundWarnings.length).toBe(1);
  });
});
