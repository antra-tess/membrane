import { describe, it, expect } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import type {
  MembraneLogger,
  NormalizedRequest,
  NormalizedResponse,
  ToolDefinition,
} from '../../src/types/index.js';
import type {
  ProviderAdapter,
  ProviderRequest,
  ProviderRequestOptions,
  ProviderResponse,
  StreamCallbacks,
} from '../../src/types/provider.js';

const FUNCTION_CALLS_OPEN = '<' + 'function_calls>';

interface ScriptedTurn {
  text: string;
  stopReason: string;
  stopSequence?: string;
}

class ScriptedAdapter implements ProviderAdapter {
  readonly name = 'zz-scripted';

  private readonly turns: ScriptedTurn[];

  constructor(turns: ScriptedTurn[]) {
    this.turns = [...turns];
  }

  supportsModel(): boolean {
    return true;
  }

  private nextTurn(): ScriptedTurn {
    return this.turns.shift() ?? { text: 'zz done', stopReason: 'end_turn' };
  }

  private respond(request: ProviderRequest, turn: ScriptedTurn): ProviderResponse {
    return {
      content: [{ type: 'text', text: turn.text }],
      stopReason: turn.stopReason,
      stopSequence: turn.stopSequence,
      usage: { inputTokens: 1, outputTokens: 1 },
      model: request.model,
      rawRequest: request,
      raw: { scripted: true },
    };
  }

  async complete(request: ProviderRequest, options?: ProviderRequestOptions): Promise<ProviderResponse> {
    options?.onRequest?.(request);
    return this.respond(request, this.nextTurn());
  }

  async stream(
    request: ProviderRequest,
    callbacks: StreamCallbacks,
    options?: ProviderRequestOptions
  ): Promise<ProviderResponse> {
    options?.onRequest?.(request);
    const turn = this.nextTurn();
    callbacks.onChunk(turn.text);
    return this.respond(request, turn);
  }
}

class RecordingLogger implements MembraneLogger {
  readonly warnings: string[] = [];

  debug(): void {}
  info(): void {}
  warn(message: string): void {
    this.warnings.push(message);
  }
  error(): void {}
}

const slowTool: ToolDefinition = {
  name: 'zz_slow_tool',
  description: 'A tool used to force an XML tool round.',
  inputSchema: { type: 'object', properties: {} },
};

function makeRequest(): NormalizedRequest {
  return {
    toolMode: 'xml',
    messages: [{ participant: 'User', content: [{ type: 'text', text: 'go' }] }],
    config: { model: 'zz-test-model', maxTokens: 64 },
    tools: [slowTool],
  };
}

function makeMembrane(turns: ScriptedTurn[], logger: MembraneLogger): Membrane {
  return new Membrane(new ScriptedAdapter(turns), { logger });
}

async function streamOnce(membrane: Membrane): Promise<NormalizedResponse> {
  const response = await membrane.stream(makeRequest(), {
    onToolCalls: async () => [],
  });
  if (!('details' in response)) throw new Error('expected a completed response');
  return response;
}

describe('F3/K8 · a tool block left open by a length stop', () => {
  const truncatedTurn: ScriptedTurn = {
    text:
      'zz_bot: calling now\n' +
      `${FUNCTION_CALLS_OPEN}\n<invoke name="zz_slow_tool">\n<parameter name="fld1">partia`,
    stopReason: 'max_tokens',
  };

  it('flags the unclosed block on the response', async () => {
    const logger = new RecordingLogger();
    const response = await streamOnce(makeMembrane([truncatedTurn], logger));

    expect(response.details.stop.wasTruncated).toBe(true);
    expect(response.details.stop.unclosedToolBlock).toBe(true);
  });

  it('warns loudly rather than returning the half-block silently', async () => {
    const logger = new RecordingLogger();
    await streamOnce(makeMembrane([truncatedTurn], logger));

    expect(logger.warnings.some((w) => w.includes('unclosed'))).toBe(true);
  });

  it('does not flag a turn that closed its block', async () => {
    const logger = new RecordingLogger();
    const called: string[] = [];
    const response = await makeMembrane(
      [
        {
          text: `zz_bot: calling now\n${FUNCTION_CALLS_OPEN}\n<invoke name="zz_slow_tool">\n<parameter name="fld1">whole</parameter>\n</invoke>\n`,
          stopReason: 'stop_sequence',
          stopSequence: '</function_calls>',
        },
      ],
      logger
    ).stream(makeRequest(), {
      onToolCalls: async (calls) => {
        called.push(...calls.map((call) => call.name));
        return [];
      },
    });
    if (!('details' in response)) throw new Error('expected a completed response');

    expect(called).toEqual(['zz_slow_tool']);
    expect(response.details.stop.unclosedToolBlock).not.toBe(true);
    expect(logger.warnings).toEqual([]);
  });
});

describe('F8 · a function_calls block that parses to zero invokes', () => {
  it('warns when a block yields no calls', async () => {
    const logger = new RecordingLogger();
    const response = await streamOnce(
      makeMembrane(
        [
          {
            text: `zz_bot: here goes\n${FUNCTION_CALLS_OPEN}\n<invoke zz_no_name_attribute>\n</invoke>\n</function_calls>`,
            stopReason: 'stop_sequence',
            stopSequence: '</function_calls>',
          },
        ],
        logger
      )
    );

    expect(response.toolCalls).toEqual([]);
    expect(logger.warnings.some((w) => w.includes('zero tool calls'))).toBe(true);
  });
});
