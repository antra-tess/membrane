/** A provider stream can stop on 'stop_sequence' with the stopSequence field missing. */

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
  toolMode: 'xml',
};

function mockLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const ASH_SPIN: ScriptedRound[] = [
  { text: '<function_calls>\n<invoke name="foo">', stopReason: 'stop_sequence' },
  { text: 'x', stopReason: 'stop_sequence' },
];

describe('stall guard (consecutive no-progress resumptions)', () => {
  const STALLED_RESUMPTIONS_THAT_END_A_SPIN = 3;
  const warnedOfTheTrip = (logger: ReturnType<typeof mockLogger>) => logger.warn.mock.calls.some(([line]) =>
    String(line).includes('no_progress') && new RegExp(`\\b${STALLED_RESUMPTIONS_THAT_END_A_SPIN}\\b`).test(String(line)));

  it('ends the spin with stopReason no_progress on stream()', async () => {
    const adapter = new ScriptedAdapter(ASH_SPIN);
    const logger = mockLogger();
    const membrane = new Membrane(adapter, { logger });
    const response = await membrane.stream(REQUEST, {});
    expect('stopReason' in response && response.stopReason).toBe('no_progress');
    expect(adapter.streamCalls).toBe(1 + STALLED_RESUMPTIONS_THAT_END_A_SPIN);
    expect(warnedOfTheTrip(logger)).toBe(true);
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
    expect(adapter.streamCalls).toBe(1 + STALLED_RESUMPTIONS_THAT_END_A_SPIN);
    expect(warnedOfTheTrip(logger)).toBe(true);
  });

  it('does not fire while rounds are making progress inside a function_calls block left unclosed', async () => {
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
    expect('rawAssistantText' in response && response.rawAssistantText).toContain('xy');
  });

  it('a progressing round resets the stall count', async () => {
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
  const EVER_DEEPER: ScriptedRound[] = [
    { text: '<function_calls>\n<invoke name="round-content-padding">', stopReason: 'stop_sequence' },
  ];

  it('bounds resumptions independently of maxToolDepth, with a truthful reason', async () => {
    const adapter = new ScriptedAdapter(EVER_DEEPER);
    const logger = mockLogger();
    const membrane = new Membrane(adapter, { logger });
    const response = await membrane.stream(REQUEST, { maxResumptionRounds: 2, maxToolDepth: 50 });
    expect('stopReason' in response && response.stopReason).toBe('round_limit');
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
    const DEFAULT_RESUMPTION_CAP = 24;
    const TOOL_ROUNDS = DEFAULT_RESUMPTION_CAP + 6;
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
    expect('stopReason' in response && response.stopReason).toBe('end_turn');
    expect('rawAssistantText' in response && response.rawAssistantText).toContain('done after the full chain');
    expect(toolRounds).toBe(TOOL_ROUNDS);
    expect(adapter.streamCalls).toBe(TOOL_ROUNDS + 1);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('round telemetry', () => {
  it.each(['stream', 'yielding'] as const)('warns once at resumption round 5 on %s, naming the round and the input tokens spent so far', async (path) => {
    const adapter = new ScriptedAdapter([
      { text: '<function_calls>\n<invoke name="keeps-on-opening-blocks">', stopReason: 'stop_sequence' },
    ]);
    const logger = mockLogger();
    const membrane = new Membrane(adapter, { logger });
    if (path === 'stream') await membrane.stream(REQUEST, { maxResumptionRounds: 7 });
    else for await (const _event of membrane.streamYielding(REQUEST, { maxResumptionRounds: 7 })) void _event;
    const callsBeforeRound5 = 5;
    const atRound5 = logger.warn.mock.calls.map((c) => String(c[0])).filter((line) => /\bround 5\b/.test(line));
    expect(atRound5).toHaveLength(1);
    expect(atRound5[0]).toMatch(new RegExp(`\\b${callsBeforeRound5 * 100}\\b`));
  });
});
