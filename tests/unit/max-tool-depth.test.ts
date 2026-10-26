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
    toolMode: 'xml',
  };
}

function scriptedToolCall(roundIndex: number): string {
  return (
    `preamble ${roundIndex}\n` +
    `<function_calls><invoke name="noop">` +
    `<parameter name="i">${roundIndex}</parameter>` +
    `</invoke></function_calls>`
  );
}

async function driveStream(
  membrane: Membrane,
  request: NormalizedRequest,
  options: { maxToolDepth?: number } = {},
): Promise<{
  toolRounds: number;
  terminalEvent: StreamEvent['type'];
  finalResponse?: { stopReason: string; rawAssistantText: string };
}> {
  const stream = membrane.streamYielding(request, options);
  let toolRounds = 0;
  let terminalEvent: StreamEvent['type'] = 'complete';
  let finalResponse: { stopReason: string; rawAssistantText: string } | undefined;

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
      if (event.type === 'complete') {
        const r = (event as { response: { stopReason: string; rawAssistantText: string } }).response;
        finalResponse = { stopReason: r.stopReason, rawAssistantText: r.rawAssistantText };
      }
      break;
    }
  }

  return { toolRounds, terminalEvent, finalResponse };
}

describe('streamYielding maxToolDepth', () => {
  it('is uncapped by default — runs all scripted tool rounds', async () => {
    const DEFAULT_RESUMPTION_CAP = 24;
    const SCRIPTED = DEFAULT_RESUMPTION_CAP + 1;
    const adapter = new MockAdapter({
      streamChunkDelayMs: 0,
      completeDelayMs: 0,
      responseQueue: [
        ...Array.from({ length: SCRIPTED }, (_, i) => scriptedToolCall(i + 1)),
        'done.',
      ],
    });
    const membrane = new Membrane(adapter);

    const { toolRounds, terminalEvent, finalResponse } = await driveStream(membrane, makeRequest());

    expect(toolRounds).toBe(SCRIPTED);
    expect(terminalEvent).toBe('complete');
    expect(finalResponse?.stopReason).toBe('end_turn');
    expect(finalResponse?.rawAssistantText).toContain('done.');
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

  it('honors an explicit maxToolDepth=10 (the legacy cap), running depths 0 through 10', async () => {
    const adapter = new MockAdapter({
      streamChunkDelayMs: 0,
      completeDelayMs: 0,
      responseQueue: Array.from({ length: 15 }, (_, i) => scriptedToolCall(i + 1)),
    });
    const membrane = new Membrane(adapter);

    const { toolRounds, terminalEvent } = await driveStream(
      membrane,
      makeRequest(),
      { maxToolDepth: 10 },
    );

    expect(toolRounds).toBe(11);
    expect(terminalEvent).toBe('complete');
  });

  it('honors a higher explicit maxToolDepth, running depths 0 through it', async () => {
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
        'I am done.',
      ],
    });
    const membrane = new Membrane(adapter);

    const { toolRounds, terminalEvent } = await driveStream(membrane, makeRequest());

    expect(toolRounds).toBe(2);
    expect(terminalEvent).toBe('complete');
  });
});
